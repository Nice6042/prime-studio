use std::fs;

use prime_studio_lib::commands::usage::{
    save_validated_csv_at, validate_usage_csv, ExportAccountUsageRequest, UsageExportErrorCode,
};
use serde_json::json;

const HEADER: &str = "timestamp,provider,cost,input,output,cache_read,cache_write\r\n";

#[test]
fn export_request_has_no_renderer_selected_destination() {
    let request: ExportAccountUsageRequest = serde_json::from_value(json!({
        "csv": format!("{HEADER}2026-08-12T00:00:00.000Z,openai-codex,1,2,3,4,5\r\n"),
        "rangeDays": 30
    }))
    .expect("closed export request");
    assert_eq!(request.range_days(), 30);

    assert!(serde_json::from_value::<ExportAccountUsageRequest>(json!({
        "csv": HEADER,
        "rangeDays": 30,
        "destination": "C:\\renderer-controlled.csv"
    }))
    .is_err());
}

#[test]
fn native_boundary_accepts_formula_safe_rfc4180_csv_and_rejects_active_cells() {
    let safe = format!("{HEADER}2026-08-12T00:00:00.000Z,\"'=HYPERLINK(\"\"x\"\")\",1,2,3,4,5\r\n");
    assert_eq!(
        validate_usage_csv(&safe).expect("safe export").row_count(),
        1
    );

    let unsafe_csv =
        format!("{HEADER}2026-08-12T00:00:00.000Z,\"=HYPERLINK(\"\"x\"\")\",1,2,3,4,5\r\n");
    assert_eq!(
        validate_usage_csv(&unsafe_csv).unwrap_err().code(),
        UsageExportErrorCode::UnsafeCell
    );
}

#[test]
fn native_boundary_rejects_noncanonical_or_oversized_exports() {
    assert_eq!(
        validate_usage_csv("provider,cost\r\nopenai-codex,1\r\n")
            .unwrap_err()
            .code(),
        UsageExportErrorCode::InvalidCsv
    );
    assert_eq!(
        validate_usage_csv(&format!("{HEADER}{}", "x".repeat(16 * 1024 * 1024)))
            .unwrap_err()
            .code(),
        UsageExportErrorCode::TooLarge
    );
}

#[test]
fn selected_destination_is_written_only_after_validation() {
    let root = std::env::temp_dir().join(format!(
        "prime-studio-usage-export-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&root).expect("fixture directory");
    let destination = root.join("usage.csv");
    let csv = format!("{HEADER}2026-08-12T00:00:00.000Z,openai-codex,1,2,3,4,5\r\n");

    let result = save_validated_csv_at(&destination, &csv).expect("selected save");
    assert_eq!(result.rows(), 1);
    assert_eq!(fs::read_to_string(&destination).unwrap(), csv);

    let invalid = format!("{HEADER}2026-08-12T00:00:00.000Z,=cmd,1,2,3,4,5\r\n");
    assert!(save_validated_csv_at(&destination, &invalid).is_err());
    assert_eq!(fs::read_to_string(&destination).unwrap(), csv);
    fs::remove_dir_all(root).expect("remove fixture");
}
