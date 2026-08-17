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
    """function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-RelativeEvidencePath {
""",
    """function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextSha256 {
  param([AllowEmptyString()][Parameter(Mandatory = $true)][string]$Text)

  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $script:Utf8NoBom.GetBytes($Text)
    return -join ($algorithm.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
  }
  finally {
    $algorithm.Dispose()
  }
}

function Get-RelativeEvidencePath {
""",
    "text hash helper",
)
text = replace_once(
    text,
    """  $entries = New-Object System.Collections.Generic.List[object]
  $includedBytes = 0L

  try {
    $files = @(Get-SafeEvidenceFiles -Root $inputFull)
    foreach ($file in $files) {
      $relative = Get-RelativeEvidencePath -Root $inputFull -Path $file.FullName
      $relativeManifestPath = $relative.Replace([IO.Path]::DirectorySeparatorChar, '/')
      if (Test-ReparsePointInPath -Root $inputFull -Path $file.FullName) {
        $entries.Add([pscustomobject][ordered]@{
          path = $relativeManifestPath
          sourceSize = $null
          sourceSha256 = $null
          status = 'excluded'
          reason = 'reparse_point'
        })
        continue
      }

      $sourceHash = Get-Sha256 -Path $file.FullName
      $base = [ordered]@{
        path = $relativeManifestPath
        sourceSize = [int64]$file.Length
        sourceSha256 = $sourceHash
      }

      $reason = $null
      if ($script:AllowedEvidenceExtensions -notcontains $file.Extension.ToLowerInvariant()) {
        $reason = 'extension_not_allowed'
      }
      elseif ($file.Length -gt $script:MaxEvidenceFileBytes) {
        $reason = 'file_too_large'
      }

      if ($null -ne $reason) {
        $entry = [ordered]@{
          path = $base.path
          sourceSize = $base.sourceSize
          sourceSha256 = $base.sourceSha256
          status = 'excluded'
          reason = $reason
        }
        $entries.Add([pscustomobject]$entry)
        continue
      }
""",
    """  $entries = New-Object System.Collections.Generic.List[object]
  $includedBytes = 0L
  $fileOrdinal = 0

  try {
    $files = @(Get-SafeEvidenceFiles -Root $inputFull)
    foreach ($file in $files) {
      $fileOrdinal += 1
      $relative = Get-RelativeEvidencePath -Root $inputFull -Path $file.FullName
      $relativeManifestPath = $relative.Replace([IO.Path]::DirectorySeparatorChar, '/')
      $sourcePathSha256 = Get-TextSha256 -Text $relativeManifestPath
      $extension = $file.Extension.ToLowerInvariant()
      $safeExtension = if ($script:AllowedEvidenceExtensions -contains $extension) { $extension } else { '.excluded' }
      $bundlePath = 'evidence/{0:d4}-{1}{2}' -f $fileOrdinal, $sourcePathSha256.Substring(0, 16), $safeExtension

      if (Test-ReparsePointInPath -Root $inputFull -Path $file.FullName) {
        $entries.Add([pscustomobject][ordered]@{
          path = $bundlePath
          sourcePathSha256 = $sourcePathSha256
          sourceSize = $null
          sourceSha256 = $null
          status = 'excluded'
          reason = 'reparse_point'
        })
        continue
      }

      $sourceSize = [int64]$file.Length
      $reason = $null
      if ($script:AllowedEvidenceExtensions -notcontains $extension) {
        $reason = 'extension_not_allowed'
      }
      elseif ($sourceSize -gt $script:MaxEvidenceFileBytes) {
        $reason = 'file_too_large'
      }

      if ($null -ne $reason) {
        $entry = [ordered]@{
          path = $bundlePath
          sourcePathSha256 = $sourcePathSha256
          sourceSize = $sourceSize
          sourceSha256 = $null
          status = 'excluded'
          reason = $reason
        }
        $entries.Add([pscustomobject]$entry)
        continue
      }

      $sourceHash = Get-Sha256 -Path $file.FullName
      $base = [ordered]@{
        path = $bundlePath
        sourcePathSha256 = $sourcePathSha256
        sourceSize = $sourceSize
        sourceSha256 = $sourceHash
      }
""",
    "pseudonymous paths and pre-hash exclusions",
)
text = replace_once(
    text,
    """      $destination = Join-Path $stage $relative
      Write-Utf8NoBom -Path $destination -Content $protected.Content
""",
    """      $destination = Join-Path $stage ($base.path.Replace('/', [IO.Path]::DirectorySeparatorChar))
      Write-Utf8NoBom -Path $destination -Content $protected.Content
""",
    "safe bundle destination",
)
module.write_text(text, encoding="utf-8", newline="\n")


