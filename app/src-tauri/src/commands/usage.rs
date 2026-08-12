use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const HEADER: [&str; 7] = [
    "timestamp",
    "provider",
    "cost",
    "input",
    "output",
    "cache_read",
    "cache_write",
];
const MAX_EXPORT_BYTES: usize = 8 * 1024 * 1024;
const MAX_EXPORT_ROWS: usize = 100_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageExportErrorCode {
    InvalidRequest,
    InvalidCsv,
    UnsafeCell,
    TooLarge,
    UnsafeDestination,
    Io,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageExportError {
    code: UsageExportErrorCode,
    message: String,
}

impl UsageExportError {
    fn new(code: UsageExportErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub const fn code(&self) -> UsageExportErrorCode {
        self.code
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportAccountUsageRequest {
    csv: String,
    range_days: u8,
}

impl ExportAccountUsageRequest {
    pub const fn range_days(&self) -> u8 {
        self.range_days
    }
}

#[derive(Clone, Debug)]
pub struct ValidatedUsageCsv {
    row_count: usize,
}

impl ValidatedUsageCsv {
    pub const fn row_count(&self) -> usize {
        self.row_count
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ExportResult {
    Saved {
        path: String,
        rows: usize,
        bytes: usize,
    },
    Cancelled,
}

impl ExportResult {
    pub const fn rows(&self) -> usize {
        match self {
            Self::Saved { rows, .. } => *rows,
            Self::Cancelled => 0,
        }
    }
}

fn parse_csv(csv: &str) -> Result<Vec<Vec<String>>, UsageExportError> {
    let mut rows = Vec::<Vec<String>>::new();
    let mut row = Vec::<String>::new();
    let mut field = String::new();
    let mut chars = csv.chars().peekable();
    let mut quoted = false;
    let mut quote_closed = false;

    while let Some(character) = chars.next() {
        if quoted {
            if character == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                    quote_closed = true;
                }
            } else {
                field.push(character);
            }
            continue;
        }
        if quote_closed && character != ',' && character != '\r' {
            return Err(UsageExportError::new(
                UsageExportErrorCode::InvalidCsv,
                "usage CSV has characters after a closing quote",
            ));
        }
        match character {
            '"' if field.is_empty() && !quote_closed => quoted = true,
            ',' => {
                row.push(std::mem::take(&mut field));
                quote_closed = false;
            }
            '\r' if chars.next() == Some('\n') => {
                row.push(std::mem::take(&mut field));
                quote_closed = false;
                rows.push(std::mem::take(&mut row));
                if rows.len() > MAX_EXPORT_ROWS + 1 {
                    return Err(UsageExportError::new(
                        UsageExportErrorCode::TooLarge,
                        "usage CSV exceeds the row limit",
                    ));
                }
            }
            '\r' | '\n' | '"' => {
                return Err(UsageExportError::new(
                    UsageExportErrorCode::InvalidCsv,
                    "usage CSV is not canonical RFC 4180",
                ));
            }
            _ if quote_closed => unreachable!("closing quote branch handled above"),
            _ => field.push(character),
        }
    }
    if quoted || quote_closed || !field.is_empty() || !row.is_empty() || !csv.ends_with("\r\n") {
        return Err(UsageExportError::new(
            UsageExportErrorCode::InvalidCsv,
            "usage CSV must end at a complete CRLF record",
        ));
    }
    Ok(rows)
}

pub fn validate_usage_csv(csv: &str) -> Result<ValidatedUsageCsv, UsageExportError> {
    if csv.len() > MAX_EXPORT_BYTES {
        return Err(UsageExportError::new(
            UsageExportErrorCode::TooLarge,
            "usage CSV exceeds the byte limit",
        ));
    }
    if csv.contains('\0') {
        return Err(UsageExportError::new(
            UsageExportErrorCode::InvalidCsv,
            "usage CSV contains a NUL character",
        ));
    }
    let rows = parse_csv(csv)?;
    if rows
        .first()
        .is_none_or(|row| row.iter().map(String::as_str).ne(HEADER.iter().copied()))
    {
        return Err(UsageExportError::new(
            UsageExportErrorCode::InvalidCsv,
            "usage CSV has an unexpected header",
        ));
    }
    let data_rows = rows.len().saturating_sub(1);
    if data_rows > MAX_EXPORT_ROWS || rows.iter().any(|row| row.len() != HEADER.len()) {
        return Err(UsageExportError::new(
            UsageExportErrorCode::TooLarge,
            "usage CSV exceeds its bounded table shape",
        ));
    }
    for cell in rows.iter().skip(1).flatten() {
        if cell.starts_with(['\t', '\r', '\n', '=', '+', '-', '@']) {
            return Err(UsageExportError::new(
                UsageExportErrorCode::UnsafeCell,
                "usage CSV contains a spreadsheet-active cell",
            ));
        }
    }
    Ok(ValidatedUsageCsv {
        row_count: data_rows,
    })
}

fn is_reparse(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

#[cfg(windows)]
fn replace_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
    };
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let temporary = wide(temporary);
    let destination = wide(destination);
    let result = unsafe {
        if destination_exists(destination.as_ptr()) {
            ReplaceFileW(
                destination.as_ptr(),
                temporary.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } else {
            MoveFileExW(
                temporary.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    (result != 0)
        .then_some(())
        .ok_or_else(std::io::Error::last_os_error)
}

#[cfg(windows)]
fn destination_exists(path: *const u16) -> bool {
    use windows_sys::Win32::Storage::FileSystem::{GetFileAttributesW, INVALID_FILE_ATTRIBUTES};
    unsafe { GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES }
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temporary, destination)
}

pub fn save_validated_csv_at(
    destination: &Path,
    csv: &str,
) -> Result<ExportResult, UsageExportError> {
    let validated = validate_usage_csv(csv)?;
    let parent = destination.parent().ok_or_else(|| {
        UsageExportError::new(
            UsageExportErrorCode::UnsafeDestination,
            "selected destination has no parent",
        )
    })?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|_| {
        UsageExportError::new(
            UsageExportErrorCode::UnsafeDestination,
            "selected destination parent is unavailable",
        )
    })?;
    if !parent_metadata.is_dir() || is_reparse(parent) || is_reparse(destination) {
        return Err(UsageExportError::new(
            UsageExportErrorCode::UnsafeDestination,
            "selected destination crosses a link or reparse boundary",
        ));
    }
    if destination.exists() && !fs::metadata(destination).is_ok_and(|metadata| metadata.is_file()) {
        return Err(UsageExportError::new(
            UsageExportErrorCode::UnsafeDestination,
            "selected destination is not a regular file",
        ));
    }
    let temporary = parent.join(format!(".prime-studio-usage-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| {
                UsageExportError::new(
                    UsageExportErrorCode::Io,
                    "usage export temporary file is unavailable",
                )
            })?;
        file.write_all(csv.as_bytes()).map_err(|_| {
            UsageExportError::new(UsageExportErrorCode::Io, "usage export write failed")
        })?;
        file.sync_all().map_err(|_| {
            UsageExportError::new(UsageExportErrorCode::Io, "usage export durability failed")
        })?;
        drop(file);
        replace_file(&temporary, destination).map_err(|_| {
            UsageExportError::new(UsageExportErrorCode::Io, "usage export replacement failed")
        })?;
        Ok(ExportResult::Saved {
            path: destination.to_string_lossy().into_owned(),
            rows: validated.row_count,
            bytes: csv.len(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub(crate) async fn export_account_usage_csv(
    app: AppHandle,
    request: ExportAccountUsageRequest,
) -> Result<ExportResult, UsageExportError> {
    if !matches!(request.range_days, 7 | 30 | 90) {
        return Err(UsageExportError::new(
            UsageExportErrorCode::InvalidRequest,
            "usage export range is invalid",
        ));
    }
    validate_usage_csv(&request.csv)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("CSV", &["csv"])
        .set_file_name(format!("prime-studio-usage-{}d.csv", request.range_days))
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let selected = receiver.recv().map_err(|_| {
        UsageExportError::new(UsageExportErrorCode::Io, "usage export dialog failed")
    })?;
    let Some(destination) = selected.and_then(|path| path.into_path().ok()) else {
        return Ok(ExportResult::Cancelled);
    };
    save_validated_csv_at(&destination, &request.csv)
}
