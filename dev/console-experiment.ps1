# Decisive test: does windowsHide actually suppress the console when the PARENT has no
# console (the daemon's situation)? Spawns node with CREATE_NO_WINDOW, which then spawns a
# long-lived python child either with or without windowsHide, and checks whether a conhost.exe
# is parented to that child.
# Defaults to prime's own kernel venv; pass -Py to point at any python.exe.
param([string]$Py = (Join-Path $HOME ".prime\agent\kernel-venv-win\Scripts\python.exe"))

$script = @'
const { spawn } = require("node:child_process");
const hide = process.argv[3] === "hide";
const child = spawn(process.argv[2], ["-c", "import time; time.sleep(9)"],
  { stdio: "ignore", ...(hide ? { windowsHide: true } : {}) });
require("node:fs").writeFileSync(process.argv[4], String(child.pid));
setTimeout(() => { try { child.kill(); } catch {} }, 10000);
'@
$js = "$env:TEMP\spawn-child.cjs"
Set-Content -Path $js -Value $script -Encoding utf8

Add-Type @"
using System;
using System.Diagnostics;
public class P {
  public static int Start(string exe, string args) {
    var psi = new ProcessStartInfo(exe, args);
    psi.UseShellExecute = false;
    psi.CreateNoWindow = true;          // parent gets NO console — like the prime daemon
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    var p = Process.Start(psi);
    return p.Id;
  }
}
"@ -ErrorAction SilentlyContinue

foreach ($mode in @("nohide", "hide")) {
    $pidFile = "$env:TEMP\child-$mode.pid"
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    $parent = [P]::Start("node", "`"$js`" `"$Py`" $mode `"$pidFile`"")
    Start-Sleep -Seconds 4
    $childPid = (Get-Content $pidFile -ErrorAction SilentlyContinue)
    if (-not $childPid) { "$mode : child pid not reported"; continue }
    $consoles = @(Get-CimInstance Win32_Process -Filter "Name='conhost.exe' AND ParentProcessId=$childPid" -ErrorAction SilentlyContinue)
    "$mode : parent=$parent child=$childPid consoleWindows=$($consoles.Count)"
    Stop-Process -Id $parent -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}
