from pathlib import Path

p = Path('app/scripts/windows-host-verification/WindowsHostVerification.psm1')
text = p.read_text()

def replace_once(before: str, after: str, label: str) -> None:
    global text
    count = text.count(before)
    if count != 1:
        raise SystemExit(f'{label}: expected 1, found {count}')
    text = text.replace(before, after)

replace_once(
"""function Test-ReparsePointInPath {
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
    $current = $current.Parent
  }
  return $false
}
""",
"""function Test-ReparsePointInPath {
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

  $pending = New-Object 'System.Collections.Generic.Queue[System.IO.DirectoryInfo]'
  $files = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]'
  $pending.Enqueue([IO.DirectoryInfo](Get-Item -LiteralPath $Root -Force))
  while ($pending.Count -gt 0) {
    $directory = $pending.Dequeue()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory.FullName -Force -ErrorAction Stop)) {
      $isReparse = (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
      if ($item.PSIsContainer) {
        if (-not $isReparse) { $pending.Enqueue([IO.DirectoryInfo]$item) }
        continue
      }
      $files.Add([IO.FileInfo]$item)
    }
  }
  return @($files | Sort-Object FullName)
}
""",
'reparse traversal',
)

replace_once(
"""  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\b(authorization|token|secret|password|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential|cookie)\\b\\s*[:=]\\s*(?:\"[^\"]*\"|''[^'']*''|[^\\s,;]+)' -Replacement '$1=<REDACTED>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\b(?:bearer|basic)\\s+[A-Za-z0-9._~+\\-/=]{12,}' -Replacement '<REDACTED_AUTH>' -Count $countRef
""",
"""  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\b([A-Za-z0-9_.-]*(?:authorization|token|secret|password|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie)[A-Za-z0-9_.-]*)\\b\\s*[:=]\\s*(?:\"[^\"]*\"|''[^'']*''|[^\\s,;]+)' -Replacement '$1=<REDACTED>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\b(?:bearer|basic)\\s+[A-Za-z0-9._~+\\-/=]{12,}' -Replacement '<REDACTED_AUTH>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?is)-----BEGIN (?<kind>(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----.*?-----END \\k<kind>-----' -Replacement '<REDACTED_PRIVATE_KEY_BLOCK>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\bhttps?://[^/\\s:@]+:[^/\\s@]+@' -Replacement 'https://<REDACTED_URI_CREDENTIALS>@' -Count $countRef
""",
'assignment and block redaction',
)

replace_once(
"""  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b' -Replacement '<REDACTED_SLACK_TOKEN>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\\b' -Replacement '<REDACTED_PROVIDER_KEY>' -Count $countRef
""",
"""  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b' -Replacement '<REDACTED_SLACK_TOKEN>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\bglpat-[A-Za-z0-9_-]{20,}\\b' -Replacement '<REDACTED_COLLABORATION_TOKEN>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\bnpm_[A-Za-z0-9]{20,}\\b' -Replacement '<REDACTED_PACKAGE_TOKEN>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\bhf_[A-Za-z0-9]{20,}\\b' -Replacement '<REDACTED_PROVIDER_KEY>' -Count $countRef
  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\\b' -Replacement '<REDACTED_PROVIDER_KEY>' -Count $countRef
""",
'additional token redaction',
)

replace_once(
"""  return $normalized -in @(
    'authorization', 'proxyauthorization', 'cookie', 'setcookie',
    'token', 'accesstoken', 'refreshtoken', 'idtoken',
    'secret', 'clientsecret', 'password', 'passphrase',
    'apikey', 'accesskey', 'privatekey', 'credential', 'credentials',
    'sessionkey', 'signingkey'
  )
""",
"""  if ($normalized -in @(
    'authorization', 'proxyauthorization', 'cookie', 'setcookie',
    'token', 'accesstoken', 'refreshtoken', 'idtoken',
    'secret', 'clientsecret', 'password', 'passphrase',
    'apikey', 'accesskey', 'privatekey', 'credential', 'credentials',
    'sessionkey', 'signingkey'
  )) { return $true }

  return $normalized -match '(?:authorization|token|secret|password|passphrase|apikey|accesskey|privatekey|credential|cookie|signingkey)$'
""",
'json property redaction',
)

replace_once(
"""    '(?i)\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b',
    '(?i)\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\\b',
    '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b',
""",
"""    '(?i)\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b',
    '(?i)\\bglpat-[A-Za-z0-9_-]{20,}\\b',
    '(?i)\\bnpm_[A-Za-z0-9]{20,}\\b',
    '(?i)\\bhf_[A-Za-z0-9]{20,}\\b',
    '(?i)\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\\b',
    '(?is)-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----',
    '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b',
""",
'high risk patterns',
)

replace_once(
"""    $files = @(Get-ChildItem -LiteralPath $inputFull -Recurse -Force -File | Sort-Object FullName)
    foreach ($file in $files) {
      $relative = Get-RelativeEvidencePath -Root $inputFull -Path $file.FullName
      $relativeManifestPath = $relative.Replace([IO.Path]::DirectorySeparatorChar, '/')
      $sourceHash = Get-Sha256 -Path $file.FullName
      $base = [ordered]@{
        path = $relativeManifestPath
        sourceSize = [int64]$file.Length
        sourceSha256 = $sourceHash
      }

      $reason = $null
      if (Test-ReparsePointInPath -Root $inputFull -Path $file.FullName) {
        $reason = 'reparse_point'
      }
      elseif ($script:AllowedEvidenceExtensions -notcontains $file.Extension.ToLowerInvariant()) {
""",
"""    $files = @(Get-SafeEvidenceFiles -Root $inputFull)
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
""",
'safe enumeration and reparse before read',
)

replace_once(
"""    [void]$stdoutTask.Wait(5000)
    [void]$stderrTask.Wait(5000)
    $output = ($stdoutTask.Result + "`n" + $stderrTask.Result).Trim()
""",
"""    $stdoutCompleted = $false
    $stderrCompleted = $false
    try { $stdoutCompleted = $stdoutTask.Wait(5000) } catch { }
    try { $stderrCompleted = $stderrTask.Wait(5000) } catch { }
    $stdout = if ($stdoutCompleted -and -not $stdoutTask.IsFaulted) { $stdoutTask.Result } else { '<STDOUT_CAPTURE_INCOMPLETE>' }
    $stderr = if ($stderrCompleted -and -not $stderrTask.IsFaulted) { $stderrTask.Result } else { '<STDERR_CAPTURE_INCOMPLETE>' }
    $output = ($stdout + "`n" + $stderr).Trim()
""",
'timeout output capture',
)

replace_once(
"""    if (-not $completed) {
      try { $process.Kill() } catch { }
      [void]$process.WaitForExit(5000)
    }
""",
"""    if (-not $completed) {
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
""",
'kill process tree',
)

replace_once(
"""    $status = if ($result.Status -eq 'passed') { 'passed' } elseif ($result.Status -eq 'timed_out') { 'timed_out' } else { 'failed' }
""",
"""    $status = if ($result.Status -eq 'passed') { 'passed' } elseif ($result.Status -eq 'timed_out') { 'timed_out' } elseif ($result.Status -eq 'unavailable') { 'unavailable' } else { 'failed' }
""",
'preserve unavailable status',
)

p.write_text(text, encoding='utf-8', newline='\n')
print('patched', p, 'lines', len(text.splitlines()))
