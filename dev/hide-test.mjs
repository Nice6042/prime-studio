// Spawns a long-lived python child exactly the way prime's bootstrap does, prints its PID,
// so we can check from outside whether Windows gave it a console (conhost child).
import { spawn } from "node:child_process";
const py = process.argv[2];
const child = spawn(py, ["-c", "import time; time.sleep(6)"], { stdio: "ignore", env: process.env });
console.log("CHILD_PID=" + child.pid);
setTimeout(() => { try { child.kill(); } catch {} }, 7000);
