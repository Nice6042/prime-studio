Set-StrictMode -Version Latest

$script:EvidenceClassification = 'HOST_COLLECTED_UNREVIEWED'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
$script:MaxEvidenceFileBytes = 2 * 1024 * 1024
$script:MaxEvidenceBundleBytes = 32 * 1024 * 1024
$script:MaxEvidenceEntries = 4096
$script:AllowedEvidenceExtensions = @('.txt', '.json', '.xml', '.csv', '.md', '.log')
$script:IdentityFiles = @(
  'app/package.json',
  'app/package-lock.json',
  'app/src-tauri/Cargo.toml',
  'app/src-tauri/Cargo.lock',
  'app/src-tauri/tauri.conf.json',
  'rust-toolchain.toml'
)

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Content
  )

  $parent = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $parent -Force)
  }
  [IO.File]::WriteAllText($Path, $Content, $script:Utf8NoBom)
}

function Get-Sha256 {
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
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
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
}

function Test-ReparsePointInPath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $current = Get-Item -LiteralPath $Path -Force
  while ($null -ne $current) {
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      return $true
    }
    if ($current.FullName.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) -eq $rootFull) {
      break
    }
    $current = if ($current -is [IO.FileInfo]) { $current.Directory } else { $current.Parent }
  }
  return $false
}

function Get-SafeEvidenceFiles {
  param([Parameter(Mandatory = $true)][string]$Root)

  $rootItem = [IO.DirectoryInfo](Get-Item -LiteralPath $Root -Force)
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Evidence input root must not be a reparse point.'
  }
  $pending = New-Object 'System.Collections.Generic.Queue[System.IO.DirectoryInfo]'
  $files = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]'
  $pending.Enqueue($rootItem)
  while ($pending.Count -gt 0) {
    $directory = $pending.Dequeue()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory.FullName -Force -ErrorAction Stop)) {
      $isReparse = (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
      if ($item.PSIsContainer) {
        if (-not $isReparse) { $pending.Enqueue([IO.DirectoryInfo]$item) }
        continue
      }
      $files.Add([IO.FileInfo]$item)
      if ($files.Count -gt $script:MaxEvidenceEntries) {
        throw "Evidence input exceeds the $($script:MaxEvidenceEntries)-file limit."
      }
    }
  }
  $descriptors = @($files | ForEach-Object {
    $relative = (Get-RelativeEvidencePath -Root $Root -Path $_.FullName).Replace([IO.Path]::DirectorySeparatorChar, '/')
    [pscustomobject]@{ File = $_; PathHash = Get-TextSha256 -Text $relative }
  })
  return @($descriptors | Sort-Object PathHash | ForEach-Object { $_.File })
}