self_test = Path("app/scripts/windows-host-verification/Test-WindowsHostVerificationKit.ps1")
text = self_test.read_text(encoding="utf-8")
text = replace_once(
    text,
    """function Assert-True {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if (-not $Condition) { throw $Message }
}

$modulePath = Join-Path $PSScriptRoot 'WindowsHostVerification.psm1'
""",
    """function Assert-True {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if (-not $Condition) { throw $Message }
}

function Get-TestTextSha256 {
  param([AllowEmptyString()][Parameter(Mandatory = $true)][string]$Text)

  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Text)
    return -join ($algorithm.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
  }
  finally {
    $algorithm.Dispose()
  }
}

function Get-ManifestEntryForRelativePath {
  param(
    [Parameter(Mandatory = $true)]$Manifest,
    [Parameter(Mandatory = $true)][string]$RelativePath
  )

  $pathHash = Get-TestTextSha256 -Text $RelativePath.Replace('\\', '/')
  $matches = @($Manifest.files | Where-Object { $_.sourcePathSha256 -eq $pathHash })
  Assert-True -Condition ($matches.Count -eq 1) -Message "Expected one manifest entry for $RelativePath."
  return $matches[0]
}

function Get-BundledEvidencePath {
  param(
    [Parameter(Mandatory = $true)][string]$BundleRoot,
    [Parameter(Mandatory = $true)]$Entry
  )
  return Join-Path $BundleRoot ([string]$Entry.path).Replace('/', [IO.Path]::DirectorySeparatorChar)
}

$modulePath = Join-Path $PSScriptRoot 'WindowsHostVerification.psm1'
""",
    "self-test manifest helpers",
)
text = replace_once(
    text,
    """  [IO.File]::WriteAllText((Join-Path $inputRoot 'safe.md'), '# Safe evidence', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'empty.log'), '', (New-Object Text.UTF8Encoding($false)))
""",
    """  [IO.File]::WriteAllText((Join-Path $inputRoot 'safe.md'), '# Safe evidence', (New-Object Text.UTF8Encoding($false)))
  $privateFileName = "$email.log"
  [IO.File]::WriteAllText((Join-Path $inputRoot $privateFileName), 'Private source name, safe content.', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'empty.log'), '', (New-Object Text.UTF8Encoding($false)))
""",
    "private filename fixture",
)
text = replace_once(
    text,
    """  $manifestAPath = Join-Path $bundleA 'bundle-manifest.json'
  $manifestBPath = Join-Path $bundleB 'bundle-manifest.json'
  Assert-True -Condition ((Get-FileHash $manifestAPath -Algorithm SHA256).Hash -eq (Get-FileHash $manifestBPath -Algorithm SHA256).Hash) -Message 'Bundle manifests were not deterministic.'

  $redactedPlain = [IO.File]::ReadAllText((Join-Path $bundleA 'plain.log'))
""",
    """  $manifestAPath = Join-Path $bundleA 'bundle-manifest.json'
  $manifestBPath = Join-Path $bundleB 'bundle-manifest.json'
  Assert-True -Condition ((Get-FileHash $manifestAPath -Algorithm SHA256).Hash -eq (Get-FileHash $manifestBPath -Algorithm SHA256).Hash) -Message 'Bundle manifests were not deterministic.'
  $manifestText = [IO.File]::ReadAllText($manifestAPath)
  $manifest = $manifestText | ConvertFrom-Json

  $plainEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'plain.log'
  $nestedEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'nested.json'
  $emptyEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'empty.log'
  $malformedEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'malformed.json'
  $xmlEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'named-secret.xml'
  $privateNameEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath $privateFileName
  $binaryEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'binary.log'
  $screenshotEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'screenshot.png'
  $oversizedEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'oversized.log'
  $expandingEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'expanding.log'

  $redactedPlain = [IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $plainEntry))
""",
    "manifest-first evidence lookup",
)
text = replace_once(
    text,
    """  $redactedJson = [IO.File]::ReadAllText((Join-Path $bundleA 'nested.json')) | ConvertFrom-Json
""",
    """  $redactedJson = [IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $nestedEntry)) | ConvertFrom-Json
""",
    "nested JSON safe path",
)
text = replace_once(
    text,
    """  Assert-True -Condition ([IO.File]::ReadAllText((Join-Path $bundleA 'empty.log')).Length -eq 0) -Message 'Empty text evidence was not preserved.'
  $malformedJson = [IO.File]::ReadAllText((Join-Path $bundleA 'malformed.json'))
""",
    """  Assert-True -Condition ([IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $emptyEntry)).Length -eq 0) -Message 'Empty text evidence was not preserved.'
  $malformedJson = [IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $malformedEntry))
""",
    "empty and malformed safe paths",
)
text = replace_once(
    text,
    """  $redactedXml = [IO.File]::ReadAllText((Join-Path $bundleA 'named-secret.xml'))
""",
    """  $redactedXml = [IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $xmlEntry))
""",
    "XML safe path",
)
text = replace_once(
    text,
    """  $manifest = [IO.File]::ReadAllText($manifestAPath) | ConvertFrom-Json
  Assert-True -Condition ($manifest.classification -eq 'HOST_COLLECTED_UNREVIEWED') -Message 'Bundle classification was not fail-closed.'
""",
    """  Assert-True -Condition ($manifest.classification -eq 'HOST_COLLECTED_UNREVIEWED') -Message 'Bundle classification was not fail-closed.'
""",
    "remove duplicate manifest read",
)
text = replace_once(
    text,
    """  Assert-True -Condition (($entries | Where-Object { $_.path -eq 'binary.log' }).reason -eq 'binary_content') -Message 'Binary content was not excluded.'
  Assert-True -Condition (($entries | Where-Object { $_.path -eq 'screenshot.png' }).reason -eq 'extension_not_allowed') -Message 'Screenshot evidence was not excluded for separate review.'
  Assert-True -Condition (($entries | Where-Object { $_.path -eq 'oversized.log' }).reason -eq 'file_too_large') -Message 'Oversized evidence was not excluded.'
  Assert-True -Condition (($entries | Where-Object { $_.path -eq 'expanding.log' }).reason -eq 'redacted_file_too_large') -Message 'Post-redaction file growth was not bounded.'
""",
    """  Assert-True -Condition ($binaryEntry.reason -eq 'binary_content') -Message 'Binary content was not excluded.'
  Assert-True -Condition ($screenshotEntry.reason -eq 'extension_not_allowed') -Message 'Screenshot evidence was not excluded for separate review.'
  Assert-True -Condition ($oversizedEntry.reason -eq 'file_too_large') -Message 'Oversized evidence was not excluded.'
  Assert-True -Condition ($expandingEntry.reason -eq 'redacted_file_too_large') -Message 'Post-redaction file growth was not bounded.'
""",
    "excluded entry lookups",
)
text = replace_once(
    text,
    """  Assert-True -Condition ($manifest.limits.maxEntries -eq 4096) -Message 'Manifest did not record the evidence-entry budget.'
  foreach ($entry in $entries) {
    Assert-True -Condition ($entry.sourceSha256 -match '^[a-f0-9]{64}$') -Message 'Manifest source hash was malformed.'
    if ($entry.status -eq 'included') {
      Assert-True -Condition ($entry.bundledSha256 -match '^[a-f0-9]{64}$') -Message 'Manifest bundled hash was malformed.'
      Assert-True -Condition ((Get-FileHash (Join-Path $bundleA $entry.path) -Algorithm SHA256).Hash.ToLowerInvariant() -eq $entry.bundledSha256) -Message 'Manifest bundled hash did not match the output file.'
      Assert-True -Condition ((Get-FileHash (Join-Path $bundleA $entry.path) -Algorithm SHA256).Hash -eq (Get-FileHash (Join-Path $bundleB $entry.path) -Algorithm SHA256).Hash) -Message 'Included evidence output was not deterministic.'
    }
  }
""",
    """  Assert-True -Condition ($manifest.limits.maxEntries -eq 4096) -Message 'Manifest did not record the evidence-entry budget.'
  foreach ($privatePath in @('plain.log', $privateFileName, $email)) {
    Assert-True -Condition ($manifestText.IndexOf($privatePath, [StringComparison]::OrdinalIgnoreCase) -lt 0) -Message 'Manifest leaked a raw evidence filename.'
  }
  Assert-True -Condition ([IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $privateNameEntry)) -eq 'Private source name, safe content.') -Message 'Pseudonymous path handling lost safe evidence content.'
  foreach ($entry in $entries) {
    Assert-True -Condition ($entry.path -match '^evidence/[0-9]{4}-[a-f0-9]{16}\\.(txt|json|xml|csv|md|log|excluded)$') -Message 'Manifest bundle path was not deterministic and pseudonymous.'
    Assert-True -Condition ($entry.sourcePathSha256 -match '^[a-f0-9]{64}$') -Message 'Manifest source-path hash was malformed.'
    if ($entry.reason -in @('extension_not_allowed', 'file_too_large', 'reparse_point')) {
      Assert-True -Condition ($null -eq $entry.sourceSha256) -Message 'An unbounded or disallowed source was hashed.'
    }
    else {
      Assert-True -Condition ($entry.sourceSha256 -match '^[a-f0-9]{64}$') -Message 'Manifest bounded-source hash was malformed.'
    }
    if ($entry.status -eq 'included') {
      $bundleAPath = Get-BundledEvidencePath -BundleRoot $bundleA -Entry $entry
      $bundleBPath = Get-BundledEvidencePath -BundleRoot $bundleB -Entry $entry
      Assert-True -Condition ($entry.bundledSha256 -match '^[a-f0-9]{64}$') -Message 'Manifest bundled hash was malformed.'
      Assert-True -Condition ((Get-FileHash $bundleAPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $entry.bundledSha256) -Message 'Manifest bundled hash did not match the output file.'
      Assert-True -Condition ((Get-FileHash $bundleAPath -Algorithm SHA256).Hash -eq (Get-FileHash $bundleBPath -Algorithm SHA256).Hash) -Message 'Included evidence output was not deterministic.'
    }
  }
""",
    "pseudonymous manifest assertions",
)
self_test.write_text(text, encoding="utf-8", newline="\n")


