from pathlib import Path

path = Path('.github/repair-windows-host-path-privacy-followup.py')
text = path.read_text(encoding='utf-8')
anchor = '''text = text.replace(entry_anchor, entry_replacement)
text = replace_once(
'''
replacement = '''text = text.replace(entry_anchor, entry_replacement)
included_anchor = "        path = $base.path\\n        sourceSize = $base.sourceSize"
included_replacement = "        path = $base.path\\n        sourcePathSha256 = $base.sourcePathSha256\\n        sourceSize = $base.sourceSize"
included_count = text.count(included_anchor)
if included_count != 1:
    raise SystemExit(f"included manifest source-path propagation: expected one anchor, found {included_count}")
text = text.replace(included_anchor, included_replacement)
text = replace_once(
'''
count = text.count(anchor)
if count != 1:
    raise SystemExit(f'included propagation insertion anchor expected one match, found {count}')
path.write_text(text.replace(anchor, replacement), encoding='utf-8', newline='\n')
print('repaired included source-path propagation')
