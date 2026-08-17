from pathlib import Path

path = Path('.github/repair-windows-host-path-privacy-followup.py')
text = path.read_text(encoding='utf-8')
before = '''if entry_count != 4:
    raise SystemExit(f"manifest source-path propagation: expected four anchors, found {entry_count}")
'''
after = '''if entry_count != 3:
    raise SystemExit(f"manifest source-path propagation: expected three anchors, found {entry_count}")
'''
count = text.count(before)
if count != 1:
    raise SystemExit(f'follow-up cardinality anchor expected one match, found {count}')
path.write_text(text.replace(before, after), encoding='utf-8', newline='\n')
print('repaired source-path propagation cardinality')
