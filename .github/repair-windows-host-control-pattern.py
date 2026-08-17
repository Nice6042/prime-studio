from pathlib import Path

module_path = Path("app/scripts/windows-host-verification/WindowsHostVerification.psm1")
text = module_path.read_text(encoding="utf-8")
actual = "'[\x00-\x1f\x7f-\x9f]'"
textual = "'[\\x00-\\x1f\\x7f-\\x9f]'"
count = text.count(actual)
if count != 1:
    raise SystemExit(f"control-pattern anchor: expected one, found {count}")
text = text.replace(actual, textual)
module_path.write_text(text, encoding="utf-8", newline="\n")

node_path = Path("tests/windows-host-verification-kit.test.mjs")
node = node_path.read_text(encoding="utf-8")
before = '''  assert.match(moduleSource, /function Get-SafeObservationText/u);
  assert.doesNotMatch(moduleSource, /UnescapeDataString|MakeRelativeUri/u);
'''
after = '''  assert.match(moduleSource, /function Get-SafeObservationText/u);
  assert.match(moduleSource, /'\\[\\\\x00-\\\\x1f\\\\x7f-\\\\x9f\\]'/u);
  assert.doesNotMatch(moduleSource, /[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]/u);
  assert.doesNotMatch(moduleSource, /UnescapeDataString|MakeRelativeUri/u);
'''
count = node.count(before)
if count != 1:
    raise SystemExit(f"source control oracle: expected one, found {count}")
node_path.write_text(node.replace(before, after), encoding="utf-8", newline="\n")

print("replaced embedded control bytes with textual .NET regex escapes")
