use std::fs::{DirEntry, File, Metadata, OpenOptions};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde_json::Value;

#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    GetFinalPathNameByHandleW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
};

#[derive(Debug)]
pub(crate) struct BoundedFile {
    pub(crate) bytes: Vec<u8>,
    pub(crate) metadata: Metadata,
}

#[derive(Clone, Copy)]
pub(crate) struct JsonlLimits {
    max_bytes: usize,
    max_line_bytes: usize,
    max_lines: usize,
    max_records: usize,
}

impl JsonlLimits {
    pub(crate) const fn new(
        max_bytes: usize,
        max_line_bytes: usize,
        max_lines: usize,
        max_records: usize,
    ) -> Self {
        Self {
            max_bytes,
            max_line_bytes,
            max_lines,
            max_records,
        }
    }
}

fn reject_link_metadata(path: &Path, metadata: &Metadata) -> Result<(), String> {
    #[cfg(windows)]
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!("{} is a reparse point", path.display()));
    }
    #[cfg(not(windows))]
    if metadata.file_type().is_symlink() {
        return Err(format!("{} is a symbolic link", path.display()));
    }
    Ok(())
}

fn open_no_follow(path: &Path) -> Result<(File, Metadata), String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);

    #[cfg(not(windows))]
    {
        let before = std::fs::symlink_metadata(path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        reject_link_metadata(path, &before)?;
    }

    let file = options
        .open(path)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("{}: {error}", path.display()))?;
    reject_link_metadata(path, &metadata)?;
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    Ok((file, metadata))
}

/// Open once without following a leaf link, inspect that handle, and read at
/// most `max_bytes + 1`. The sentinel byte catches a file that grows after its
/// metadata was inspected without reopening the path.
fn opened_path(file: &File, requested_path: &Path) -> Result<std::path::PathBuf, String> {
    #[cfg(windows)]
    {
        let mut buffer = vec![0_u16; 512];
        loop {
            // SAFETY: `file` owns a valid handle for this call, and the writable
            // buffer is passed with its exact element count.
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
                )
            };
            if length == 0 {
                return Err(format!(
                    "{}: {}",
                    requested_path.display(),
                    std::io::Error::last_os_error()
                ));
            }
            if length < buffer.len() as u32 {
                buffer.truncate(length as usize);
                return Ok(std::path::PathBuf::from(String::from_utf16_lossy(&buffer)));
            }
            buffer.resize(length as usize + 1, 0);
        }
    }
    #[cfg(not(windows))]
    {
        requested_path
            .canonicalize()
            .map_err(|error| format!("{}: {error}", requested_path.display()))
    }
}

fn read_bounded_impl(
    canonical_root: Option<&Path>,
    path: &Path,
    max_bytes: usize,
) -> Result<BoundedFile, String> {
    let expected = path
        .canonicalize()
        .map_err(|error| format!("{}: {error}", path.display()))?;
    if canonical_root.is_some_and(|root| !expected.starts_with(root)) {
        return Err(format!("{} is outside the canonical root", path.display()));
    }
    let (file, metadata) = open_no_follow(path)?;
    let opened = opened_path(&file, path)?;
    if opened != expected || canonical_root.is_some_and(|root| !opened.starts_with(root)) {
        return Err(format!(
            "{} opened as an unexpected identity outside the canonical root",
            path.display()
        ));
    }
    if metadata.len() > max_bytes as u64 {
        return Err(format!(
            "{} exceeds {max_bytes} bytes ({} bytes)",
            path.display(),
            metadata.len()
        ));
    }
    let limit = u64::try_from(max_bytes)
        .unwrap_or(u64::MAX - 1)
        .saturating_add(1);
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    if bytes.len() > max_bytes {
        return Err(format!("{} exceeds {max_bytes} bytes", path.display()));
    }
    Ok(BoundedFile { bytes, metadata })
}

pub(crate) fn read_bounded(path: &Path, max_bytes: usize) -> Result<BoundedFile, String> {
    read_bounded_impl(None, path, max_bytes)
}

pub(crate) fn read_bounded_under(
    canonical_root: &Path,
    path: &Path,
    max_bytes: usize,
) -> Result<BoundedFile, String> {
    read_bounded_impl(Some(canonical_root), path, max_bytes)
}

