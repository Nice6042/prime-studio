[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BundleRoot,

  [string]$StageRoot
)

$ErrorActionPreference = 'Stop'
$requiredUpgradeCode = '876b9e7d-e060-59f1-acc2-629b8f60957a'

function Get-SingleArtifact {
  param(
    [string]$Directory,
    [string]$Filter,
    [string]$Label
  )

  $files = @(Get-ChildItem -LiteralPath $Directory -File -Filter $Filter -ErrorAction SilentlyContinue)
  if ($files.Count -ne 1) {
    throw "Unsigned candidate inventory requires exactly one MSI and one NSIS executable; found $($files.Count) $Label artifact(s)."
  }
  return $files[0]
}

function Get-MsiProperty {
  param(
    [object]$Database,
    [string]$Name
  )

  $query = "SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = '$Name'"
  $view = $Database.OpenView($query)
  $record = $null
  try {
    [void]$view.Execute()
    $record = $view.Fetch()
    if ($null -eq $record) {
      throw "MSI property $Name is missing."
    }
    return [string]$record.StringData(1)
  }
  finally {
    if ($null -ne $record) {
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)
    }
    if ($null -ne $view) {
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
    }
  }
}

function Assert-FileContains {
  param(
    [string]$Path,
    [string]$Pattern,
    [string]$Message
  )

  if (-not (Select-String -LiteralPath $Path -Pattern $Pattern -Quiet)) {
    throw $Message
  }
}

