from pathlib import Path


def replace_once(text: str, before: str, after: str, label: str) -> str:
    count = text.count(before)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    return text.replace(before, after)


module_path = Path("app/scripts/windows-host-verification/WindowsHostVerification.psm1")
module = module_path.read_text(encoding="utf-8")

module = replace_once(
    module,
    """  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $pathFull = [IO.Path]::GetFullPath($Path)
  $rootUri = New-Object System.Uri(($rootFull + [IO.Path]::DirectorySeparatorChar))
  $pathUri = New-Object System.Uri($pathFull)
  $relative = [Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString()).Replace('/', [IO.Path]::DirectorySeparatorChar)
  if ([IO.Path]::IsPathRooted($relative) -or $relative -eq '..' -or $relative.StartsWith(('..' + [IO.Path]::DirectorySeparatorChar), [StringComparison]::Ordinal)) {
    throw 'Evidence path escaped its declared root.'
  }
  return $relative
""",
    """  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $pathFull = [IO.Path]::GetFullPath($Path)
  $rootPrefix = $rootFull + [IO.Path]::DirectorySeparatorChar
  $comparison = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    [StringComparison]::OrdinalIgnoreCase
  }
  else {
    [StringComparison]::Ordinal
  }
  if (-not $pathFull.StartsWith($rootPrefix, $comparison)) {
    throw 'Evidence path escaped its declared root.'
  }
  $relative = $pathFull.Substring($rootPrefix.Length)
  if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative) -or $relative -eq '..' -or $relative.StartsWith(('..' + [IO.Path]::DirectorySeparatorChar), [StringComparison]::Ordinal)) {
    throw 'Evidence path escaped its declared root.'
  }
  return $relative
""",
    "literal relative path identity",
)

module = replace_once(
    module,
    """function Get-BoundedLogText {
  param(
    [AllowEmptyString()][string]$Text,
    [int]$MaxCodeUnits = 2 * 1024 * 1024
  )

  if ($null -eq $Text) { return '' }
  if ($Text.Length -le $MaxCodeUnits) { return $Text }
  $marker = "`n<LOG_TRUNCATED>`n"
  $budget = $MaxCodeUnits - $marker.Length
  $head = [Math]::Floor($budget / 2)
  $tail = $budget - $head
  return $Text.Substring(0, $head) + $marker + $Text.Substring($Text.Length - $tail)
}

function Invoke-BoundedExternalCommand {
""",
    """function Get-BoundedLogText {
  param(
    [AllowEmptyString()][string]$Text,
    [int]$MaxCodeUnits = 2 * 1024 * 1024
  )

  if ($null -eq $Text) { return '' }
  if ($Text.Length -le $MaxCodeUnits) { return $Text }
  $marker = "`n<LOG_TRUNCATED>`n"
  $budget = $MaxCodeUnits - $marker.Length
  $head = [Math]::Floor($budget / 2)
  $tail = $budget - $head
  return $Text.Substring(0, $head) + $marker + $Text.Substring($Text.Length - $tail)
}

function Get-SafeObservationText {
  param(
    [AllowNull()][AllowEmptyString()][string]$Text,
    [int]$MaxCodeUnits = 4096
  )

  if ($null -eq $Text) { return $null }
  $withoutControls = [regex]::Replace($Text, '[\u0000-\u001f\u007f-\u009f]', ' ')
  return (Get-BoundedLogText -Text $withoutControls.Trim() -MaxCodeUnits $MaxCodeUnits)
}

function Invoke-BoundedExternalCommand {
""",
    "schema-safe observation text",
)

module = replace_once(
    module,
    """    return [pscustomobject]@{
      Status = $status
      ExitCode = if ($completed) { $process.ExitCode } else { $null }
      DurationMs = [int64]$stopwatch.ElapsedMilliseconds
      Output = $protected.Content
      ExecutablePath = $protectedPath
      ExecutableSha256 = $executableHash
      CommandLine = $protectedCommand.Content
    }
  }
  finally {
""",
    """    return [pscustomobject]@{
      Status = $status
      ExitCode = if ($completed) { $process.ExitCode } else { $null }
      DurationMs = [int64]$stopwatch.ElapsedMilliseconds
      Output = $protected.Content
      ExecutablePath = Get-SafeObservationText -Text $protectedPath
      ExecutableSha256 = $executableHash
      CommandLine = Get-SafeObservationText -Text $protectedCommand.Content
    }
  }
  catch {
    $message = if ($null -ne $_.Exception -and -not [string]::IsNullOrWhiteSpace($_.Exception.Message)) {
      $_.Exception.Message
    }
    else {
      'The external command failed before an exit code was available.'
    }
    $protectedFailure = Protect-WindowsHostEvidenceText -Text (Get-BoundedLogText -Text $message) -RepositoryRoot $RepositoryRoot -UserProfileRoot $UserProfileRoot -TempRoot $TempRoot
    $commandLine = ($Command + ' ' + ($Arguments -join ' ')).Trim()
    $protectedCommand = Protect-WindowsHostEvidenceText -Text $commandLine -RepositoryRoot $RepositoryRoot -UserProfileRoot $UserProfileRoot -TempRoot $TempRoot
    $executableHash = if (Test-Path -LiteralPath $path -PathType Leaf) {
      try { Get-Sha256 -Path $path } catch { $null }
    }
    else { $null }
    $protectedPath = if (Test-Path -LiteralPath $path -PathType Leaf) {
      try { (Protect-WindowsHostEvidenceText -Text ([IO.Path]::GetFullPath($path)) -RepositoryRoot $RepositoryRoot -UserProfileRoot $UserProfileRoot -TempRoot $TempRoot).Content } catch { $null }
    }
    else { $null }
    return [pscustomobject]@{
      Status = 'failed'
      ExitCode = $null
      DurationMs = [int64]$stopwatch.ElapsedMilliseconds
      Output = $protectedFailure.Content
      ExecutablePath = Get-SafeObservationText -Text $protectedPath
      ExecutableSha256 = $executableHash
      CommandLine = Get-SafeObservationText -Text $protectedCommand.Content
    }
  }
  finally {
""",
    "external command failure evidence",
)