pub(crate) fn read_jsonl_bounded(
    path: &Path,
    limits: JsonlLimits,
) -> Result<(Metadata, Vec<Value>), String> {
    let bounded = read_bounded(path, limits.max_bytes)?;
    let mut records = Vec::new();
    let mut lines = 0_usize;
    for line in bounded.bytes.split(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        lines += 1;
        if lines > limits.max_lines {
            return Err(format!(
                "{} exceeds {} lines",
                path.display(),
                limits.max_lines
            ));
        }
        if line.len() > limits.max_line_bytes {
            return Err(format!(
                "{} line exceeds {} bytes",
                path.display(),
                limits.max_line_bytes
            ));
        }
        if records.len() >= limits.max_records {
            return Err(format!(
                "{} exceeds {} records",
                path.display(),
                limits.max_records
            ));
        }
        if let Ok(value) = serde_json::from_slice::<Value>(line) {
            records.push(value);
        }
    }
    Ok((bounded.metadata, records))
}

/// Parse only a strict JSONL prefix from a checked file handle. Unlike
/// `read_jsonl_bounded`, the byte ceiling limits bytes inspected rather than
/// the total file size, and reaching the record ceiling returns immediately
/// without reading the tail.
pub(crate) fn read_jsonl_prefix_bounded(
    path: &Path,
    limits: JsonlLimits,
) -> Result<(Metadata, Vec<Value>), String> {
    let expected = path
        .canonicalize()
        .map_err(|error| format!("{}: {error}", path.display()))?;
    let (file, metadata) = open_no_follow(path)?;
    let opened = opened_path(&file, path)?;
    if opened != expected {
        return Err(format!(
            "{} opened as an unexpected identity",
            path.display()
        ));
    }

    let read_limit = u64::try_from(limits.max_bytes)
        .unwrap_or(u64::MAX - 1)
        .saturating_add(1);
    let mut reader = BufReader::new(file.take(read_limit));
    let mut records = Vec::with_capacity(limits.max_records.min(256));
    let mut scanned_bytes = 0_usize;
    let mut lines = 0_usize;

    while records.len() < limits.max_records {
        let remaining_bytes = limits.max_bytes.saturating_sub(scanned_bytes);
        let line_read_limit = limits
            .max_line_bytes
            .saturating_add(2)
            .min(remaining_bytes.saturating_add(1));
        let mut raw_line = Vec::with_capacity(line_read_limit.min(8 * 1024));
        let read = reader
            .by_ref()
            .take(u64::try_from(line_read_limit).unwrap_or(u64::MAX))
            .read_until(b'\n', &mut raw_line)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        if read > remaining_bytes {
            return Err(format!(
                "{} scan exceeds {} bytes",
                path.display(),
                limits.max_bytes
            ));
        }
        scanned_bytes += read;

        let line = raw_line.strip_suffix(b"\n").unwrap_or(&raw_line);
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.len() > limits.max_line_bytes {
            return Err(format!(
                "{} line exceeds {} bytes",
                path.display(),
                limits.max_line_bytes
            ));
        }
        if line.is_empty() {
            continue;
        }
        lines += 1;
        if lines > limits.max_lines {
            return Err(format!(
                "{} exceeds {} lines",
                path.display(),
                limits.max_lines
            ));
        }
        let value = serde_json::from_slice::<Value>(line).map_err(|error| {
            format!(
                "{} has invalid JSONL record at line {lines}: {error}",
                path.display()
            )
        })?;
        records.push(value);
    }

    Ok((metadata, records))
}

pub(crate) fn read_dir_bounded(path: &Path, max_entries: usize) -> Result<Vec<DirEntry>, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    reject_link_metadata(path, &metadata)?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|error| format!("{}: {error}", path.display()))? {
        if entries.len() >= max_entries {
            return Err(format!("{} exceeds {max_entries} entries", path.display()));
        }
        entries.push(entry.map_err(|error| format!("{}: {error}", path.display()))?);
    }
    Ok(entries)
}