function Get-UnsignedArtifactRecord {
  param(
    [IO.FileInfo]$Source,
    [string]$CandidateName
  )

  $signature = Get-AuthenticodeSignature -LiteralPath $Source.FullName
  if ($signature.Status.ToString() -ne 'NotSigned') {
    throw "Expected an unsigned development candidate, but $($Source.Name) has Authenticode status $($signature.Status)."
  }

  [ordered]@{
    sourceFileName = $Source.Name
    candidateFileName = $CandidateName
    size = $Source.Length
    sha256 = (Get-FileHash -LiteralPath $Source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    authenticode = [ordered]@{
      status = 'NotSigned'
      signer = $null
    }
  }
}

$resolvedBundleRoot = [IO.Path]::GetFullPath($BundleRoot)
if (-not (Test-Path -LiteralPath $resolvedBundleRoot -PathType Container)) {
  throw "Bundle root does not exist: $resolvedBundleRoot"
}

$msi = Get-SingleArtifact -Directory (Join-Path $resolvedBundleRoot 'msi') -Filter '*.msi' -Label 'MSI'
$nsis = Get-SingleArtifact -Directory (Join-Path $resolvedBundleRoot 'nsis') -Filter '*-setup.exe' -Label 'NSIS'

$unexpectedUpdaterArtifacts = @(
  Get-ChildItem -LiteralPath $resolvedBundleRoot -Recurse -File |
    Where-Object { $_.Name -match '\.(sig|zip|tar\.gz)$' }
)
if ($unexpectedUpdaterArtifacts.Count -ne 0) {
  throw "Updater archives or signatures are forbidden in an unsigned candidate bundle."
}

$releaseRoot = Split-Path -Parent $resolvedBundleRoot
$nsisManifest = Join-Path $releaseRoot 'nsis\x64\installer.nsi'
$wixManifest = Join-Path $releaseRoot 'wix\x64\main.wxs'
if (-not (Test-Path -LiteralPath $nsisManifest -PathType Leaf) -or -not (Test-Path -LiteralPath $wixManifest -PathType Leaf)) {
  throw "Generated NSIS and WiX manifests are required for policy inspection."
}

Assert-FileContains $nsisManifest '!define INSTALLMODE "currentUser"' 'Generated NSIS installer is not current-user scoped.'
Assert-FileContains $nsisManifest '!define ALLOWDOWNGRADES "false"' 'Generated NSIS installer does not block downgrades.'
Assert-FileContains $nsisManifest '!define INSTALLWEBVIEW2MODE "downloadBootstrapper"' 'Generated NSIS installer has an unexpected WebView2 policy.'
Assert-FileContains $nsisManifest '!define WEBVIEW2INSTALLERARGS "/silent"' 'Generated NSIS WebView2 bootstrapper is not silent.'
Assert-FileContains $wixManifest 'InstallScope="perMachine"' 'Generated MSI installer is not explicitly per-machine scoped.'
Assert-FileContains $wixManifest "UpgradeCode=`"$requiredUpgradeCode`"" 'Generated MSI UpgradeCode does not match the pinned lineage.'
Assert-FileContains $wixManifest '<MajorUpgrade[^>]+DowngradeErrorMessage=' 'Generated MSI installer does not block downgrades.'
Assert-FileContains $wixManifest "CustomAction Id='DownloadAndInvokeBootstrapper'" 'Generated MSI installer has an unexpected WebView2 policy.'
Assert-FileContains $wixManifest '&apos;/silent&apos;' 'Generated MSI WebView2 bootstrapper is not silent.'
Assert-FileContains $wixManifest '&apos;/install&apos;' 'Generated MSI WebView2 bootstrapper does not request installation.'
Assert-FileContains $wixManifest 'https://go\.microsoft\.com/fwlink/p/\?LinkId=2124703' 'Generated MSI WebView2 bootstrapper has an unexpected download origin.'

$nsisText = [IO.File]::ReadAllText($nsisManifest)
$nsisExternalPayload = [regex]::Match(
  $nsisText,
  '(?s); Copy external binaries(?<payload>.*?); Create file associations'
)
if (-not $nsisExternalPayload.Success) {
  throw "Generated NSIS external-binary payload section is missing."
}
$unapprovedNsisExecutables = $nsisExternalPayload.Groups['payload'].Value -match '\bFile\b'
$unapprovedWixExecutables = @(
  Select-String -LiteralPath $wixManifest -Pattern '<File Id="(?!Path")[^"]+"[^>]+Source="[^"]+\.exe"'
)
if ($unapprovedNsisExecutables -or $unapprovedWixExecutables.Count -ne 0) {
  throw "Generated installer payload contains an unapproved executable; test-support binaries must never ship."
}

$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $null
try {
  $database = $installer.OpenDatabase($msi.FullName, 0)
  $msiUpgradeCode = (Get-MsiProperty -Database $database -Name 'UpgradeCode').Trim('{}').ToLowerInvariant()
  $msiAllUsers = Get-MsiProperty -Database $database -Name 'ALLUSERS'
  $msiProductName = Get-MsiProperty -Database $database -Name 'ProductName'
  $msiProductVersion = Get-MsiProperty -Database $database -Name 'ProductVersion'
}
finally {
  if ($null -ne $database) {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
  }
  if ($null -ne $installer) {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
  }
}

if ($msiUpgradeCode -ne $requiredUpgradeCode) {
  throw "Built MSI UpgradeCode $msiUpgradeCode does not match the pinned lineage."
}
if ($msiAllUsers -ne '1') {
  throw "Built MSI must declare ALLUSERS=1 for its documented per-machine scope."
}

$msiCandidateName = "$($msi.BaseName)-UNSIGNED-CANDIDATE$($msi.Extension)"
$nsisCandidateName = "$($nsis.BaseName)-UNSIGNED-CANDIDATE$($nsis.Extension)"
$msiRecord = Get-UnsignedArtifactRecord -Source $msi -CandidateName $msiCandidateName
$nsisRecord = Get-UnsignedArtifactRecord -Source $nsis -CandidateName $nsisCandidateName

if ([string]::IsNullOrWhiteSpace($StageRoot)) {
  $StageRoot = Join-Path $releaseRoot 'windows-unsigned-candidate'
}
$resolvedStageRoot = [IO.Path]::GetFullPath($StageRoot)
if (Test-Path -LiteralPath $resolvedStageRoot) {
  $existing = @(Get-ChildItem -LiteralPath $resolvedStageRoot -Force)
  if ($existing.Count -ne 0) {
    throw "Candidate stage already contains files; use a new empty directory: $resolvedStageRoot"
  }
}
else {
  [void](New-Item -ItemType Directory -Path $resolvedStageRoot)
}

Copy-Item -LiteralPath $msi.FullName -Destination (Join-Path $resolvedStageRoot $msiCandidateName)
Copy-Item -LiteralPath $nsis.FullName -Destination (Join-Path $resolvedStageRoot $nsisCandidateName)

$inventory = [ordered]@{
  schemaVersion = 1
  classification = 'UNSIGNED DEVELOPMENT CANDIDATE - DO NOT PUBLISH'
  releaseEligible = $false
  updater = [ordered]@{
    enabled = $false
    artifactsPresent = $false
  }
  webView2 = [ordered]@{
    mode = 'downloadBootstrapper'
    silent = $true
    installTimeNetworkRequiredWhenRuntimeMissing = $true
  }
  installers = [ordered]@{
    msi = [ordered]@{
      installScope = 'perMachine'
      elevationRequired = $true
      upgradeCode = $msiUpgradeCode
      productName = $msiProductName
      productVersion = $msiProductVersion
      artifact = $msiRecord
    }
    nsis = [ordered]@{
      installScope = 'currentUser'
      elevationRequired = $false
      artifact = $nsisRecord
    }
  }
  uninstallDataPolicy = [ordered]@{
    primeSharedDirectory = 'retained'
    roamingAppDataPrimeStudio = 'retained'
    msiIdentifierScopedWebViewData = 'retained'
    nsisIdentifierScopedWebViewData = 'retained by default; removable only through the explicit uninstall checkbox'
  }
}

$inventoryPath = Join-Path $resolvedStageRoot 'windows-unsigned-candidate.inventory.json'
$inventoryJson = $inventory | ConvertTo-Json -Depth 8
$utf8WithoutBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($inventoryPath, $inventoryJson, $utf8WithoutBom)
Write-Output "Unsigned candidate inventory written to $inventoryPath"
