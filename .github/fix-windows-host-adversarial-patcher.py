from pathlib import Path

path = Path('.github/repair-windows-host-adversarial.py')
text = path.read_text(encoding='utf-8')
start_marker = '''text = replace_once(
    text,
    """  assert.match(moduleSource, /MaxEvidenceBundleBytes'''
end_marker = '''    "node entry budget assertion",
)
'''
start = text.find(start_marker)
if start < 0:
    raise SystemExit('broken node entry-budget block was not found')
end = text.find(end_marker, start)
if end < 0:
    raise SystemExit('broken node entry-budget block end was not found')
end += len(end_marker)
replacement = r'''text = replace_once(
    text,
    ''' + "'''" + r'''  assert.match(moduleSource, /MaxEvidenceBundleBytes\s*=\s*32\s*\*\s*1024\s*\*\s*1024/u);
  assert.match(moduleSource, /AllowedEvidenceExtensions\s*=\s*@\('\.txt', '\.json', '\.xml', '\.csv', '\.md', '\.log'\)/u);
''' + "'''" + r''',
    ''' + "'''" + r'''  assert.match(moduleSource, /MaxEvidenceBundleBytes\s*=\s*32\s*\*\s*1024\s*\*\s*1024/u);
  assert.match(moduleSource, /MaxEvidenceEntries\s*=\s*4096/u);
  assert.match(moduleSource, /AllowedEvidenceExtensions\s*=\s*@\('\.txt', '\.json', '\.xml', '\.csv', '\.md', '\.log'\)/u);
''' + "'''" + r''',
    "node entry budget assertion",
)
'''
path.write_text(text[:start] + replacement + text[end:], encoding='utf-8', newline='\n')
print('repaired adversarial patcher syntax')
