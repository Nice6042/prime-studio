[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if (-not $Condition) { throw $Message }
}

$modulePath = Join-Path $PSScriptRoot 'WindowsHostVerification.psm1'
Import-Module $modulePath -Force

$parseFiles = @($modulePath) + @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File | Select-Object -ExpandProperty FullName)
foreach ($path in $parseFiles) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  Assert-True -Condition (@($errors).Count -eq 0) -Message "PowerShell parser rejected $path`: $(($errors | ForEach-Object { $_.Message }) -join '; ')"
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('prime-studio-host-kit-test-' + [Guid]::NewGuid().ToString('N'))
$inputRoot = Join-Path $testRoot 'raw'
$bundleA = Join-Path $testRoot 'bundle-a'
$bundleB = Join-Path $testRoot 'bundle-b'
$preflightRoot = Join-Path $testRoot 'preflight'
[void](New-Item -ItemType Directory -Path $inputRoot -Force)

try {
  $githubToken = 'gh' + 'p_' + ((1..28 | ForEach-Object { 'a' }) -join '')
  $providerKey = 'sk-' + ((1..28 | ForEach-Object { 'b' }) -join '')
  $slackToken = 'xox' + 'b-' + ((1..20 | ForEach-Object { 'c' }) -join '')
  $jwt = 'eyJ' + ((1..12 | ForEach-Object { 'd' }) -join '') + '.' + ((1..16 | ForEach-Object { 'e' }) -join '') + '.' + ((1..16 | ForEach-Object { 'f' }) -join '')
  $email = 'operator' + '@' + 'example.invalid'

  $plain = @(
    "Authorization: Bearer $githubToken",
    "provider_key=$providerKey",
    "slack=$slackToken",
    "jwt=$jwt",
    "contact=$email",
    "repository=$repositoryRoot",
    "profile=$env:USERPROFILE",
    "temporary=$env:TEMP"
  ) -join "`r`n"
  [IO.File]::WriteAllText((Join-Path $inputRoot 'plain.log'), $plain, (New-Object Text.UTF8Encoding($false)))

  $nested = [ordered]@{
    accessToken = $githubToken
    tokenCount = 7
    repositoryPath = $repositoryRoot
    nested = [ordered]@{
      clientSecret = $providerKey
      owner = $email
    }
  }
  [IO.File]::WriteAllText(
    (Join-Path $inputRoot 'nested.json'),
    ($nested | ConvertTo-Json -Depth 8),
    (New-Object Text.UTF8Encoding($false))
  )
  [IO.File]::WriteAllText((Join-Path $inputRoot 'safe.md'), '# Safe evidence', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllBytes((Join-Path $inputRoot 'binary.log'), [byte[]](0, 255, 0, 1, 2, 3))
  [IO.File]::WriteAllBytes((Join-Path $inputRoot 'screenshot.png'), [byte[]](137, 80, 78, 71))
  [IO.File]::WriteAllText(
    (Join-Path $inputRoot 'oversized.log'),
    ([string]::new('x', ((2 * 1024 * 1024) + 1))),
    (New-Object Text.UTF8Encoding($false))
  )

  [void](New-WindowsHostEvidenceBundle -InputRoot $inputRoot -OutputRoot $bundleA -RepositoryRoot $repositoryRoot -UserProfileRoot $env:USERPROFILE -TempRoot $env:TEMP)
  [void](New-WindowsHostEvidenceBundle -InputRoot $inputRoot -OutputRoot $bundleB -RepositoryRoot $repositoryRoot -UserProfileRoot $env:USERPROFILE -TempRoot $env:TEMP)

  $manifestAPath = Join-Path $bundleA 'bundle-manifest.json'
  $manifestBPath = Join-Path $bundleB 'bundle-manifest.json'
  Assert-True -Condition ((Get-FileHash $manifestAPath -Algorithm SHA256).Hash -eq (Get-FileHash $manifestBPath -Algorithm SHA256).Hash) -Message 'Bundle manifests were not deterministic.'

  $redactedPlain = [IO.File]::ReadAllText((Join-Path $bundleA 'plain.log'))
  foreach ($forbidden in @($githubToken, $providerKey, $slackToken, $jwt, $email, $repositoryRoot, $env:USERPROFILE, $env:TEMP)) {
    if ([string]::IsNullOrWhiteSpace($forbidden)) { continue }
    Assert-True -Condition ($redactedPlain.IndexOf($forbidden, [StringComparison]::OrdinalIgnoreCase) -lt 0) -Message 'A high-risk value survived text redaction.'
  }
  foreach ($expected in @('<REDACTED>', '<REDACTED_GITHUB_TOKEN>', '<REDACTED_PROVIDER_KEY>', '<REDACTED_SLACK_TOKEN>', '<REDACTED_JWT>', '<EMAIL_REDACTED>', '<REPOSITORY_ROOT>', '<USER_PROFILE>', '<TEMP>')) {
    Assert-True -Condition ($redactedPlain.Contains($expected)) -Message "Expected redaction marker was missing: $expected"
  }

  $redactedJson = [IO.File]::ReadAllText((Join-Path $bundleA 'nested.json')) | ConvertFrom-Json
  Assert-True -Condition ($redactedJson.accessToken -eq '<REDACTED>') -Message 'Secret-named JSON property was not redacted.'
  Assert-True -Condition ($redactedJson.nested.clientSecret -eq '<REDACTED>') -Message 'Nested secret-named JSON property was not redacted.'
  Assert-True -Condition ($redactedJson.tokenCount -eq 7) -Message 'Benign token-count metadata was over-redacted.'
  Assert-True -Condition ($redactedJson.repositoryPath -eq '<REPOSITORY_ROOT>') -Message 'Repository path in JSON was not redacted.'
  Assert-True -Condition ($redactedJson.nested.owner -eq '<EMAIL_REDACTED>') -Message 'Email in JSON was not redacted.'

  $manifest = [IO.File]::ReadAllText($manifestAPath) | ConvertFrom-Json
  Assert-True -Condition ($manifest.classification -eq 'HOST_COLLECTED_UNREVIEWED') -Message 'Bundle classification was not fail-closed.'
  Assert-True -Condition (-not $manifest.releaseEligible) -Message 'Bundle incorrectly claimed release eligibility.'
  $entries = @($manifest.files)
  $paths = @($entries | ForEach-Object { $_.path })
  $sortedPaths = @($paths | Sort-Object)
  Assert-True -Condition (($paths -join "`n") -eq ($sortedPaths -join "`n")) -Message 'Manifest entries were not sorted deterministically.'
  Assert-True -Condition (($entries | Where-Object { $_.path -eq 'binary.log' }).reason -eq 'binary_content') -Message 'Binary content was not excluded.'
  Assert-True -Condition (($entries | Where-Object { $_.path -eq 'screenshot.png' }).reason -eq 'extension_not_allowed') -Message 'Screenshot evidence was not excluded for separate review.'
  Assert-True -Condition (($entries | Where-Object { $_.path -eq 'oversized.log' }).reason -eq 'file_too_large') -Message 'Oversized evidence was not excluded.'
  foreach ($entry in $entries) {
    Assert-True -Condition ($entry.sourceSha256 -match '^[a-f0-9]{64}$') -Message 'Manifest source hash was malformed.'
    if ($entry.status -eq 'included') {
      Assert-True -Condition ($entry.bundledSha256 -match '^[a-f0-9]{64}$') -Message 'Manifest bundled hash was malformed.'
      Assert-True -Condition ((Get-FileHash (Join-Path $bundleA $entry.path) -Algorithm SHA256).Hash.ToLowerInvariant() -eq $entry.bundledSha256) -Message 'Manifest bundled hash did not match the output file.'
      Assert-True -Condition ((Get-FileHash (Join-Path $bundleA $entry.path) -Algorithm SHA256).Hash -eq (Get-FileHash (Join-Path $bundleB $entry.path) -Algorithm SHA256).Hash) -Message 'Included evidence output was not deterministic.'
    }
  }

  $preflight = Invoke-WindowsHostPreflightCollection -RepositoryRoot $repositoryRoot -OutputRoot $preflightRoot
  Assert-True -Condition $preflight.Success -Message 'Preflight without source checks should complete.'
  $recordText = [IO.File]::ReadAllText($preflight.RecordPath)
  $record = $recordText | ConvertFrom-Json
  Assert-True -Condition ($record.classification -eq 'HOST_COLLECTED_UNREVIEWED') -Message 'Preflight classification was not fail-closed.'
  Assert-True -Condition ($record.reviewState -eq 'HOST_COLLECTED_UNREVIEWED') -Message 'Preflight review state was not fail-closed.'
  Assert-True -Condition (-not $record.releaseEligible) -Message 'Preflight incorrectly claimed release eligibility.'
  Assert-True -Condition ($record.sourceChecks.overall -eq 'NOT_RUN') -Message 'Preflight invented source-check success.'
  foreach ($claim in @('exactPrimeClosure', 'activation', 'providerSession', 'interactionWorker', 'installerSigning', 'releaseAuthority')) {
    Assert-True -Condition ($record.claims.$claim -eq 'NOT_ATTESTED') -Message "Preflight invented the $claim claim."
  }
  Assert-True -Condition ($record.sourceIdentity.commit -match '^[a-f0-9]{40}$') -Message 'Preflight commit identity was malformed.'
  Assert-True -Condition (@($record.sourceIdentity.identityFiles).Count -eq 6) -Message 'Preflight did not bind all required source identity files.'
  foreach ($forbidden in @($repositoryRoot, $env:USERPROFILE, $env:TEMP)) {
    if ([string]::IsNullOrWhiteSpace($forbidden)) { continue }
    foreach ($candidate in @($forbidden, $forbidden.Replace('\', '\\'), $forbidden.Replace('\', '/'))) {
      Assert-True -Condition ($recordText.IndexOf($candidate, [StringComparison]::OrdinalIgnoreCase) -lt 0) -Message 'Preflight leaked an absolute path.'
    }
  }

  Write-Output 'Windows host verification kit self-test passed.'
}
finally {
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
