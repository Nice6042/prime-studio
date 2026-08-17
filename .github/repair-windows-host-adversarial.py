from pathlib import Path


def replace_once(text: str, before: str, after: str, label: str) -> str:
    count = text.count(before)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    return text.replace(before, after)


module = Path("app/scripts/windows-host-verification/WindowsHostVerification.psm1")
text = module.read_text(encoding="utf-8")
text = replace_once(
    text,
    "$script:MaxEvidenceBundleBytes = 32 * 1024 * 1024\n$script:AllowedEvidenceExtensions",
    "$script:MaxEvidenceBundleBytes = 32 * 1024 * 1024\n$script:MaxEvidenceEntries = 4096\n$script:AllowedEvidenceExtensions",
    "entry budget constant",
)
text = replace_once(
    text,
    "    [Parameter(Mandatory = $true)][string]$Content\n  )\n\n  $parent = Split-Path",
    "    [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Content\n  )\n\n  $parent = Split-Path",
    "empty output writer",
)
text = replace_once(
    text,
    """  $pending = New-Object 'System.Collections.Generic.Queue[System.IO.DirectoryInfo]'
  $files = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]'
  $pending.Enqueue([IO.DirectoryInfo](Get-Item -LiteralPath $Root -Force))
""",
    """  $rootItem = [IO.DirectoryInfo](Get-Item -LiteralPath $Root -Force)
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Evidence input root must not be a reparse point.'
  }
  $pending = New-Object 'System.Collections.Generic.Queue[System.IO.DirectoryInfo]'
  $files = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]'
  $pending.Enqueue($rootItem)
""",
    "root reparse rejection",
)
text = replace_once(
    text,
    """      $files.Add([IO.FileInfo]$item)
    }
  }
""",
    """      $files.Add([IO.FileInfo]$item)
      if ($files.Count -gt $script:MaxEvidenceEntries) {
        throw "Evidence input exceeds the $($script:MaxEvidenceEntries)-file limit."
      }
    }
  }
""",
    "entry budget enforcement",
)
text = replace_once(
    text,
    """  if ($Node -is [System.Collections.IEnumerable] -and -not ($Node -is [string])) {
    return @($Node | ForEach-Object { Protect-JsonNode -Node $_ -Count $Count })
  }
""",
    """  if ($Node -is [System.Collections.IEnumerable] -and -not ($Node -is [string])) {
    $items = @($Node | ForEach-Object { Protect-JsonNode -Node $_ -Count $Count })
    return ,$items
  }
""",
    "JSON array preservation",
)
text = replace_once(
    text,
    """  $protected = Add-TextRedaction -Text $protected -Pattern '(?is)-----BEGIN (?<kind>(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----.*?-----END \\k<kind>-----' -Replacement '<REDACTED_PRIVATE_KEY_BLOCK>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\b([A-Za-z0-9_.-]*(?:authorization|token|secret|password|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie)[A-Za-z0-9_.-]*)\\b\\s*[:=]\\s*(?:"[^"]*"|''[^'']*''|[^\\s,;]+)' -Replacement '$1=<REDACTED>' -Count $countRef
""",
    """  $protected = Add-TextRedaction -Text $protected -Pattern '(?is)-----BEGIN (?<kind>(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----.*?-----END \\k<kind>-----' -Replacement '<REDACTED_PRIVATE_KEY_BLOCK>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)(?<q>["''])(?<key>[A-Za-z0-9_.-]*(?:authorization|token|secret|password|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie)[A-Za-z0-9_.-]*)\\k<q>\\s*:\\s*(?:"(?:\\\\.|[^"])*"|''(?:\\\\.|[^''])*''|[^,\\r\\n}\\]]+)' -Replacement '${q}${key}${q}: "<REDACTED>"' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?is)<(?<tag>[A-Za-z_][A-Za-z0-9_.:-]*(?:authorization|token|secret|password|passphrase|apikey|accesskey|privatekey|credential|cookie|signingkey))\\b(?<attrs>[^>]*)>.*?</\\k<tag>\\s*>' -Replacement '<${tag}${attrs}><REDACTED></${tag}>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\b([A-Za-z0-9_.-]*(?:authorization|token|secret|password|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie)[A-Za-z0-9_.-]*)\\b\\s*[:=]\\s*(?:"[^"]*"|''[^'']*''|[^\\s,;]+)' -Replacement '$1=<REDACTED>' -Count $countRef
""",
    "quoted-key and XML redaction",
)
text = replace_once(
    text,
    "function Assert-NoHighRiskEvidenceResidue {\n  param([Parameter(Mandatory = $true)][string]$Text)",
    "function Assert-NoHighRiskEvidenceResidue {\n  param([AllowEmptyString()][Parameter(Mandatory = $true)][string]$Text)",
    "empty residue scan",
)
text = replace_once(
    text,
    """    '(?i)\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\\b',
    '(?is)-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----',
""",
    """    '(?i)\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\\b',
    '(?i)\\bhttps?://[^/\\s:@]+:[^/\\s@]+@',
    '\\bA(?:KIA|SIA)[A-Z0-9]{16}\\b',
    '(?is)-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----',
""",
    "residue scan expansion",
)
text = replace_once(
    text,
    """      Assert-NoHighRiskEvidenceResidue -Text $protected.Content
      $outputBytes = $script:Utf8NoBom.GetByteCount($protected.Content)
      if (($includedBytes + $outputBytes) -gt $script:MaxEvidenceBundleBytes) {
""",
    """      Assert-NoHighRiskEvidenceResidue -Text $protected.Content
      $outputBytes = $script:Utf8NoBom.GetByteCount($protected.Content)
      if ($outputBytes -gt $script:MaxEvidenceFileBytes) {
        $entry = [ordered]@{
          path = $base.path
          sourceSize = $base.sourceSize
          sourceSha256 = $base.sourceSha256
          status = 'excluded'
          reason = 'redacted_file_too_large'
        }
        $entries.Add([pscustomobject]$entry)
        continue
      }
      if (($includedBytes + $outputBytes) -gt $script:MaxEvidenceBundleBytes) {
""",
    "post-redaction file bound",
)
text = replace_once(
    text,
    """        maxFileBytes = $script:MaxEvidenceFileBytes
        maxBundleBytes = $script:MaxEvidenceBundleBytes
""",
    """        maxFileBytes = $script:MaxEvidenceFileBytes
        maxBundleBytes = $script:MaxEvidenceBundleBytes
        maxEntries = $script:MaxEvidenceEntries
""",
    "manifest entry budget",
)
text = replace_once(
    text,
    """    $manifestJson = $manifest | ConvertTo-Json -Depth 16
    if ($manifestJson.Contains($inputFull) -or $manifestJson.Contains($outputFull)) {
      throw 'Evidence manifest leaked an absolute input or output path.'
    }
""",
    """    $manifestJson = $manifest | ConvertTo-Json -Depth 16
    foreach ($forbiddenPath in @($inputFull, $outputFull)) {
      foreach ($candidate in @($forbiddenPath, $forbiddenPath.Replace('\\', '\\\\'), $forbiddenPath.Replace('\\', '/'))) {
        if ($manifestJson.IndexOf($candidate, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
          throw 'Evidence manifest leaked an absolute input or output path.'
        }
      }
    }
""",
    "case-insensitive manifest path oracle",
)
module.write_text(text, encoding="utf-8", newline="\n")

