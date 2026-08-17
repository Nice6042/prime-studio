from pathlib import Path

# Patch self-test.
p = Path('app/scripts/windows-host-verification/Test-WindowsHostVerificationKit.ps1')
text = p.read_text()

def ro(t, before, after, label):
    c=t.count(before)
    if c!=1: raise SystemExit(f'{label}: {c}')
    return t.replace(before,after)

text = ro(text,
"""  $slackToken = 'xox' + 'b-' + ((1..20 | ForEach-Object { 'c' }) -join '')
  $jwt = 'eyJ' + ((1..12 | ForEach-Object { 'd' }) -join '') + '.' + ((1..16 | ForEach-Object { 'e' }) -join '') + '.' + ((1..16 | ForEach-Object { 'f' }) -join '')
  $email = 'operator' + '@' + 'example.invalid'
""",
"""  $slackToken = 'xox' + 'b-' + ((1..20 | ForEach-Object { 'c' }) -join '')
  $gitlabToken = 'glpat-' + ((1..24 | ForEach-Object { 'g' }) -join '')
  $npmToken = 'npm_' + ((1..24 | ForEach-Object { 'h' }) -join '')
  $huggingFaceToken = 'hf_' + ((1..24 | ForEach-Object { 'i' }) -join '')
  $awsSecret = ((1..40 | ForEach-Object { 'j' }) -join '')
  $jwt = 'eyJ' + ((1..12 | ForEach-Object { 'd' }) -join '') + '.' + ((1..16 | ForEach-Object { 'e' }) -join '') + '.' + ((1..16 | ForEach-Object { 'f' }) -join '')
  $email = 'operator' + '@' + 'example.invalid'
  $privateKeyBlock = "-----BEGIN PRIVATE KEY-----`n" + ((1..48 | ForEach-Object { 'k' }) -join '') + "`n-----END PRIVATE KEY-----"
""",
'synthetic values')

text = ro(text,
"""    "slack=$slackToken",
    "jwt=$jwt",
    "contact=$email",
    "repository=$repositoryRoot",
""",
"""    "slack=$slackToken",
    "gitlab=$gitlabToken",
    "npm=$npmToken",
    "huggingface=$huggingFaceToken",
    "AWS_SECRET_ACCESS_KEY=$awsSecret",
    "jwt=$jwt",
    "contact=$email",
    "privateKey=$privateKeyBlock",
    "remote=https://operator:$providerKey@example.invalid/repository",
    "repository=$repositoryRoot",
""",
'plain evidence')

text = ro(text,
"""    accessToken = $githubToken
    tokenCount = 7
""",
"""    accessToken = $githubToken
    apiToken = $providerKey
    tokenCount = 7
""",
'json api token')

text = ro(text,
"""  foreach ($forbidden in @($githubToken, $providerKey, $slackToken, $jwt, $email, $repositoryRoot, $env:USERPROFILE, $env:TEMP)) {
""",
"""  foreach ($forbidden in @($githubToken, $providerKey, $slackToken, $gitlabToken, $npmToken, $huggingFaceToken, $awsSecret, $jwt, $email, $privateKeyBlock, $repositoryRoot, $env:USERPROFILE, $env:TEMP)) {
""",
'forbidden list')

text = ro(text,
"""  foreach ($expected in @('<REDACTED>', '<REDACTED_GITHUB_TOKEN>', '<REDACTED_PROVIDER_KEY>', '<REDACTED_SLACK_TOKEN>', '<REDACTED_JWT>', '<EMAIL_REDACTED>', '<REPOSITORY_ROOT>', '<USER_PROFILE>', '<TEMP>')) {
""",
"""  foreach ($expected in @('<REDACTED>', '<REDACTED_GITHUB_TOKEN>', '<REDACTED_PROVIDER_KEY>', '<REDACTED_SLACK_TOKEN>', '<REDACTED_COLLABORATION_TOKEN>', '<REDACTED_PACKAGE_TOKEN>', '<REDACTED_PRIVATE_KEY_BLOCK>', '<REDACTED_URI_CREDENTIALS>', '<REDACTED_JWT>', '<EMAIL_REDACTED>', '<REPOSITORY_ROOT>', '<USER_PROFILE>', '<TEMP>')) {
""",
'expected markers')