node_test = Path("tests/windows-host-verification-kit.test.mjs")
text = node_test.read_text(encoding="utf-8")
text = replace_once(
    text,
    """  assert.match(moduleSource, /function Get-SafeEvidenceFiles/u);
  assert.match(moduleSource, /Evidence input root must not be a reparse point/u);
  assert.match(moduleSource, /return ,\\$items/u);
""",
    """  assert.match(moduleSource, /function Get-SafeEvidenceFiles/u);
  assert.match(moduleSource, /function Get-TextSha256/u);
  assert.match(moduleSource, /Evidence input root must not be a reparse point/u);
  assert.match(moduleSource, /sourcePathSha256/u);
  assert.match(moduleSource, /evidence\\/\\{0:d4\\}-\\{1\\}\\{2\\}/u);
  assert.match(moduleSource, /return ,\\$items/u);
""",
    "node path privacy assertions",
)
node_test.write_text(text, encoding="utf-8", newline="\n")


docs = Path("docs/windows-host-verification.md")
text = docs.read_text(encoding="utf-8")
text = replace_once(
    text,
    """- writes UTF-8 without a byte-order mark and normalizes line endings;
- writes a deterministic `bundle-manifest.json` sorted by relative path, with source and bundled
  SHA-256 hashes plus explicit exclusion reasons;
""",
    """- writes UTF-8 without a byte-order mark and normalizes line endings;
- never writes the raw relative evidence filename; every manifest and output path is a deterministic
  ordinal plus a SHA-256-derived source-path pseudonym, preventing filenames from leaking personal
  data, credentials, reserved device names, or excessive path length;
- writes a deterministic `bundle-manifest.json` sorted by pseudonymous path, with a full
  source-path SHA-256, bounded source and bundled SHA-256 hashes, plus explicit exclusion reasons;
- records no content hash for reparse points, disallowed extensions, or over-limit source files,
  so excluded unbounded inputs are not read merely to produce a digest;
""",
    "docs path privacy",
)
docs.write_text(text, encoding="utf-8", newline="\n")

print("patched evidence path privacy and pre-hash bounds")