self_test = Path("app/scripts/windows-host-verification/Test-WindowsHostVerificationKit.ps1")
text = self_test.read_text(encoding="utf-8")
text = replace_once(
    text,
    """    nested = [ordered]@{
      clientSecret = $providerKey
      owner = $email
    }
  }
""",
    """    nested = [ordered]@{
      clientSecret = $providerKey
      owner = $email
    }
    oneElementArray = @([ordered]@{ apiToken = 'opaque-array-secret'; label = 'one' })
    emptyArray = @()
  }
""",
    "JSON array fixtures",
)
text = replace_once(
    text,
    """  [IO.File]::WriteAllText((Join-Path $inputRoot 'safe.md'), '# Safe evidence', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllBytes((Join-Path $inputRoot 'binary.log'), [byte[]](0, 255, 0, 1, 2, 3))
""",
    """  [IO.File]::WriteAllText((Join-Path $inputRoot 'safe.md'), '# Safe evidence', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'empty.log'), '', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'malformed.json'), '{"password":"opaque-malformed-secret",}', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'named-secret.xml'), '<root><apiToken>opaque-xml-secret</apiToken><tokenCount>7</tokenCount></root>', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'expanding.log'), ((1..150000 | ForEach-Object { 'apiToken=x' }) -join "`n"), (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllBytes((Join-Path $inputRoot 'binary.log'), [byte[]](0, 255, 0, 1, 2, 3))
""",
    "adversarial evidence fixtures",
)
text = replace_once(
    text,
    """  Assert-True -Condition ($redactedJson.nested.owner -eq '<EMAIL_REDACTED>') -Message 'Email in JSON was not redacted.'

  $manifest = [IO.File]::ReadAllText($manifestAPath) | ConvertFrom-Json
""",
    """  Assert-True -Condition ($redactedJson.nested.owner -eq '<EMAIL_REDACTED>') -Message 'Email in JSON was not redacted.'
  Assert-True -Condition (@($redactedJson.oneElementArray).Count -eq 1) -Message 'One-element JSON array lost its array identity.'
  Assert-True -Condition ($redactedJson.oneElementArray[0].apiToken -eq '<REDACTED>') -Message 'Secret inside a JSON array was not redacted.'
  Assert-True -Condition (@($redactedJson.emptyArray).Count -eq 0) -Message 'Empty JSON array did not remain empty.'
  Assert-True -Condition ([IO.File]::ReadAllText((Join-Path $bundleA 'empty.log')).Length -eq 0) -Message 'Empty text evidence was not preserved.'
  $malformedJson = [IO.File]::ReadAllText((Join-Path $bundleA 'malformed.json'))
  Assert-True -Condition (-not $malformedJson.Contains('opaque-malformed-secret')) -Message 'Quoted secret in malformed JSON survived fallback redaction.'
  Assert-True -Condition ($malformedJson.Contains('<REDACTED>')) -Message 'Malformed JSON did not receive a redaction marker.'
  $redactedXml = [IO.File]::ReadAllText((Join-Path $bundleA 'named-secret.xml'))
  Assert-True -Condition (-not $redactedXml.Contains('opaque-xml-secret')) -Message 'Secret-named XML element survived redaction.'
  Assert-True -Condition ($redactedXml.Contains('<tokenCount>7</tokenCount>')) -Message 'Benign XML token-count metadata was over-redacted.'

  $manifest = [IO.File]::ReadAllText($manifestAPath) | ConvertFrom-Json
""",
    "adversarial redaction assertions",
)
text = replace_once(
    text,
    """  Assert-True -Condition (($entries | Where-Object { $_.path -eq 'oversized.log' }).reason -eq 'file_too_large') -Message 'Oversized evidence was not excluded.'
""",
    """  Assert-True -Condition (($entries | Where-Object { $_.path -eq 'oversized.log' }).reason -eq 'file_too_large') -Message 'Oversized evidence was not excluded.'
  Assert-True -Condition (($entries | Where-Object { $_.path -eq 'expanding.log' }).reason -eq 'redacted_file_too_large') -Message 'Post-redaction file growth was not bounded.'
  Assert-True -Condition ($manifest.limits.maxEntries -eq 4096) -Message 'Manifest did not record the evidence-entry budget.'
""",
    "new manifest assertions",
)
self_test.write_text(text, encoding="utf-8", newline="\n")

