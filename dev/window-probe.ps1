# Reliable console-window detector: enumerates top-level windows and reports any whose owning
# process is in the given PID set, with class name (console windows are "ConsoleWindowClass").
# conhost parentage is unreliable; window ownership is not.
param([int[]]$Pids)

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Win {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> Find(int[] pids) {
    var want = new HashSet<uint>();
    foreach (var p in pids) want.Add((uint)p);
    var hits = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (want.Contains(pid)) {
        var sb = new StringBuilder(128); GetClassName(h, sb, 128);
        hits.Add(pid + " class=" + sb.ToString() + " visible=" + IsWindowVisible(h));
      }
      return true;
    }, IntPtr.Zero);
    return hits;
  }
}
"@ -ErrorAction SilentlyContinue

$found = [Win]::Find($Pids)
if ($found.Count -eq 0) { "no windows owned by those pids" } else { $found }
