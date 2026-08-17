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

  $pathHash = Get-TestTextSha256 -Text $RelativePath.Replace([IO.Path]::DirectorySeparatorChar, '/')
  $matches = @($Manifest.files | Where-Object {
    $property = $_.PSObject.Properties['sourcePathSha256']
    $null -ne $property -and $property.Value -eq $pathHash
  })
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
$inputRootB = Join-Path $testRoot 'raw-copy'
$bundleA = Join-Path $testRoot 'bundle-a'
$bundleB = Join-Path $testRoot 'bundle-b'
$preflightRoot = Join-Path $testRoot 'preflight'
$redactionProfileRoot = Join-Path $testRoot 'synthetic-profile'
$redactionTempRoot = Join-Path $redactionProfileRoot 'nested-temp'
[void](New-Item -ItemType Directory -Path $inputRoot -Force)

try {
  $githubToken = 'gh' + 'p_' + ((1..28 | ForEach-Object { 'a' }) -join '')
  $providerKey = 'sk-' + ((1..28 | ForEach-Object { 'b' }) -join '')
  $slackToken = 'xox' + 'b-' + ((1..20 | ForEach-Object { 'c' }) -join '')
  $gitlabToken = 'glpat-' + ((1..24 | ForEach-Object { 'g' }) -join '')
  $npmToken = 'npm_' + ((1..24 | ForEach-Object { 'h' }) -join '')
  $huggingFaceToken = 'hf_' + ((1..24 | ForEach-Object { 'i' }) -join '')
  $awsSecret = ((1..40 | ForEach-Object { 'j' }) -join '')
  $jwt = 'eyJ' + ((1..12 | ForEach-Object { 'd' }) -join '') + '.' + ((1..16 | ForEach-Object { 'e' }) -join '') + '.' + ((1..16 | ForEach-Object { 'f' }) -join '')
  $email = 'operator' + '@' + 'example.invalid'
  $privateKeyBlock = "-----BEGIN PRIVATE KEY-----`n" + ((1..48 | ForEach-Object { 'k' }) -join '') + "`n-----END PRIVATE KEY-----"

  $plain = @(
    "Authorization: Bearer $githubToken",
    "github=$githubToken",
    "provider_key=$providerKey",
    "slack=$slackToken",
    "gitlab=$gitlabToken",
    "npm=$npmToken",
    "huggingface=$huggingFaceToken",
    "AWS_SECRET_ACCESS_KEY=$awsSecret",
    "jwt=$jwt",
    "contact=$email",
    $privateKeyBlock,
    "remote=https://operator:$providerKey@example.invalid/repository",
    "repository=$repositoryRoot",
    "profile=$redactionProfileRoot",
    "temporary=$redactionTempRoot"
  ) -join "`r`n"
  [IO.File]::WriteAllText((Join-Path $inputRoot 'plain.log'), $plain, (New-Object Text.UTF8Encoding($false)))

  $nested = [ordered]@{
    accessToken = $githubToken
    apiToken = $providerKey
    tokenCount = 7
    repositoryPath = $repositoryRoot
    nested = [ordered]@{
      clientSecret = $providerKey
      owner = $email
    }
    oneElementArray = @([ordered]@{ apiToken = 'opaque-array-secret'; label = 'one' })
    emptyArray = @()
  }
  [IO.File]::WriteAllText(
    (Join-Path $inputRoot 'nested.json'),
    ($nested | ConvertTo-Json -Depth 8),
    (New-Object Text.UTF8Encoding($false))
  )
  [IO.File]::WriteAllText((Join-Path $inputRoot 'safe.md'), '# Safe evidence', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'percent%41.log'), 'literal percent path', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'percentA.log'), 'literal A path', (New-Object Text.UTF8Encoding($false)))
  $privateFileName = "$email.log"
  [IO.File]::WriteAllText((Join-Path $inputRoot $privateFileName), 'Private source name, safe content.', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'empty.log'), '', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'malformed.json'), '{"password":"opaque-malformed-secret",}', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'named-secret.xml'), '<root><apiToken>opaque-xml-secret</apiToken><tokenCount>7</tokenCount></root>', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'expanding.log'), ((1..150000 | ForEach-Object { 'apiToken=x' }) -join "`n"), (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllBytes((Join-Path $inputRoot 'binary.log'), [byte[]](0, 255, 0, 1, 2, 3))
  [IO.File]::WriteAllBytes((Join-Path $inputRoot 'screenshot.png'), [byte[]](137, 80, 78, 71))
  [IO.File]::WriteAllText(
    (Join-Path $inputRoot 'oversized.log'),
    ([string]::new('x', ((2 * 1024 * 1024) + 1))),
    (New-Object Text.UTF8Encoding($false))
  )

  [void](New-Item -ItemType Directory -Path $inputRootB -Force)
  Get-ChildItem -LiteralPath $inputRoot -Force | Copy-Item -Destination $inputRootB -Recurse -Force
  [void](New-WindowsHostEvidenceBundle -InputRoot $inputRoot -OutputRoot $bundleA -RepositoryRoot $repositoryRoot -UserProfileRoot $redactionProfileRoot -TempRoot $redactionTempRoot)
  [void](New-WindowsHostEvidenceBundle -InputRoot $inputRootB -OutputRoot $bundleB -RepositoryRoot $repositoryRoot -UserProfileRoot $redactionProfileRoot -TempRoot $redactionTempRoot)

  $manifestAPath = Join-Path $bundleA 'bundle-manifest.json'
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
  $percentEncodedEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'percent%41.log'
  $percentLiteralEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'percentA.log'
  Assert-True -Condition ($percentEncodedEntry.sourcePathSha256 -ne $percentLiteralEntry.sourcePathSha256) -Message 'Literal percent sequences were decoded while deriving evidence identity.'

  $redactedPlain = [IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $plainEntry))
  foreach ($forbidden in @($githubToken, $providerKey, $slackToken, $gitlabToken, $npmToken, $huggingFaceToken, $awsSecret, $jwt, $email, $privateKeyBlock, $repositoryRoot, $redactionProfileRoot, $redactionTempRoot)) {
    if ([string]::IsNullOrWhiteSpace($forbidden)) { continue }
    Assert-True -Condition ($redactedPlain.IndexOf($forbidden, [StringComparison]::OrdinalIgnoreCase) -lt 0) -Message 'A high-risk value survived text redaction.'
  }
  foreach ($expected in @('<REDACTED>', '<REDACTED_GITHUB_TOKEN>', '<REDACTED_PROVIDER_KEY>', '<REDACTED_SLACK_TOKEN>', '<REDACTED_COLLABORATION_TOKEN>', '<REDACTED_PACKAGE_TOKEN>', '<REDACTED_PRIVATE_KEY_BLOCK>', '<REDACTED_URI_CREDENTIALS>', '<REDACTED_JWT>', '<EMAIL_REDACTED>', '<REPOSITORY_ROOT>', '<USER_PROFILE>', '<TEMP>')) {
    Assert-True -Condition ($redactedPlain.Contains($expected)) -Message "Expected redaction marker was missing: $expected"
  }

  $redactedJson = [IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $nestedEntry)) | ConvertFrom-Json
  Assert-True -Condition ($redactedJson.accessToken -eq '<REDACTED>') -Message 'Secret-named JSON property was not redacted.'
  Assert-True -Condition ($redactedJson.apiToken -eq '<REDACTED>') -Message 'Compound token property was not redacted.'
  Assert-True -Condition ($redactedJson.nested.clientSecret -eq '<REDACTED>') -Message 'Nested secret-named JSON property was not redacted.'
  Assert-True -Condition ($redactedJson.tokenCount -eq 7) -Message 'Benign token-count metadata was over-redacted.'
  Assert-True -Condition ($redactedJson.repositoryPath -eq '<REPOSITORY_ROOT>') -Message 'Repository path in JSON was not redacted.'
  Assert-True -Condition ($redactedJson.nested.owner -eq '<EMAIL_REDACTED>') -Message 'Email in JSON was not redacted.'
  Assert-True -Condition (@($redactedJson.oneElementArray).Count -eq 1) -Message 'One-element JSON array lost its array identity.'
  Assert-True -Condition ($redactedJson.oneElementArray[0].apiToken -eq '<REDACTED>') -Message 'Secret inside a JSON array was not redacted.'
  Assert-True -Condition (@($redactedJson.emptyArray).Count -eq 0) -Message 'Empty JSON array did not remain empty.'
  Assert-True -Condition ([IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $emptyEntry)).Length -eq 0) -Message 'Empty text evidence was not preserved.'
  $malformedJson = [IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $malformedEntry))
  Assert-True -Condition (-not $malformedJson.Contains('opaque-malformed-secret')) -Message 'Quoted secret in malformed JSON survived fallback redaction.'
  Assert-True -Condition ($malformedJson.Contains('<REDACTED>')) -Message 'Malformed JSON did not receive a redaction marker.'
  $redactedXml = [IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $xmlEntry))
  Assert-True -Condition (-not $redactedXml.Contains('opaque-xml-secret')) -Message 'Secret-named XML element survived redaction.'
  Assert-True -Condition ($redactedXml.Contains('<tokenCount>7</tokenCount>')) -Message 'Benign XML token-count metadata was over-redacted.'

  Assert-True -Condition ($manifest.classification -eq 'HOST_COLLECTED_UNREVIEWED') -Message 'Bundle classification was not fail-closed.'
  Assert-True -Condition (-not $manifest.releaseEligible) -Message 'Bundle incorrectly claimed release eligibility.'
  $entries = @($manifest.files)
  $paths = @($entries | ForEach-Object { $_.path })
  $sortedPaths = @($paths | Sort-Object)
  Assert-True -Condition (($paths -join "`n") -eq ($sortedPaths -join "`n")) -Message 'Manifest entries were not sorted deterministically.'
  Assert-True -Condition ($binaryEntry.reason -eq 'binary_content') -Message 'Binary content was not excluded.'
  Assert-True -Condition ($screenshotEntry.reason -eq 'extension_not_allowed') -Message 'Screenshot evidence was not excluded for separate review.'
  Assert-True -Condition ($oversizedEntry.reason -eq 'file_too_large') -Message 'Oversized evidence was not excluded.'
  Assert-True -Condition ($expandingEntry.reason -eq 'redacted_file_too_large') -Message 'Post-redaction file growth was not bounded.'
  Assert-True -Condition ($manifest.limits.maxEntries -eq 4096) -Message 'Manifest did not record the evidence-entry budget.'
  foreach ($privatePath in @('plain.log', $privateFileName, $email)) {
    Assert-True -Condition ($manifestText.IndexOf($privatePath, [StringComparison]::OrdinalIgnoreCase) -lt 0) -Message 'Manifest leaked a raw evidence filename.'
  }
  Assert-True -Condition ([IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $privateNameEntry)) -eq 'Private source name, safe content.') -Message 'Pseudonymous path handling lost safe evidence content.'
  foreach ($entry in $entries) {
    Assert-True -Condition ($entry.path -match '^evidence/[0-9]{4}-[a-f0-9]{16}\.(txt|json|xml|csv|md|log|excluded)$') -Message 'Manifest bundle path was not deterministic and pseudonymous.'
    Assert-True -Condition ($entry.sourcePathSha256 -match '^[a-f0-9]{64}$') -Message 'Manifest source-path hash was malformed.'
    $reasonProperty = $entry.PSObject.Properties['reason']
    $entryReason = if ($null -ne $reasonProperty) { [string]$reasonProperty.Value } else { $null }
    if ($entryReason -in @('extension_not_allowed', 'file_too_large', 'reparse_point')) {
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

  $module = Get-Module WindowsHostVerification
  $safeObservation = & $module { param($value) Get-SafeObservationText -Text $value } (([string]::new('z', 5000)) + [char]9 + 'tail')
  Assert-True -Condition ($safeObservation.Length -eq 4096) -Message 'Tool observation text did not honor the schema bound.'
  Assert-True -Condition ($safeObservation.IndexOf([char]9) -lt 0) -Message 'Tool observation text retained a control character.'

  $brokenExecutable = Join-Path $testRoot 'broken-command.exe'
  [IO.File]::WriteAllText($brokenExecutable, 'not a Windows executable', (New-Object Text.UTF8Encoding($false)))
  $failedStart = & $module {
    param($executable, $workingDirectory, $repository, $profile, $temporary)
    Invoke-BoundedExternalCommand -Command $executable -WorkingDirectory $workingDirectory -TimeoutSeconds 5 -RepositoryRoot $repository -UserProfileRoot $profile -TempRoot $temporary
  } $brokenExecutable $testRoot $repositoryRoot $redactionProfileRoot $redactionTempRoot
  Assert-True -Condition ($failedStart.Status -eq 'failed') -Message 'An executable start failure escaped instead of becoming failed evidence.'
  Assert-True -Condition ($null -eq $failedStart.ExitCode) -Message 'An executable start failure invented an exit code.'
  Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($failedStart.Output)) -Message 'An executable start failure did not preserve a redacted reason.'

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
