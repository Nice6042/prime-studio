from pathlib import Path


def replace_once(text: str, before: str, after: str, label: str) -> str:
    count = text.count(before)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    return text.replace(before, after)


module = Path("app/scripts/windows-host-verification/WindowsHostVerification.psm1")
text = module.read_text(encoding="utf-8")
entry_anchor = "          path = $base.path\n          sourceSize = $base.sourceSize"
entry_replacement = "          path = $base.path\n          sourcePathSha256 = $base.sourcePathSha256\n          sourceSize = $base.sourceSize"
entry_count = text.count(entry_anchor)
if entry_count != 4:
    raise SystemExit(f"manifest source-path propagation: expected four anchors, found {entry_count}")
text = text.replace(entry_anchor, entry_replacement)
text = replace_once(
    text,
    """  return @($files | Sort-Object FullName)
}

function Add-TextRedaction {
""",
    """  $descriptors = @($files | ForEach-Object {
    $relative = (Get-RelativeEvidencePath -Root $Root -Path $_.FullName).Replace([IO.Path]::DirectorySeparatorChar, '/')
    [pscustomobject]@{ File = $_; PathHash = Get-TextSha256 -Text $relative }
  })
  return @($descriptors | Sort-Object PathHash | ForEach-Object { $_.File })
}

function Add-TextRedaction {
""",
    "root-independent deterministic ordering",
)
module.write_text(text, encoding="utf-8", newline="\n")


self_test = Path("app/scripts/windows-host-verification/Test-WindowsHostVerificationKit.ps1")
text = self_test.read_text(encoding="utf-8")
text = replace_once(
    text,
    """  $pathHash = Get-TestTextSha256 -Text $RelativePath.Replace('\\', '/')
  $matches = @($Manifest.files | Where-Object { $_.sourcePathSha256 -eq $pathHash })
""",
    """  $pathHash = Get-TestTextSha256 -Text $RelativePath.Replace([IO.Path]::DirectorySeparatorChar, '/')
  $matches = @($Manifest.files | Where-Object {
    $property = $_.PSObject.Properties['sourcePathSha256']
    $null -ne $property -and $property.Value -eq $pathHash
  })
""",
    "robust manifest lookup",
)
text = replace_once(
    text,
    """$inputRoot = Join-Path $testRoot 'raw'
$bundleA = Join-Path $testRoot 'bundle-a'
""",
    """$inputRoot = Join-Path $testRoot 'raw'
$inputRootB = Join-Path $testRoot 'raw-copy'
$bundleA = Join-Path $testRoot 'bundle-a'
""",
    "second input root",
)
text = replace_once(
    text,
    """  [void](New-WindowsHostEvidenceBundle -InputRoot $inputRoot -OutputRoot $bundleA -RepositoryRoot $repositoryRoot -UserProfileRoot $redactionProfileRoot -TempRoot $redactionTempRoot)
  [void](New-WindowsHostEvidenceBundle -InputRoot $inputRoot -OutputRoot $bundleB -RepositoryRoot $repositoryRoot -UserProfileRoot $redactionProfileRoot -TempRoot $redactionTempRoot)
""",
    """  [void](New-Item -ItemType Directory -Path $inputRootB -Force)
  Get-ChildItem -LiteralPath $inputRoot -Force | Copy-Item -Destination $inputRootB -Recurse -Force
  [void](New-WindowsHostEvidenceBundle -InputRoot $inputRoot -OutputRoot $bundleA -RepositoryRoot $repositoryRoot -UserProfileRoot $redactionProfileRoot -TempRoot $redactionTempRoot)
  [void](New-WindowsHostEvidenceBundle -InputRoot $inputRootB -OutputRoot $bundleB -RepositoryRoot $repositoryRoot -UserProfileRoot $redactionProfileRoot -TempRoot $redactionTempRoot)
""",
    "cross-root deterministic bundle",
)
text = replace_once(
    text,
    """    if ($entry.reason -in @('extension_not_allowed', 'file_too_large', 'reparse_point')) {
      Assert-True -Condition ($null -eq $entry.sourceSha256) -Message 'An unbounded or disallowed source was hashed.'
    }
    else {
""",
    """    $reasonProperty = $entry.PSObject.Properties['reason']
    $entryReason = if ($null -ne $reasonProperty) { [string]$reasonProperty.Value } else { $null }
    if ($entryReason -in @('extension_not_allowed', 'file_too_large', 'reparse_point')) {
      Assert-True -Condition ($null -eq $entry.sourceSha256) -Message 'An unbounded or disallowed source was hashed.'
    }
    else {
""",
    "strict-mode optional reason",
)
self_test.write_text(text, encoding="utf-8", newline="\n")


node_test = Path("tests/windows-host-verification-kit.test.mjs")
text = node_test.read_text(encoding="utf-8")
text = replace_once(
    text,
    """  assert.match(moduleSource, /sourcePathSha256/u);
  assert.match(moduleSource, /evidence\\/\\{0:d4\\}-\\{1\\}\\{2\\}/u);
""",
    """  assert.match(moduleSource, /sourcePathSha256/u);
  assert.match(moduleSource, /Sort-Object PathHash/u);
  assert.match(moduleSource, /evidence\\/\\{0:d4\\}-\\{1\\}\\{2\\}/u);
""",
    "deterministic ordering contract",
)
node_test.write_text(text, encoding="utf-8", newline="\n")

print("patched source-path propagation and cross-root determinism")