function Add-TextRedaction {
  param(
    [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Pattern,
    [Parameter(Mandatory = $true)][string]$Replacement,
    [Parameter(Mandatory = $true)][ref]$Count,
    [System.Text.RegularExpressions.RegexOptions]$Options = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )

  $regex = New-Object System.Text.RegularExpressions.Regex($Pattern, $Options)
  return $regex.Replace($Text, {
    param($match)
    $Count.Value += 1
    return $match.Result($Replacement)
  })
}

function Protect-ExactPath {
  param(
    [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Text,
    [AllowNull()][string]$Path,
    [Parameter(Mandatory = $true)][string]$Replacement,
    [Parameter(Mandatory = $true)][ref]$Count
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $Text
  }

  $normalized = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  foreach ($candidate in @($normalized, $normalized.Replace('\', '\\'), $normalized.Replace('\', '/'))) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    $Text = Add-TextRedaction -Text $Text -Pattern ([regex]::Escape($candidate)) -Replacement $Replacement -Count $Count
  }
  return $Text
}

function Protect-WindowsHostEvidenceText {
  [CmdletBinding()]
  param(
    [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Text,
    [AllowNull()][string]$RepositoryRoot,
    [AllowNull()][string]$UserProfileRoot,
    [AllowNull()][string]$TempRoot
  )

  $count = 0
  $countRef = [ref]$count
  $protected = $Text
  if ($protected.Length -eq 0) {
    return [pscustomobject]@{ Content = ''; Redactions = 0 }
  }
  $protected = Protect-ExactPath -Text $protected -Path $RepositoryRoot -Replacement '<REPOSITORY_ROOT>' -Count $countRef
  $protected = Protect-ExactPath -Text $protected -Path $TempRoot -Replacement '<TEMP>' -Count $countRef
  $protected = Protect-ExactPath -Text $protected -Path $UserProfileRoot -Replacement '<USER_PROFILE>' -Count $countRef

  $protected = Add-TextRedaction -Text $protected -Pattern '(?im)^\s*(authorization|proxy-authorization)\s*:\s*.*$' -Replacement '$1: <REDACTED>' -Count $countRef -Options ([System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::Multiline)
  $protected = Add-TextRedaction -Text $protected -Pattern '(?im)^\s*(cookie|set-cookie)\s*:\s*.*$' -Replacement '$1: <REDACTED>' -Count $countRef -Options ([System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::Multiline)
  $protected = Add-TextRedaction -Text $protected -Pattern '(?is)-----BEGIN (?<kind>(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----.*?-----END \k<kind>-----' -Replacement '<REDACTED_PRIVATE_KEY_BLOCK>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)(?<q>["''])(?<key>[A-Za-z0-9_.-]*(?:authorization|token|secret|password|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie|signingkey))\k<q>\s*:\s*(?:"(?:\\.|[^"])*"|''(?:\\.|[^''])*''|[^,\r\n}\]]+)' -Replacement '${q}${key}${q}: "<REDACTED>"' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?is)<(?<tag>[A-Za-z_][A-Za-z0-9_.:-]*(?:authorization|token|secret|password|passphrase|apikey|accesskey|privatekey|credential|cookie|signingkey))\b(?<attrs>[^>]*)>.*?</\k<tag>\s*>' -Replacement '<${tag}${attrs}><REDACTED></${tag}>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\b([A-Za-z0-9_.-]*(?:authorization|token|secret|password|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie)[A-Za-z0-9_.-]*)\b\s*[:=]\s*(?:"[^"]*"|''[^'']*''|[^\s,;]+)' -Replacement '$1=<REDACTED>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+\-/=]{12,}' -Replacement '<REDACTED_AUTH>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\bhttps?://[^/\s:@]+:[^/\s@]+@' -Replacement 'https://<REDACTED_URI_CREDENTIALS>@' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\bgh[pousr]_[A-Za-z0-9_]{20,}\b' -Replacement '<REDACTED_GITHUB_TOKEN>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\bgithub_pat_[A-Za-z0-9_]{20,}\b' -Replacement '<REDACTED_GITHUB_TOKEN>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\bxox[baprs]-[A-Za-z0-9-]{10,}\b' -Replacement '<REDACTED_SLACK_TOKEN>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\bglpat-[A-Za-z0-9_-]{20,}\b' -Replacement '<REDACTED_COLLABORATION_TOKEN>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\bnpm_[A-Za-z0-9]{20,}\b' -Replacement '<REDACTED_PACKAGE_TOKEN>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\bhf_[A-Za-z0-9]{20,}\b' -Replacement '<REDACTED_PROVIDER_KEY>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b' -Replacement '<REDACTED_PROVIDER_KEY>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '\bAIza[0-9A-Za-z_-]{30,}\b' -Replacement '<REDACTED_PROVIDER_KEY>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '\bA(?:KIA|SIA)[A-Z0-9]{16}\b' -Replacement '<REDACTED_ACCESS_KEY>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b' -Replacement '<REDACTED_JWT>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b' -Replacement '<EMAIL_REDACTED>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\b[A-Z]:\\Users\\[^\\\s"'']+' -Replacement '<USER_PROFILE>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\b[A-Z]:\\\\Users\\\\[^\\\s"'']+' -Replacement '<USER_PROFILE>' -Count $countRef

  $protected = $protected.Replace("`r`n", "`n").Replace("`r", "`n")
  return [pscustomobject]@{
    Content = $protected
    Redactions = $count
  }
}

function Test-SecretPropertyName {
  param([Parameter(Mandatory = $true)][string]$Name)

  $normalized = ($Name -replace '[^A-Za-z0-9]', '').ToLowerInvariant()
  if ($normalized -in @(
    'authorization', 'proxyauthorization', 'cookie', 'setcookie',
    'token', 'accesstoken', 'refreshtoken', 'idtoken',
    'secret', 'clientsecret', 'password', 'passphrase',
    'apikey', 'accesskey', 'privatekey', 'credential', 'credentials',
    'sessionkey', 'signingkey'
  )) { return $true }

  return $normalized -match '(?:authorization|token|secret|password|passphrase|apikey|accesskey|privatekey|credential|cookie|signingkey)$'
}

function Protect-JsonNode {
  param(
    [AllowNull()]$Node,
    [Parameter(Mandatory = $true)][ref]$Count
  )

  if ($null -eq $Node) { return $null }
  if ($Node -is [string]) { return $Node }
  if ($Node -is [System.Collections.IDictionary]) {
    $copy = [ordered]@{}
    foreach ($key in $Node.Keys) {
      $name = [string]$key
      if (Test-SecretPropertyName -Name $name) {
        $copy[$name] = '<REDACTED>'
        $Count.Value += 1
      }
      else {
        $copy[$name] = Protect-JsonNode -Node $Node[$key] -Count $Count
      }
    }
    return $copy
  }
  if ($Node -is [pscustomobject]) {
    $copy = [ordered]@{}
    foreach ($property in $Node.PSObject.Properties) {
      if (Test-SecretPropertyName -Name $property.Name) {
        $copy[$property.Name] = '<REDACTED>'
        $Count.Value += 1
      }
      else {
        $copy[$property.Name] = Protect-JsonNode -Node $property.Value -Count $Count
      }
    }
    return $copy
  }
  if ($Node -is [System.Collections.IEnumerable] -and -not ($Node -is [string])) {
    $items = @($Node | ForEach-Object { Protect-JsonNode -Node $_ -Count $Count })
    return ,$items
  }
  return $Node
}

function Protect-WindowsHostEvidenceJson {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Value,
    [AllowNull()][string]$RepositoryRoot,
    [AllowNull()][string]$UserProfileRoot,
    [AllowNull()][string]$TempRoot
  )

  $count = 0
  $sanitized = Protect-JsonNode -Node $Value -Count ([ref]$count)
  $json = $sanitized | ConvertTo-Json -Depth 64
  $text = Protect-WindowsHostEvidenceText -Text $json -RepositoryRoot $RepositoryRoot -UserProfileRoot $UserProfileRoot -TempRoot $TempRoot
  return [pscustomobject]@{
    Content = $text.Content
    Redactions = $count + $text.Redactions
  }
}

function Read-EvidenceTextFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -eq 0) {
    return [pscustomobject]@{ IsText = $true; Content = ''; Size = 0 }
  }

  try {
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) {
      $content = $script:Utf8Strict.GetString($bytes, 3, $bytes.Length - 3)
    }
    elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xff -and $bytes[1] -eq 0xfe) {
      $content = [Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
    }
    elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xfe -and $bytes[1] -eq 0xff) {
      $content = [Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $bytes.Length - 2)
    }
    else {
      $content = $script:Utf8Strict.GetString($bytes)
    }
  }
  catch {
    return [pscustomobject]@{ IsText = $false; Content = $null; Size = $bytes.Length }
  }

  if ($content.IndexOf([char]0) -ge 0) {
    return [pscustomobject]@{ IsText = $false; Content = $null; Size = $bytes.Length }
  }
  return [pscustomobject]@{ IsText = $true; Content = $content; Size = $bytes.Length }
}

function Assert-NoHighRiskEvidenceResidue {
  param([AllowEmptyString()][Parameter(Mandatory = $true)][string]$Text)

  $patterns = @(
    '(?im)^\s*(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*(?!<REDACTED>)',
    '(?i)\bgh[pousr]_[A-Za-z0-9_]{20,}\b',
    '(?i)\bgithub_pat_[A-Za-z0-9_]{20,}\b',
    '(?i)\bxox[baprs]-[A-Za-z0-9-]{10,}\b',
    '(?i)\bglpat-[A-Za-z0-9_-]{20,}\b',
    '(?i)\bnpm_[A-Za-z0-9]{20,}\b',
    '(?i)\bhf_[A-Za-z0-9]{20,}\b',
    '(?i)\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b',
    '(?i)\bhttps?://[^/\s:@]+:[^/\s@]+@',
    '\bA(?:KIA|SIA)[A-Z0-9]{16}\b',
    '(?is)-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----',
    '\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b',
    '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b'
  )
  foreach ($pattern in $patterns) {
    if ([regex]::IsMatch($Text, $pattern)) {
      throw 'Redacted evidence still contains a high-risk credential or identity pattern.'
    }
  }
}

function New-WindowsHostEvidenceBundle {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$InputRoot,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [AllowNull()][string]$RepositoryRoot,
    [AllowNull()][string]$UserProfileRoot = $env:USERPROFILE,
    [AllowNull()][string]$TempRoot = $env:TEMP
  )

  $inputFull = [IO.Path]::GetFullPath($InputRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $outputFull = [IO.Path]::GetFullPath($OutputRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if (-not (Test-Path -LiteralPath $inputFull -PathType Container)) {
    throw "Evidence input root does not exist: $inputFull"
  }
  if ($outputFull.StartsWith(($inputFull + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Evidence output must not be nested inside the input root.'
  }
  if (Test-Path -LiteralPath $outputFull) {
    throw "Evidence output root already exists: $outputFull"
  }

  $outputParent = Split-Path -Parent $outputFull
  if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) { [void](New-Item -ItemType Directory -Path $outputParent -Force) }
  $stage = $outputFull + '.staging-' + [Guid]::NewGuid().ToString('N')
  [void](New-Item -ItemType Directory -Path $stage)
  $entries = New-Object System.Collections.Generic.List[object]
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

      $decoded = Read-EvidenceTextFile -Path $file.FullName
      if (-not $decoded.IsText) {
        $entry = [ordered]@{
          path = $base.path
          sourcePathSha256 = $base.sourcePathSha256
          sourceSize = $base.sourceSize
          sourceSha256 = $base.sourceSha256
          status = 'excluded'
          reason = 'binary_content'
        }
        $entries.Add([pscustomobject]$entry)
        continue
      }

      if ($file.Extension.ToLowerInvariant() -eq '.json') {
        try {
          $parsed = $decoded.Content | ConvertFrom-Json -ErrorAction Stop
          $protected = Protect-WindowsHostEvidenceJson -Value $parsed -RepositoryRoot $RepositoryRoot -UserProfileRoot $UserProfileRoot -TempRoot $TempRoot
        }
        catch {
          $protected = Protect-WindowsHostEvidenceText -Text $decoded.Content -RepositoryRoot $RepositoryRoot -UserProfileRoot $UserProfileRoot -TempRoot $TempRoot
        }
      }
      else {
        $protected = Protect-WindowsHostEvidenceText -Text $decoded.Content -RepositoryRoot $RepositoryRoot -UserProfileRoot $UserProfileRoot -TempRoot $TempRoot
      }

      Assert-NoHighRiskEvidenceResidue -Text $protected.Content
      $outputBytes = $script:Utf8NoBom.GetByteCount($protected.Content)
      if ($outputBytes -gt $script:MaxEvidenceFileBytes) {
        $entry = [ordered]@{
          path = $base.path
          sourcePathSha256 = $base.sourcePathSha256
          sourceSize = $base.sourceSize
          sourceSha256 = $base.sourceSha256
          status = 'excluded'
          reason = 'redacted_file_too_large'
        }
        $entries.Add([pscustomobject]$entry)
        continue
      }
      if (($includedBytes + $outputBytes) -gt $script:MaxEvidenceBundleBytes) {
        $entry = [ordered]@{
          path = $base.path
          sourcePathSha256 = $base.sourcePathSha256
          sourceSize = $base.sourceSize
          sourceSha256 = $base.sourceSha256
          status = 'excluded'
          reason = 'bundle_budget_exceeded'
        }
        $entries.Add([pscustomobject]$entry)
        continue
      }

      $destination = Join-Path $stage ($base.path.Replace('/', [IO.Path]::DirectorySeparatorChar))
      Write-Utf8NoBom -Path $destination -Content $protected.Content
      $includedBytes += $outputBytes
      $entry = [ordered]@{
        path = $base.path
        sourcePathSha256 = $base.sourcePathSha256
        sourceSize = $base.sourceSize
        sourceSha256 = $base.sourceSha256
        status = 'included'
        bundledSize = [int64](Get-Item -LiteralPath $destination).Length
        bundledSha256 = Get-Sha256 -Path $destination
        redactions = [int]$protected.Redactions
      }
      $entries.Add([pscustomobject]$entry)
    }

    $manifest = [ordered]@{
      schemaVersion = '1'
      classification = $script:EvidenceClassification
      releaseEligible = $false
      limits = [ordered]@{
        allowedExtensions = @($script:AllowedEvidenceExtensions)
        maxFileBytes = $script:MaxEvidenceFileBytes
        maxBundleBytes = $script:MaxEvidenceBundleBytes
        maxEntries = $script:MaxEvidenceEntries
      }
      files = $entries.ToArray()
    }
    $manifestJson = $manifest | ConvertTo-Json -Depth 16
    foreach ($forbiddenPath in @($inputFull, $outputFull)) {
      foreach ($candidate in @($forbiddenPath, $forbiddenPath.Replace('\', '\\'), $forbiddenPath.Replace('\', '/'))) {
        if ($manifestJson.IndexOf($candidate, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
          throw 'Evidence manifest leaked an absolute input or output path.'
        }
      }
    }
    Write-Utf8NoBom -Path (Join-Path $stage 'bundle-manifest.json') -Content $manifestJson
    Move-Item -LiteralPath $stage -Destination $outputFull
  }
  catch {
    if (Test-Path -LiteralPath $stage) {
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
  }

  return [pscustomobject]@{
    OutputRoot = $outputFull
    ManifestPath = Join-Path $outputFull 'bundle-manifest.json'
    IncludedFiles = @($entries | Where-Object { $_.status -eq 'included' }).Count
    ExcludedFiles = @($entries | Where-Object { $_.status -eq 'excluded' }).Count
  }
}

function ConvertTo-WindowsCommandLineArgument {
  param([Parameter(Mandatory = $true)][string]$Argument)

  if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') {
    return $Argument
  }
  $builder = New-Object Text.StringBuilder
  [void]$builder.Append('"')
  $slashes = 0
  foreach ($character in $Argument.ToCharArray()) {
    if ($character -eq '\') {
      $slashes += 1
      continue
    }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * (($slashes * 2) + 1)))
      [void]$builder.Append('"')
      $slashes = 0
      continue
    }
    if ($slashes -gt 0) {
      [void]$builder.Append(('\' * $slashes))
      $slashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($slashes -gt 0) {
    [void]$builder.Append(('\' * ($slashes * 2)))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Get-BoundedLogText {
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
  $withoutControls = [regex]::Replace($Text, '[ --]', ' ')
  return (Get-BoundedLogText -Text $withoutControls.Trim() -MaxCodeUnits $MaxCodeUnits)
}

function Invoke-BoundedExternalCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [int]$TimeoutSeconds = 30,
    [AllowNull()][string]$RepositoryRoot,
    [AllowNull()][string]$UserProfileRoot,
    [AllowNull()][string]$TempRoot
  )

  $resolved = Get-Command $Command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $resolved) {
    return [pscustomobject]@{
      Status = 'unavailable'
      ExitCode = $null
      DurationMs = 0
      Output = ''
      ExecutablePath = $null
      ExecutableSha256 = $null
      CommandLine = $Command
    }
  }

  $path = if ($resolved.PSObject.Properties.Name -contains 'Source' -and -not [string]::IsNullOrWhiteSpace([string]$resolved.Source)) { [string]$resolved.Source } elseif ($resolved.PSObject.Properties.Name -contains 'Path' -and -not [string]::IsNullOrWhiteSpace([string]$resolved.Path)) { [string]$resolved.Path } else { [string]$resolved.Definition }
  $argumentText = (($Arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument -Argument $_ }) -join ' ')
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  if ([IO.Path]::GetExtension($path) -in @('.cmd', '.bat')) {
    $startInfo.FileName = $env:ComSpec
    $innerCommand = '"' + $path + '"'
    if (-not [string]::IsNullOrWhiteSpace($argumentText)) { $innerCommand += ' ' + $argumentText }
    $startInfo.Arguments = '/d /s /c "' + $innerCommand + '"'
  }
  else {
    $startInfo.FileName = $path
    $startInfo.Arguments = $argumentText
  }
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = New-Object Diagnostics.Process
  $process.StartInfo = $startInfo
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  try {
    if (-not $process.Start()) {
      throw "Could not start $Command."
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $completed = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $completed) {
      try {
        $taskKill = Get-Command 'taskkill.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $taskKill) {
          [void](& $taskKill.Source /PID $process.Id /T /F 2>$null)
        }
        else { $process.Kill() }
      }
      catch { try { $process.Kill() } catch { } }
      [void]$process.WaitForExit(5000)
    }
    $stdoutCompleted = $false
    $stderrCompleted = $false
    try { $stdoutCompleted = $stdoutTask.Wait(5000) } catch { }
    try { $stderrCompleted = $stderrTask.Wait(5000) } catch { }
    $stdout = if ($stdoutCompleted -and -not $stdoutTask.IsFaulted) { $stdoutTask.Result } else { '<STDOUT_CAPTURE_INCOMPLETE>' }
    $stderr = if ($stderrCompleted -and -not $stderrTask.IsFaulted) { $stderrTask.Result } else { '<STDERR_CAPTURE_INCOMPLETE>' }
    $output = ($stdout + "`n" + $stderr).Trim()
    $output = Get-BoundedLogText -Text $output
    $protected = Protect-WindowsHostEvidenceText -Text $output -RepositoryRoot $RepositoryRoot -UserProfileRoot $UserProfileRoot -TempRoot $TempRoot
    $commandLine = ($Command + ' ' + ($Arguments -join ' ')).Trim()
    $protectedCommand = Protect-WindowsHostEvidenceText -Text $commandLine -RepositoryRoot $RepositoryRoot -UserProfileRoot $UserProfileRoot -TempRoot $TempRoot
    $status = if (-not $completed) { 'timed_out' } elseif ($process.ExitCode -eq 0) { 'passed' } else { 'failed' }
    $executableHash = if (Test-Path -LiteralPath $path -PathType Leaf) { Get-Sha256 -Path $path } else { $null }
    $protectedPath = if (Test-Path -LiteralPath $path -PathType Leaf) {
      (Protect-WindowsHostEvidenceText -Text ([IO.Path]::GetFullPath($path)) -RepositoryRoot $RepositoryRoot -UserProfileRoot $UserProfileRoot -TempRoot $TempRoot).Content
    }
    else { $null }
    return [pscustomobject]@{
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
    $stopwatch.Stop()
    $process.Dispose()
  }
}

function Get-ToolObservation {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string[]]$Candidates,
    [string[]]$VersionArguments = @('--version'),
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [AllowNull()][string]$RepositoryRoot,
    [AllowNull()][string]$UserProfileRoot,
    [AllowNull()][string]$TempRoot
  )

  foreach ($candidate in $Candidates) {
    $result = Invoke-BoundedExternalCommand -Command $candidate -Arguments $VersionArguments -WorkingDirectory $WorkingDirectory -TimeoutSeconds 15 -RepositoryRoot $RepositoryRoot -UserProfileRoot $UserProfileRoot -TempRoot $TempRoot
    if ($result.Status -eq 'unavailable') { continue }
    $versionLine = @($result.Output -split "`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)
    return [ordered]@{
      status = if ($result.Status -eq 'passed') { 'available' } else { $result.Status }
      command = $candidate
      version = if ($versionLine.Count -eq 1) { Get-SafeObservationText -Text $versionLine[0] } else { $null }
      path = Get-SafeObservationText -Text $result.ExecutablePath
      sha256 = $result.ExecutableSha256
      exitCode = $result.ExitCode
      candidates = @($Candidates)
    }
  }

  return [ordered]@{
    status = 'unavailable'
    command = $Name
    version = $null
    path = $null
    sha256 = $null
    exitCode = $null
    candidates = @($Candidates)
  }
}

function Get-WebView2Observation {
  param(
    [AllowNull()][string]$RepositoryRoot,
    [AllowNull()][string]$UserProfileRoot,
    [AllowNull()][string]$TempRoot
  )

  $records = New-Object System.Collections.Generic.List[object]
  foreach ($registryRoot in @(
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients'
  )) {
    if (-not (Test-Path -LiteralPath $registryRoot)) { continue }
    foreach ($child in @(Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue)) {
      try {
        $item = Get-ItemProperty -LiteralPath $child.PSPath -ErrorAction Stop
        $nameProperty = $item.PSObject.Properties['name']
        $displayProperty = $item.PSObject.Properties['DisplayName']
        $displayName = if ($null -ne $nameProperty) { [string]$nameProperty.Value } elseif ($null -ne $displayProperty) { [string]$displayProperty.Value } else { '' }
        if ($displayName -notmatch 'WebView2') { continue }
        $pvProperty = $item.PSObject.Properties['pv']
        $versionProperty = $item.PSObject.Properties['version']
        $version = if ($null -ne $pvProperty) { [string]$pvProperty.Value } elseif ($null -ne $versionProperty) { [string]$versionProperty.Value } else { '' }
        $records.Add([pscustomobject]@{ Version = $version; Path = $null })
      }
      catch { }
    }
  }

  $webViewRoots = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) { $webViewRoots.Add((Join-Path ${env:ProgramFiles(x86)} 'Microsoft\EdgeWebView\Application')) }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { $webViewRoots.Add((Join-Path $env:LOCALAPPDATA 'Microsoft\EdgeWebView\Application')) }
  foreach ($base in $webViewRoots) {
    if ([string]::IsNullOrWhiteSpace($base) -or -not (Test-Path -LiteralPath $base -PathType Container)) { continue }
    foreach ($executable in @(Get-ChildItem -LiteralPath $base -Recurse -Filter 'msedgewebview2.exe' -File -ErrorAction SilentlyContinue)) {
      $version = $executable.VersionInfo.FileVersion
      $records.Add([pscustomobject]@{ Version = $version; Path = $executable.FullName })
    }
  }

  $selected = @($records | Sort-Object { try { [Version]$_.Version } catch { [Version]'0.0' } } -Descending | Select-Object -First 1)
  if ($selected.Count -eq 0) {
    return [ordered]@{ status = 'unavailable'; version = $null; path = $null; sha256 = $null }
  }
  $path = $selected[0].Path
  return [ordered]@{
    status = 'available'
    version = if ([string]::IsNullOrWhiteSpace($selected[0].Version)) { $null } else { $selected[0].Version }
    path = if ([string]::IsNullOrWhiteSpace($path)) { $null } else { (Protect-WindowsHostEvidenceText -Text $path -RepositoryRoot $RepositoryRoot -UserProfileRoot $UserProfileRoot -TempRoot $TempRoot).Content }
    sha256 = if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path -LiteralPath $path -PathType Leaf)) { Get-Sha256 -Path $path } else { $null }
  }
}