text = ro(text,
"""  Assert-True -Condition ($redactedJson.accessToken -eq '<REDACTED>') -Message 'Secret-named JSON property was not redacted.'
  Assert-True -Condition ($redactedJson.nested.clientSecret -eq '<REDACTED>') -Message 'Nested secret-named JSON property was not redacted.'
""",
"""  Assert-True -Condition ($redactedJson.accessToken -eq '<REDACTED>') -Message 'Secret-named JSON property was not redacted.'
  Assert-True -Condition ($redactedJson.apiToken -eq '<REDACTED>') -Message 'Compound token property was not redacted.'
  Assert-True -Condition ($redactedJson.nested.clientSecret -eq '<REDACTED>') -Message 'Nested secret-named JSON property was not redacted.'
""",
'json assertions')
p.write_text(text, encoding='utf-8', newline='\n')

# Patch schema.
p = Path('docs/windows-host-preflight.schema.json')
text = p.read_text()
text = ro(text,
'''    "nullableString": {
      "type": ["string", "null"]
    },
''',
'''    "nullableString": {
      "type": ["string", "null"]
    },
    "nullableSafeText": {
      "oneOf": [
        { "$ref": "#/$defs/safeText" },
        { "type": "null" }
      ]
    },
''','nullable safe text')
text = text.replace('"path": { "$ref": "#/$defs/nullableString" }', '"path": { "$ref": "#/$defs/nullableSafeText" }')
text = text.replace('"version": { "$ref": "#/$defs/nullableString" }', '"version": { "$ref": "#/$defs/nullableSafeText" }')
text = ro(text,
'''          "enum": ["passed", "failed", "timed_out"]
''',
'''          "enum": ["passed", "failed", "timed_out", "unavailable"]
''','source status unavailable')
p.write_text(text, encoding='utf-8', newline='\n')

# Patch node test.
p = Path('tests/windows-host-verification-kit.test.mjs')
text = p.read_text()
text = ro(text,
'''  assert.equal(schema.$defs.sourceIdentity.properties.identityFiles.maxItems, 6);
});
''',
'''  assert.equal(schema.$defs.sourceIdentity.properties.identityFiles.maxItems, 6);
  assert.ok(schema.$defs.sourceCheck.properties.status.enum.includes("unavailable"));
  assert.equal(schema.$defs.toolObservation.properties.path.$ref, "#/$defs/nullableSafeText");
});
''','schema assertions')
text = ro(text,
'''    "<REDACTED_SLACK_TOKEN>",
    "<REDACTED_JWT>",
''',
'''    "<REDACTED_SLACK_TOKEN>",
    "<REDACTED_COLLABORATION_TOKEN>",
    "<REDACTED_PACKAGE_TOKEN>",
    "<REDACTED_PRIVATE_KEY_BLOCK>",
    "<REDACTED_URI_CREDENTIALS>",
    "<REDACTED_JWT>",
''','new markers')
text = ro(text,
'''  assert.match(collectSource, /Invoke-WindowsHostPreflightCollection/u);
''',
'''  assert.match(moduleSource, /function Get-SafeEvidenceFiles/u);
  assert.match(moduleSource, /sourceSize = \$null[\s\S]+reason = 'reparse_point'/u);
  assert.match(moduleSource, /elseif \(\$result\.Status -eq 'unavailable'\) \{ 'unavailable' \}/u);
  assert.match(collectSource, /Invoke-WindowsHostPreflightCollection/u);
''','new source assertions')
p.write_text(text, encoding='utf-8', newline='\n')

# Patch docs wording.
p = Path('docs/windows-host-verification.md')
text = p.read_text()
text = ro(text,
'''The requested checks are run independently and their redacted logs are preserved. If any check
fails or times out, the script writes the failed evidence and exits non-zero. It never edits a
failure into a pass.
''',
'''The requested checks are run independently and their redacted logs are preserved. If any check
is unavailable, fails, or times out, the script writes that exact result and exits non-zero. It
never edits a failure into a pass.
''','docs unavailable')
text = ro(text,
'''- rejects reparse-point paths, binary content, screenshots, archives, executables, installers,
''',
'''- does not traverse reparse-point directories and rejects reparse-point files before hashing or
  reading them;
- rejects binary content, screenshots, archives, executables, installers,
''','docs reparse')
p.write_text(text, encoding='utf-8', newline='\n')

print('patched tests/schema/docs')

p = Path('tests/windows-host-verification-kit.test.mjs')
t = p.read_text()
before = 'assert.match(guide, /fails or times out, the script writes the failed evidence and exits non-zero/iu);'
after = 'assert.match(guide, /is unavailable, fails, or times out, the script writes that exact result and exits non-zero/iu);'
if t.count(before) != 1:
    raise SystemExit(f'guide test wording: expected 1, found {t.count(before)}')
p.write_text(t.replace(before, after), encoding='utf-8', newline='\n')
