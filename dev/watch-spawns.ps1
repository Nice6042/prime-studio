# Records processes created during a window, with parent, so we can attribute
# console windows to prime's kernel vs our own test harness.
param([int]$Seconds = 120, [string]$OutFile = (Join-Path $PSScriptRoot "spawn-watch.log"))

$seen = @{}
foreach ($p in Get-CimInstance Win32_Process) { $seen[$p.ProcessId] = $true }

$deadline = (Get-Date).AddSeconds($Seconds)
$rows = @()
while ((Get-Date) -lt $deadline) {
    foreach ($p in Get-CimInstance Win32_Process) {
        if (-not $seen.ContainsKey($p.ProcessId)) {
            $seen[$p.ProcessId] = $true
            $parent = $null
            try { $parent = (Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)" -EA SilentlyContinue).Name } catch {}
            $rows += [pscustomobject]@{
                Name   = $p.Name
                Pid    = $p.ProcessId
                Parent = "$parent($($p.ParentProcessId))"
                Cmd    = if ($p.CommandLine) { $p.CommandLine.Substring(0, [Math]::Min(90, $p.CommandLine.Length)) } else { "" }
            }
        }
    }
    Start-Sleep -Milliseconds 120
}
$rows | Format-Table -AutoSize | Out-String -Width 220 | Set-Content $OutFile
"captured $($rows.Count) new processes"