function Get-GitOutput {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $result = Invoke-BoundedExternalCommand -Command 'git' -Arguments $Arguments -WorkingDirectory $RepositoryRoot -TimeoutSeconds 20 -RepositoryRoot $RepositoryRoot -UserProfileRoot $env:USERPROFILE -TempRoot $env:TEMP
  if ($result.Status -ne 'passed') {
    throw "Git command failed: git $($Arguments -join ' ')"
  }
  return $result.Output.Trim()
}

function Get-WindowsHostSourceIdentity {
  param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

  $commit = Get-GitOutput -RepositoryRoot $RepositoryRoot -Arguments @('rev-parse', 'HEAD')
  if ($commit -notmatch '^[A-Fa-f0-9]{40}$') {
    throw 'Repository commit identity is not a 40-character Git object ID.'
  }
  $branch = Get-GitOutput -RepositoryRoot $RepositoryRoot -Arguments @('branch', '--show-current')
  if ([string]::IsNullOrWhiteSpace($branch)) {
    $branch = if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_REF_NAME)) { $env:GITHUB_REF_NAME } else { 'DETACHED' }
  }
  $status = Get-GitOutput -RepositoryRoot $RepositoryRoot -Arguments @('status', '--porcelain=v1', '--untracked-files=normal')
  $changedEntries = if ([string]::IsNullOrWhiteSpace($status)) { 0 } else { @($status -split "`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count }

  $files = foreach ($relative in $script:IdentityFiles) {
    $path = Join-Path $RepositoryRoot $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Required identity file is missing: $relative"
    }
    [ordered]@{
      path = $relative
      size = [int64](Get-Item -LiteralPath $path).Length
      sha256 = Get-Sha256 -Path $path
    }
  }

  return [ordered]@{
    commit = $commit.ToLowerInvariant()
    branch = $branch
    isClean = ($changedEntries -eq 0)
    changedEntryCount = $changedEntries
    identityFiles = @($files)
  }
}

