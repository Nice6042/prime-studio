# Reproduces the Prime Studio scenario: prime-agent launched from a parent with NO console (the daemon /
# Prime Studio situation), running bash cells. Polls every 300ms for any VISIBLE window owned by any
# descendant, and reports the owning process + window class. This identifies the flasher precisely.
param(
  [string]$Prompt = "Execute now, one at a time: three bash cells echoing A, B, C.",
  [int]$Seconds = 150
)

# prime-agent's install dir. Override with PRIME_STUDIO_CLI when it is not the
# Windows global-npm default.
$dist = if ($env:PRIME_STUDIO_CLI) { $env:PRIME_STUDIO_CLI } else { Join-Path $env:APPDATA "npm\node_modules\prime-agent\dist" }
$cli = Join-Path $dist "bundle\cli.js"
$scratch = Join-Path $env:TEMP "prime-studio-smoke"
New-Item -ItemType Directory -Force -Path $scratch | Out-Null

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class F {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> Visible() {
    var hits = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var cls = new StringBuilder(128); GetClassName(h, cls, 128);
      var t = new StringBuilder(128); GetWindowText(h, t, 128);
      hits.Add(pid + "\t" + cls.ToString() + "\t" + t.ToString());
      return true;
    }, IntPtr.Zero);
    return hits;
  }
  public static int StartNoConsole(string exe, string args, string dir) {
    var psi = new ProcessStartInfo(exe, args);
    psi.UseShellExecute = false; psi.CreateNoWindow = true;
    psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
    psi.WorkingDirectory = dir;
    var p = Process.Start(psi);
    return p.Id;
  }
}
"@ -ErrorAction SilentlyContinue

# Baseline: window PIDs already on screen before we start.
$baseline = @{}
foreach ($row in [F]::Visible()) { $baseline[$row.Split("`t")[0]] = $true }

$args = "`"$cli`" -p --provider anthropic --model claude-opus-5 --cwd `"$scratch`" `"$Prompt`""
$root = [F]::StartNoConsole("node", $args, $scratch)
"prime root pid=$root (spawned with CreateNoWindow, i.e. no console to inherit)"

$seen = @{}
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $root -ErrorAction SilentlyContinue)) { break }
    foreach ($row in [F]::Visible()) {
        $parts = $row.Split("`t")
        $wpid = $parts[0]
        if ($baseline.ContainsKey($wpid)) { continue }
        $key = $row
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $proc = Get-Process -Id $wpid -ErrorAction SilentlyContinue
        $name = if ($proc) { $proc.Name } else { "(exited)" }
        $cmd = $null
        try { $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$wpid" -ErrorAction SilentlyContinue).CommandLine } catch {}
        if ($cmd -and $cmd.Length -gt 100) { $cmd = $cmd.Substring(0, 100) }
        "FLASH: pid=$wpid name=$name class=$($parts[1]) title='$($parts[2])' cmd=$cmd"
    }
    Start-Sleep -Milliseconds 300
}
Stop-Process -Id $root -Force -ErrorAction SilentlyContinue
"done - $($seen.Count) new visible window(s) detected"