module = replace_once(
    module,
    """    $versionLine = @($result.Output -split "`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)
    return [ordered]@{
      status = if ($result.Status -eq 'passed') { 'available' } else { $result.Status }
      command = $candidate
      version = if ($versionLine.Count -eq 1) { $versionLine[0].Trim() } else { $null }
      path = $result.ExecutablePath
""",
    """    $versionLine = @($result.Output -split "`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)
    return [ordered]@{
      status = if ($result.Status -eq 'passed') { 'available' } else { $result.Status }
      command = $candidate
      version = if ($versionLine.Count -eq 1) { Get-SafeObservationText -Text $versionLine[0] } else { $null }
      path = Get-SafeObservationText -Text $result.ExecutablePath
""",
    "bounded tool version and path",
)

module_path.write_text(module, encoding="utf-8", newline="\n")


test_path = Path("app/scripts/windows-host-verification/Test-WindowsHostVerificationKit.ps1")
test = test_path.read_text(encoding="utf-8")

test = replace_once(
    test,
    """  [IO.File]::WriteAllText((Join-Path $inputRoot 'safe.md'), '# Safe evidence', (New-Object Text.UTF8Encoding($false)))
  $privateFileName = "$email.log"
""",
    """  [IO.File]::WriteAllText((Join-Path $inputRoot 'safe.md'), '# Safe evidence', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'percent%41.log'), 'literal percent path', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $inputRoot 'percentA.log'), 'literal A path', (New-Object Text.UTF8Encoding($false)))
  $privateFileName = "$email.log"
""",
    "literal percent path fixtures",
)

test = replace_once(
    test,
    """  $expandingEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'expanding.log'

  $redactedPlain = [IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $plainEntry))
""",
    """  $expandingEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'expanding.log'
  $percentEncodedEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'percent%41.log'
  $percentLiteralEntry = Get-ManifestEntryForRelativePath -Manifest $manifest -RelativePath 'percentA.log'
  Assert-True -Condition ($percentEncodedEntry.sourcePathSha256 -ne $percentLiteralEntry.sourcePathSha256) -Message 'Literal percent sequences were decoded while deriving evidence identity.'

  $redactedPlain = [IO.File]::ReadAllText((Get-BundledEvidencePath -BundleRoot $bundleA -Entry $plainEntry))
""",
    "literal percent identity assertion",
)

test = replace_once(
    test,
    """  $preflight = Invoke-WindowsHostPreflightCollection -RepositoryRoot $repositoryRoot -OutputRoot $preflightRoot
  Assert-True -Condition $preflight.Success -Message 'Preflight without source checks should complete.'
""",
    """  $module = Get-Module WindowsHostVerification
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
""",
    "private command failure and schema-bound tests",
)

test_path.write_text(test, encoding="utf-8", newline="\n")


node_path = Path("tests/windows-host-verification-kit.test.mjs")
node = node_path.read_text(encoding="utf-8")
node = replace_once(
    node,
    """  assert.match(moduleSource, /function Get-TextSha256/u);
  assert.match(moduleSource, /Evidence input root must not be a reparse point/u);
""",
    """  assert.match(moduleSource, /function Get-TextSha256/u);
  assert.match(moduleSource, /function Get-SafeObservationText/u);
  assert.doesNotMatch(moduleSource, /UnescapeDataString|MakeRelativeUri/u);
  assert.match(moduleSource, /Substring\(\$rootPrefix\.Length\)/u);
  assert.match(moduleSource, /catch \{[\s\S]*Status = 'failed'[\s\S]*ExitCode = \$null/u);
  assert.match(moduleSource, /version = if \(\$versionLine\.Count -eq 1\) \{ Get-SafeObservationText/u);
  assert.match(moduleSource, /Evidence input root must not be a reparse point/u);
""",
    "final source hardening contract",
)
node_path.write_text(node, encoding="utf-8", newline="\n")


docs_path = Path("docs/windows-host-verification.md")
docs = docs_path.read_text(encoding="utf-8")
docs = replace_once(
    docs,
    """- executable path after path redaction and SHA-256 when a concrete executable is available;
- version-command status for Node, npm, Rust, Cargo, Git, and the first available reviewed Prime
  command candidate.
""",
    """- executable path after path redaction and SHA-256 when a concrete executable is available;
- bounded, control-free version-command status for Node, npm, Rust, Cargo, Git, and the first
  available reviewed Prime command candidate;
- command-start failures as explicit failed observations with no invented exit code, rather than
  aborting or silently skipping the rest of collection.
""",
    "docs command failure evidence",
)
docs = replace_once(
    docs,
    """  ordinal plus a SHA-256-derived source-path pseudonym, preventing filenames from leaking personal
  data, credentials, reserved device names, or excessive path length;
""",
    """  ordinal plus a SHA-256-derived source-path pseudonym, preventing filenames from leaking personal
  data, credentials, reserved device names, or excessive path length; source-path identity is
  derived from literal canonical path text without URI decoding, so `%xx` filename sequences remain
  distinct;
""",
    "docs literal path identity",
)
docs_path.write_text(docs, encoding="utf-8", newline="\n")

print("patched final Windows host failure, path, and schema boundaries")