function Get-HostObservation {
  param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

  $os = $null
  try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch { }
  $processPath = try { (Get-Process -Id $PID).Path } catch { $null }
  $protectedProcessPath = if (-not [string]::IsNullOrWhiteSpace($processPath)) {
    (Protect-WindowsHostEvidenceText -Text $processPath -RepositoryRoot $RepositoryRoot -UserProfileRoot $env:USERPROFILE -TempRoot $env:TEMP).Content
  }
  else { $null }

  return [ordered]@{
    windows = [ordered]@{
      productName = if ($null -ne $os -and -not [string]::IsNullOrWhiteSpace([string]$os.Caption)) { [string]$os.Caption } else { [Environment]::OSVersion.Platform.ToString() }
      version = if ($null -ne $os) { [string]$os.Version } else { [Environment]::OSVersion.Version.ToString() }
      build = if ($null -ne $os) { [string]$os.BuildNumber } else { [Environment]::OSVersion.Version.Build.ToString() }
      architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    powerShell = [ordered]@{
      status = 'available'
      version = $PSVersionTable.PSVersion.ToString()
      edition = if ($PSVersionTable.PSObject.Properties.Name -contains 'PSEdition') { [string]$PSVersionTable.PSEdition } else { 'Desktop' }
      path = $protectedProcessPath
      sha256 = if (-not [string]::IsNullOrWhiteSpace($processPath) -and (Test-Path -LiteralPath $processPath -PathType Leaf)) { Get-Sha256 -Path $processPath } else { $null }
    }
    webView2 = Get-WebView2Observation -RepositoryRoot $RepositoryRoot -UserProfileRoot $env:USERPROFILE -TempRoot $env:TEMP
  }
}

function Invoke-WindowsHostSourceChecks {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$OutputRoot
  )

  $definitions = @(
    [ordered]@{ id = 'npm-ci'; command = 'npm'; arguments = @('ci'); workingDirectory = (Join-Path $RepositoryRoot 'app'); timeoutSeconds = 1800 },
    [ordered]@{ id = 'frontend-tests'; command = 'npm'; arguments = @('test', '--', '--maxWorkers=2', '--no-file-parallelism'); workingDirectory = (Join-Path $RepositoryRoot 'app'); timeoutSeconds = 1800 },
    [ordered]@{ id = 'frontend-build'; command = 'npm'; arguments = @('run', 'build'); workingDirectory = (Join-Path $RepositoryRoot 'app'); timeoutSeconds = 1800 },
    [ordered]@{ id = 'rust-format'; command = 'cargo'; arguments = @('fmt', '--manifest-path', 'app/src-tauri/Cargo.toml', '--all', '--', '--check'); workingDirectory = $RepositoryRoot; timeoutSeconds = 900 },
    [ordered]@{ id = 'rust-clippy'; command = 'cargo'; arguments = @('clippy', '--manifest-path', 'app/src-tauri/Cargo.toml', '--locked', '--all-targets', '--features', 'test-support-bin', '--', '-D', 'warnings'); workingDirectory = $RepositoryRoot; timeoutSeconds = 2700 },
    [ordered]@{ id = 'rust-tests'; command = 'cargo'; arguments = @('test', '--manifest-path', 'app/src-tauri/Cargo.toml', '--locked', '--all-targets', '--features', 'test-support-bin'); workingDirectory = $RepositoryRoot; timeoutSeconds = 2700 },
    [ordered]@{ id = 'rust-build'; command = 'cargo'; arguments = @('build', '--manifest-path', 'app/src-tauri/Cargo.toml', '--locked'); workingDirectory = $RepositoryRoot; timeoutSeconds = 2700 }
  )

  $logsRoot = Join-Path $OutputRoot 'logs'
  [void](New-Item -ItemType Directory -Path $logsRoot -Force)
  $records = New-Object System.Collections.Generic.List[object]
  $failed = $false
  $index = 0
  foreach ($definition in $definitions) {
    $index += 1
    $result = Invoke-BoundedExternalCommand -Command $definition.command -Arguments $definition.arguments -WorkingDirectory $definition.workingDirectory -TimeoutSeconds $definition.timeoutSeconds -RepositoryRoot $RepositoryRoot -UserProfileRoot $env:USERPROFILE -TempRoot $env:TEMP
    $logName = ('source-check-{0:d2}-{1}.log' -f $index, $definition.id)
    $logPath = Join-Path $logsRoot $logName
    Assert-NoHighRiskEvidenceResidue -Text $result.Output
    Write-Utf8NoBom -Path $logPath -Content $result.Output
    $status = if ($result.Status -eq 'passed') { 'passed' } elseif ($result.Status -eq 'timed_out') { 'timed_out' } elseif ($result.Status -eq 'unavailable') { 'unavailable' } else { 'failed' }
    if ($status -ne 'passed') { $failed = $true }
    $records.Add([pscustomobject][ordered]@{
      id = $definition.id
      status = $status
      command = $result.CommandLine
      exitCode = $result.ExitCode
      durationMs = $result.DurationMs
      logPath = ('logs/' + $logName)
      logSha256 = Get-Sha256 -Path $logPath
    })
  }

  return [ordered]@{
    overall = if ($failed) { 'FAILED' } else { 'PASSED' }
    commands = $records.ToArray()
  }
}

