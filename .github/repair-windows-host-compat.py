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
print("patched Windows PowerShell generic-list compatibility")
