from pathlib import Path

path = Path("app/scripts/windows-host-verification/WindowsHostVerification.psm1")
text = path.read_text(encoding="utf-8")

replacements = [
    ("      files = @($entries)\n", "      files = $entries.ToArray()\n", "bundle manifest generic list"),
    ("    commands = @($records)\n", "    commands = $records.ToArray()\n", "source-check generic list"),
]
for before, after, label in replacements:
    count = text.count(before)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    text = text.replace(before, after)

path.write_text(text, encoding="utf-8", newline="\n")

test_path = Path("app/scripts/windows-host-verification/Test-WindowsHostVerificationKit.ps1")
test_text = test_path.read_text(encoding="utf-8")
before = '    "Authorization: Bearer $githubToken",\n    "provider_key=$providerKey",\n'
after = '    "Authorization: Bearer $githubToken",\n    "github=$githubToken",\n    "provider_key=$providerKey",\n'
count = test_text.count(before)
if count != 1:
    raise SystemExit(f"GitHub token-shape oracle: expected one anchor, found {count}")
test_path.write_text(test_text.replace(before, after), encoding="utf-8", newline="\n")

print("patched Windows PowerShell compatibility and token-shape oracle")