function Invoke-WindowsHostPreflightCollection {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [switch]$RunSourceChecks
  )

  $repositoryFull = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $outputFull = [IO.Path]::GetFullPath($OutputRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Windows host preflight collection must run on Windows.'
  }
  if (-not (Test-Path -LiteralPath $repositoryFull -PathType Container)) {
    throw "Repository root does not exist: $repositoryFull"
  }
  if ($outputFull.StartsWith(($repositoryFull + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Preflight output must be outside the repository root.'
  }
  if (Test-Path -LiteralPath $outputFull) {
    throw "Preflight output root already exists: $outputFull"
  }
  [void](New-Item -ItemType Directory -Path $outputFull)

  $sourceIdentity = Get-WindowsHostSourceIdentity -RepositoryRoot $repositoryFull
  $host = Get-HostObservation -RepositoryRoot $repositoryFull
  $toolArguments = @{
    WorkingDirectory = $repositoryFull
    RepositoryRoot = $repositoryFull
    UserProfileRoot = $env:USERPROFILE
    TempRoot = $env:TEMP
  }
  $tools = [ordered]@{
    node = Get-ToolObservation -Name 'node' -Candidates @('node') @toolArguments
    npm = Get-ToolObservation -Name 'npm' -Candidates @('npm.cmd', 'npm') @toolArguments
    rustc = Get-ToolObservation -Name 'rustc' -Candidates @('rustc') @toolArguments
    cargo = Get-ToolObservation -Name 'cargo' -Candidates @('cargo') @toolArguments
    git = Get-ToolObservation -Name 'git' -Candidates @('git') @toolArguments
    prime = Get-ToolObservation -Name 'prime' -Candidates @('prime-agent.cmd', 'prime-agent', 'prime.cmd', 'prime') @toolArguments
  }

  $sourceChecks = if ($RunSourceChecks) {
    Invoke-WindowsHostSourceChecks -RepositoryRoot $repositoryFull -OutputRoot $outputFull
  }
  else {
    [ordered]@{ overall = 'NOT_RUN'; commands = @() }
  }

  $record = [ordered]@{
    schemaVersion = '1'
    collectorVersion = '1'
    classification = $script:EvidenceClassification
    releaseEligible = $false
    reviewState = $script:EvidenceClassification
    collectedAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceIdentity = $sourceIdentity
    host = $host
    tools = $tools
    sourceChecks = $sourceChecks
    claims = [ordered]@{
      sourceBuild = $sourceChecks.overall
      exactPrimeClosure = 'NOT_ATTESTED'
      activation = 'NOT_ATTESTED'
      providerSession = 'NOT_ATTESTED'
      interactionWorker = 'NOT_ATTESTED'
      installerSigning = 'NOT_ATTESTED'
      releaseAuthority = 'NOT_ATTESTED'
    }
  }

  $json = $record | ConvertTo-Json -Depth 32
  foreach ($forbidden in @($repositoryFull, $env:USERPROFILE, $env:TEMP)) {
    if ([string]::IsNullOrWhiteSpace($forbidden)) { continue }
    foreach ($candidate in @($forbidden, $forbidden.Replace('\', '\\'), $forbidden.Replace('\', '/'))) {
      if ($json.IndexOf($candidate, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw 'Preflight record leaked an absolute repository, profile, or temporary path.'
      }
    }
  }
  Assert-NoHighRiskEvidenceResidue -Text $json
  $recordPath = Join-Path $outputFull 'windows-host-preflight.json'
  Write-Utf8NoBom -Path $recordPath -Content $json

  return [pscustomobject]@{
    Success = ($sourceChecks.overall -ne 'FAILED')
    OutputRoot = $outputFull
    RecordPath = $recordPath
    SourceChecks = $sourceChecks.overall
  }
}

Export-ModuleMember -Function @(
  'Protect-WindowsHostEvidenceText',
  'Protect-WindowsHostEvidenceJson',
  'New-WindowsHostEvidenceBundle',
  'Invoke-WindowsHostPreflightCollection'
)
