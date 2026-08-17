from pathlib import Path

path = Path("app/scripts/windows-host-verification/WindowsHostVerification.psm1")
text = path.read_text(encoding="utf-8")

replacements = [
    (
        "    [Parameter(Mandatory = $true)][string]$Text,\n    [Parameter(Mandatory = $true)][string]$Pattern,",
        "    [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Text,\n    [Parameter(Mandatory = $true)][string]$Pattern,",
        "redaction helper empty input",
    ),
    (
        "    [Parameter(Mandatory = $true)][string]$Text,\n    [AllowNull()][string]$Path,",
        "    [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Text,\n    [AllowNull()][string]$Path,",
        "path helper empty input",
    ),
    (
        "  $countRef = [ref]$count\n  $protected = $Text\n  $protected = Protect-ExactPath",
        "  $countRef = [ref]$count\n  $protected = $Text\n  if ($protected.Length -eq 0) {\n    return [pscustomobject]@{ Content = ''; Redactions = 0 }\n  }\n  $protected = Protect-ExactPath",
        "empty text short circuit",
    ),
]
for before, after, label in replacements:
    count = text.count(before)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    text = text.replace(before, after)

path.write_text(text, encoding="utf-8", newline="\n")
print("patched empty command output handling")