pub(crate) fn entry_metadata_no_follow(entry: &DirEntry) -> Result<Metadata, String> {
    let path = entry.path();
    let metadata =
        std::fs::symlink_metadata(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    reject_link_metadata(&path, &metadata)?;
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture_dir() -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("prime-studio-bounded-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).expect("create bounded I/O fixture");
        path
    }

    #[test]
    fn opened_handle_read_rejects_bytes_beyond_the_ceiling() {
        let dir = fixture_dir();
        let path = dir.join("oversized.json");
        fs::write(&path, b"12345").expect("write fixture");

        let error = read_bounded(&path, 4).expect_err("max + 1 byte must fail closed");
        assert!(error.contains("exceeds 4 bytes"));
        fs::remove_dir_all(dir).expect("remove fixture");
    }

    #[test]
    fn opened_handle_identity_must_remain_inside_the_canonical_root() {
        let root = fixture_dir();
        let outside = fixture_dir();
        let inside_file = root.join("inside.txt");
        let outside_file = outside.join("outside.txt");
        fs::write(&inside_file, b"inside").expect("write inside fixture");
        fs::write(&outside_file, b"outside").expect("write outside fixture");
        let canonical_root = root.canonicalize().expect("canonical fixture root");

        assert_eq!(
            read_bounded_under(&canonical_root, &inside_file, 64)
                .expect("inside handle is admitted")
                .bytes,
            b"inside"
        );
        let error = read_bounded_under(&canonical_root, &outside_file, 64)
            .expect_err("outside handle must fail closed");
        assert!(error.contains("outside the canonical root"));
        fs::remove_dir_all(root).expect("remove root fixture");
        fs::remove_dir_all(outside).expect("remove outside fixture");
    }

    #[test]
    fn jsonl_rejects_oversized_lines_and_record_counts() {
        let dir = fixture_dir();
        let long = dir.join("long.jsonl");
        fs::write(&long, b"{\"value\":\"12345678\"}\n").expect("write long line");
        let error = read_jsonl_bounded(&long, JsonlLimits::new(128, 8, 10, 10))
            .expect_err("oversized line must fail");
        assert!(error.contains("line exceeds 8 bytes"));

        let records = dir.join("records.jsonl");
        fs::write(&records, b"{}\n{}\n{}\n").expect("write records");
        let error = read_jsonl_bounded(&records, JsonlLimits::new(128, 32, 10, 2))
            .expect_err("record ceiling must fail");
        assert!(error.contains("exceeds 2 records"));

        let malformed = dir.join("malformed.jsonl");
        fs::write(&malformed, b"x\nx\nx\n").expect("write malformed lines");
        let error = read_jsonl_bounded(&malformed, JsonlLimits::new(128, 32, 2, 10))
            .expect_err("malformed input still counts toward the line ceiling");
        assert!(error.contains("exceeds 2 lines"));
        fs::remove_dir_all(dir).expect("remove fixture");
    }

    #[test]
    fn jsonl_prefix_stops_at_the_record_cap_before_a_hostile_tail() {
        let dir = fixture_dir();
        let path = dir.join("bounded-prefix.jsonl");
        let hostile_tail = "x".repeat(1024 * 1024);
        fs::write(&path, format!("{{}}\n{{}}\n{hostile_tail}"))
            .expect("write oversized hostile tail");

        let (metadata, records) = read_jsonl_prefix_bounded(&path, JsonlLimits::new(32, 16, 2, 2))
            .expect("the unread tail must not affect the bounded prefix");

        assert_eq!(records, vec![serde_json::json!({}), serde_json::json!({})]);
        assert!(
            metadata.len() > 32,
            "the helper must stream a prefix instead of rejecting the whole file size"
        );
        fs::remove_dir_all(dir).expect("remove fixture");
    }

    #[test]
    fn jsonl_prefix_fails_closed_inside_its_byte_and_json_boundaries() {
        let dir = fixture_dir();
        let malformed = dir.join("malformed-prefix.jsonl");
        fs::write(&malformed, b"{}\nnot-json\n").expect("write malformed prefix");
        let error = read_jsonl_prefix_bounded(&malformed, JsonlLimits::new(128, 32, 10, 10))
            .expect_err("malformed JSON inside the scanned prefix must fail closed");
        assert!(error.contains("invalid JSONL record"));

        let oversized = dir.join("oversized-prefix.jsonl");
        fs::write(&oversized, b"{\"value\":\"0123456789\"}\n")
            .expect("write byte-overflowing prefix");
        let error = read_jsonl_prefix_bounded(&oversized, JsonlLimits::new(8, 64, 10, 10))
            .expect_err("the streaming byte budget must fail closed");
        assert!(error.contains("scan exceeds 8 bytes"));
        fs::remove_dir_all(dir).expect("remove fixture");
    }

    #[test]
    fn directory_enumeration_stops_at_the_checked_ceiling() {
        let dir = fixture_dir();
        for name in ["a", "b", "c"] {
            fs::write(dir.join(name), b"x").expect("write entry");
        }
        let error = read_dir_bounded(&dir, 2).expect_err("entry ceiling must fail");
        assert!(error.contains("exceeds 2 entries"));
        fs::remove_dir_all(dir).expect("remove fixture");
    }

    #[cfg(windows)]
    #[test]
    fn no_follow_open_rejects_a_symlink_leaf() {
        use std::os::windows::fs::symlink_file;

        let dir = fixture_dir();
        let target = dir.join("target.json");
        let link = dir.join("link.json");
        fs::write(&target, b"secret").expect("write symlink target");
        symlink_file(&target, &link).expect("test requires Windows symlink support");

        let error = read_bounded(&link, 64).expect_err("reparse leaf must fail closed");
        assert!(error.contains("reparse point"));
        fs::remove_dir_all(dir).expect("remove fixture");
    }
}
