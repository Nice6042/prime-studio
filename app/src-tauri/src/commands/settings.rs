use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::authority::TauriCommand;

const MAX_LAYOUT_BYTES: u64 = 16 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LayoutPreferencesV1 {
    schema_version: u8,
    sidebar_open: bool,
    sidebar_width: u16,
    inspector_open: bool,
    inspector_width: u16,
    editor_open: bool,
    editor_width: u16,
}

impl Default for LayoutPreferencesV1 {
    fn default() -> Self {
        Self {
            schema_version: 1,
            sidebar_open: true,
            sidebar_width: 264,
            inspector_open: true,
            inspector_width: 384,
            editor_open: false,
            editor_width: 400,
        }
    }
}

impl LayoutPreferencesV1 {
    fn normalized(mut self) -> Self {
        if self.schema_version != 1 {
            return Self::default();
        }
        self.sidebar_width = self.sidebar_width.clamp(210, 380);
        self.inspector_width = self.inspector_width.clamp(300, 600);
        self.editor_width = self.editor_width.clamp(280, 600);
        self
    }
}

fn layout_path() -> PathBuf {
    crate::config_dir().join("layout-preferences-v1.json")
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
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    false
}

fn read_layout(path: &Path) -> LayoutPreferencesV1 {
    if is_reparse(path) {
        return LayoutPreferencesV1::default();
    }
    let Ok(metadata) = fs::metadata(path) else {
        return LayoutPreferencesV1::default();
    };
    if !metadata.is_file() || metadata.len() > MAX_LAYOUT_BYTES {
        return LayoutPreferencesV1::default();
    }
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<LayoutPreferencesV1>(&bytes).ok())
        .map(LayoutPreferencesV1::normalized)
        .unwrap_or_default()
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
    let temporary_wide = wide(temporary);
    let destination_wide = wide(destination);
    let result = unsafe {
        if destination.exists() {
            ReplaceFileW(
                destination_wide.as_ptr(),
                temporary_wide.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } else {
            MoveFileExW(
                temporary_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temporary, destination)
}

fn write_layout(path: &Path, preferences: &LayoutPreferencesV1) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "layout path has no parent".to_owned())?;
    fs::create_dir_all(parent).map_err(|_| "layout directory unavailable".to_owned())?;
    if is_reparse(parent) || is_reparse(path) {
        return Err("layout path is not trusted".to_owned());
    }
    let bytes = serde_json::to_vec(preferences).map_err(|_| "layout encoding failed".to_owned())?;
    if bytes.len() as u64 > MAX_LAYOUT_BYTES {
        return Err("layout preferences are too large".to_owned());
    }
    let temporary = parent.join(format!(".layout-preferences-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "layout temporary file unavailable".to_owned())?;
    let result = (|| {
        file.write_all(&bytes)
            .map_err(|_| "layout write failed".to_owned())?;
        file.sync_all()
            .map_err(|_| "layout durability failed".to_owned())?;
        drop(file);
        replace_file(&temporary, path).map_err(|_| "layout replacement failed".to_owned())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub(crate) fn get_layout_preferences() -> LayoutPreferencesV1 {
    read_layout(&layout_path())
}

#[tauri::command]
pub(crate) fn set_layout_preferences(
    state: State<'_, crate::AppState>,
    preferences: LayoutPreferencesV1,
) -> Result<LayoutPreferencesV1, String> {
    crate::require_tauri_authority(&state, TauriCommand::SetLayoutPreferences)?;
    let preferences = preferences.normalized();
    write_layout(&layout_path(), &preferences)?;
    Ok(preferences)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_preferences_are_versioned_and_clamped() {
        let normalized = LayoutPreferencesV1 {
            schema_version: 1,
            sidebar_open: true,
            sidebar_width: 0,
            inspector_open: true,
            inspector_width: u16::MAX,
            editor_open: true,
            editor_width: 0,
        }
        .normalized();
        assert_eq!(normalized.sidebar_width, 210);
        assert_eq!(normalized.inspector_width, 600);
        assert_eq!(normalized.editor_width, 280);
        assert_eq!(
            LayoutPreferencesV1 {
                schema_version: 2,
                ..normalized
            }
            .normalized(),
            LayoutPreferencesV1::default()
        );
    }
}
