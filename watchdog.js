const { spawn } = require("child_process");

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error("usage: node watchdog.js <script.js> [script2.js ...]");
  process.exit(1);
}

for (const script of targets) {
  spawnLoop(script);
}

function spawnLoop(script) {
  const child = spawn(process.execPath, [script], { stdio: "inherit", env: process.env });
  console.log(`[watchdog] started ${script} (pid ${child.pid})`);
  child.on("exit", (code, signal) => {
    console.error(`[watchdog] ${script} exited (code ${code}, signal ${signal}) — restarting in 1s`);
    setTimeout(() => spawnLoop(script), 1000);
  });
}