node_test = Path("tests/windows-host-verification-kit.test.mjs")
text = node_test.read_text(encoding="utf-8")
text = replace_once(
    text,
    """  assert.match(moduleSource, /MaxEvidenceBundleBytes\\s*=\\s*32\\s*\\*\\s*1024\\s*\\*\\s*1024/u);
  assert.match(moduleSource, /AllowedEvidenceExtensions",
    """  assert.match(moduleSource, /MaxEvidenceBundleBytes\\s*=\\s*32\\s*\\*\\s*1024\\s*\\*\\s*1024/u);
  assert.match(moduleSource, /MaxEvidenceEntries\\s*=\\s*4096/u);
  assert.match(moduleSource, /AllowedEvidenceExtensions",
    "node entry budget assertion",
)
text = replace_once(
    text,
    """  for (const exclusion of ["reparse_point", "extension_not_allowed", "file_too_large", "binary_content", "bundle_budget_exceeded"]) {
""",
    """  for (const exclusion of ["reparse_point", "extension_not_allowed", "file_too_large", "redacted_file_too_large", "binary_content", "bundle_budget_exceeded"]) {
""",
    "node exclusion assertion",
)
text = replace_once(
    text,
    """  assert.match(moduleSource, /function Get-SafeEvidenceFiles/u);
""",
    """  assert.match(moduleSource, /function Get-SafeEvidenceFiles/u);
  assert.match(moduleSource, /Evidence input root must not be a reparse point/u);
  assert.match(moduleSource, /return ,\\$items/u);
""",
    "node structural hardening assertions",
)
node_test.write_text(text, encoding="utf-8", newline="\n")


docs = Path("docs/windows-host-verification.md")
text = docs.read_text(encoding="utf-8")
text = replace_once(
    text,
    """- caps each file at 2 MiB and the included bundle at 32 MiB;
- does not traverse reparse-point directories and rejects reparse-point files before hashing or
  reading them;
""",
    """- caps source and redacted files at 2 MiB, the included bundle at 32 MiB, and the input at
  4,096 files;
- rejects a reparse-point input root, does not traverse reparse-point directories, and rejects
  reparse-point files before hashing or reading them;
""",
    "docs bounded root",
)
text = replace_once(
    text,
    """- redacts authorization and cookie headers, secret-named JSON properties, common provider and
  collaboration token shapes, JWTs, and email addresses;
""",
    """- redacts authorization and cookie headers, secret-named JSON properties, quoted-key fallback
  records, secret-named XML elements, common provider and collaboration token shapes, JWTs, and
  email addresses;
""",
    "docs redaction scope",
)
docs.write_text(text, encoding="utf-8", newline="\n")

print("patched adversarial Windows host verification boundaries")
