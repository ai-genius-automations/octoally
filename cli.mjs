#!/usr/bin/env node
// OctoAlly CLI — thin npm wrapper
// Checks version, updates if needed (via tarball download), launches the app.
// No delegation to install.sh for updates — avoids recursive loops and signal issues.

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

// Re-entrancy guard: install.sh calls `octoally` commands which npx resolves
// back to this script. Detect this and proxy to the real CLI instead.
if (process.env.__OCTOALLY_NPX_ACTIVE === "1") {
  const dir = process.env.OCTOALLY_INSTALL_DIR || join(homedir(), "octoally");
  const cli = join(dir, "bin", "octoally");
  if (existsSync(cli)) {
    const c = spawn(cli, process.argv.slice(2), { stdio: "inherit", cwd: dir });
    c.on("exit", (code) => process.exit(code ?? 0));
    c.on("error", () => process.exit(1));
    await new Promise(() => {});
  }
  process.exit(0);
}

const INSTALL_DIR = process.env.OCTOALLY_INSTALL_DIR || join(homedir(), "octoally");
const GITHUB_REPO = "ai-genius-automations/octoally";
const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/scripts/install.sh`;
const LOCAL_CLI = join(INSTALL_DIR, "bin", "octoally");

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const NC = "\x1b[0m";

function log(color, msg) {
  console.log(`${color}[OctoAlly]${NC} ${msg}`);
}

function isInstalled() {
  return existsSync(LOCAL_CLI) && existsSync(join(INSTALL_DIR, "server", "dist"));
}

function getPackageVersion() {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version || null;
  } catch { return null; }
}

function getLocalVersion() {
  try {
    return JSON.parse(readFileSync(join(INSTALL_DIR, "version.json"), "utf8")).version || null;
  } catch { return null; }
}

function isNewer(a, b) {
  if (!a || !b) return false;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function promptYesNo(question) {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(`${question} [Y/n]: `, resolve);
  });
  rl.close();
  return answer.toLowerCase() !== "n";
}

/**
 * Install or update — download pre-built tarball, extract, install deps, setup CLI.
 * Handles both fresh install and upgrade. No install.sh (avoids signal/loop issues).
 */
function runInstallOrUpdate(version) {
  const tarballUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/octoally-v${version}.tar.gz`;
  const tmpFile = `/tmp/octoally-v${version}.tar.gz`;
  const extractDir = `/tmp/octoally-extract-${Date.now()}`;

  // Download
  log(CYAN, `Downloading v${version}...`);
  execSync(`curl -fsSL -o "${tmpFile}" "${tarballUrl}"`, { stdio: "inherit" });

  // Stop server if running (detect service vs PID)
  let serviceType = null; // "systemd", "launchd", or null (PID-based)
  if (process.platform === "linux") {
    try { execSync("systemctl is-active --quiet octoally", { stdio: "pipe" }); serviceType = "systemd"; } catch {}
  } else if (process.platform === "darwin") {
    try { execSync("launchctl list com.aigenius.octoally", { stdio: "pipe" }); serviceType = "launchd"; } catch {}
  }

  if (serviceType === "systemd") {
    log(CYAN, "Stopping systemd service...");
    try { execSync("sudo systemctl stop octoally", { stdio: "inherit" }); } catch {}
  } else if (serviceType === "launchd") {
    log(CYAN, "Stopping launchd service...");
    try { execSync("launchctl stop com.aigenius.octoally", { stdio: "pipe" }); } catch {}
  } else if (existsSync(LOCAL_CLI)) {
    log(CYAN, "Stopping server...");
    try { execSync(`"${LOCAL_CLI}" stop`, { cwd: INSTALL_DIR, stdio: "inherit" }); } catch {}
  }

  // Also kill server by PID file as a fallback (CLI stop may not work if binary is stale)
  const pidFile = join(INSTALL_DIR, ".octoally.pid");
  if (existsSync(pidFile)) {
    try {
      const pid = readFileSync(pidFile, "utf8").trim();
      if (pid) execSync(`kill ${pid} 2>/dev/null || true`, { stdio: "pipe" });
    } catch {}
  }

  // Final fallback: kill whatever is listening on port 42010.
  // On macOS, the old server process can survive PID file + CLI stop.
  try {
    const lsofOut = execSync('lsof -ti:42010 2>/dev/null || true', { encoding: 'utf8' }).trim();
    if (lsofOut) {
      for (const pid of lsofOut.split('\n').filter(Boolean)) {
        execSync(`kill ${pid} 2>/dev/null || true`, { stdio: 'pipe' });
      }
      // Wait briefly for port to free
      execSync('sleep 1', { stdio: 'pipe' });
    }
  } catch {}

  // Extract
  execSync(`mkdir -p "${extractDir}" && tar xzf "${tmpFile}" -C "${extractDir}"`, { stdio: "pipe" });
  execSync(`rm -f "${tmpFile}"`, { stdio: "pipe" });

  const extracted = execSync(`ls -d "${extractDir}"/octoally-* 2>/dev/null | head -1`, {
    encoding: "utf8",
  }).trim();
  if (!extracted) throw new Error("Archive does not contain expected directory");

  // Preserve user data from existing install
  const preserveFiles = ["logs", ".octoally", ".octoally.pid"];
  for (const f of preserveFiles) {
    const src = join(INSTALL_DIR, f);
    if (existsSync(src)) {
      try { execSync(`cp -r "${src}" "${extractDir}/_keep_${f}"`, { stdio: "pipe" }); } catch {}
    }
  }

  // Replace install dir
  if (existsSync(INSTALL_DIR)) {
    execSync(`rm -rf "${INSTALL_DIR}"`, { stdio: "pipe" });
  }
  execSync(`mv "${extracted}" "${INSTALL_DIR}"`, { stdio: "pipe" });

  // Restore preserved data
  for (const f of preserveFiles) {
    const kept = `${extractDir}/_keep_${f}`;
    if (existsSync(kept)) {
      try { execSync(`mv "${kept}" "${INSTALL_DIR}/${f}"`, { stdio: "pipe" }); } catch {}
    }
  }
  execSync(`rm -rf "${extractDir}"`, { stdio: "pipe" });
  execSync(`mkdir -p "${INSTALL_DIR}/logs"`, { stdio: "pipe" });

  // Install server dependencies (native modules like better-sqlite3)
  log(CYAN, "Installing dependencies...");
  execSync(`npm install --omit=dev --prefix "${INSTALL_DIR}/server"`, {
    cwd: INSTALL_DIR,
    stdio: "inherit",
  });

  // Verify native modules load on the current Node. If npm pulled prebuilt
  // binaries that don't match this Node's NODE_MODULE_VERSION (happens when
  // the user's Node version differs from what the prebuilt targets), rebuild
  // from source. Works on Linux and macOS.
  try {
    execSync(`node -e "require('better-sqlite3'); require('node-pty-prebuilt-multiarch')"`, {
      cwd: join(INSTALL_DIR, "server"),
      stdio: "pipe",
    });
  } catch {
    log(CYAN, "Rebuilding native modules for current Node...");
    execSync(`npm rebuild better-sqlite3 node-pty-prebuilt-multiarch --prefix "${INSTALL_DIR}/server"`, {
      stdio: "inherit",
    });
  }

  // Setup CLI symlink
  execSync(`chmod +x "${LOCAL_CLI}"`, { stdio: "pipe" });
  const binDir = join(homedir(), ".local", "bin");
  execSync(`mkdir -p "${binDir}"`, { stdio: "pipe" });
  try { execSync(`ln -sf "${LOCAL_CLI}" "${binDir}/octoally"`, { stdio: "pipe" }); } catch {}

  // Desktop app: install/update if available
  if (process.platform === "linux") {
    const debUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/octoally-desktop_${version}_amd64.deb`;
    const debFile = `/tmp/octoally-desktop_${version}_amd64.deb`;
    try {
      try {
        execSync('pkill -9 -f "octoally-desktop"', { stdio: "pipe" });
        for (let i = 0; i < 10; i++) {
          try { execSync('pgrep -f "octoally-desktop"', { stdio: "pipe" }); } catch { break; }
          execSync("sleep 0.5", { stdio: "pipe" });
        }
      } catch {}
      log(CYAN, "Downloading desktop app...");
      execSync(`curl -fSL -o "${debFile}" "${debUrl}"`, { stdio: "inherit" });
      log(CYAN, "Installing desktop app...");
      execSync(`sudo dpkg -i "${debFile}"`, { stdio: "inherit" });
      execSync(`rm -f "${debFile}"`, { stdio: "pipe" });
      log(GREEN, "Desktop app installed!");
    } catch {
      log(YELLOW, "Desktop app install skipped (download failed or unavailable)");
    }
  } else if (process.platform === "darwin") {
    // macOS: download .dmg, mount, copy .app to /Applications
    const arch = execSync("uname -m", { encoding: "utf8" }).trim();
    const dmgName = arch === "arm64" ? `OctoAlly-${version}-arm64.dmg` : `OctoAlly-${version}.dmg`;
    const dmgUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${dmgName}`;
    const dmgFile = `/tmp/${dmgName}`;
    try {
      // Kill old app
      try { execSync('pkill -9 -f "OctoAlly"', { stdio: "pipe" }); } catch {}
      log(CYAN, "Downloading desktop app...");
      execSync(`curl -fSL -o "${dmgFile}" "${dmgUrl}"`, { stdio: "inherit" });
      log(CYAN, "Installing desktop app...");
      // Mount DMG, find .app, copy to /Applications (matches install.sh)
      const plistOut = execSync(`hdiutil attach "${dmgFile}" -nobrowse -plist`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      const mountMatch = plistOut.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
      if (mountMatch) {
        const mountDir = mountMatch[1];
        const appPath = execSync(`find "${mountDir}" -maxdepth 1 -name "*.app" -type d | head -1`, { encoding: "utf8" }).trim();
        if (appPath) {
          const appName = appPath.split("/").pop();
          execSync(`rm -rf "/Applications/${appName}" 2>/dev/null || true`, { stdio: "pipe" });
          execSync(`cp -R "${appPath}" /Applications/`, { stdio: "pipe" });
          log(GREEN, "Desktop app installed!");
        }
        execSync(`hdiutil detach "${mountDir}" -quiet`, { stdio: "pipe" });
      }
      execSync(`rm -f "${dmgFile}"`, { stdio: "pipe" });
    } catch {
      log(YELLOW, "Desktop app install skipped (download failed or unavailable)");
    }
  }

  // Start server (match how it was stopped)
  // Re-resolve CLI path since install dir was replaced
  const newCli = join(INSTALL_DIR, "bin", "octoally");
  execSync(`chmod +x "${newCli}"`, { stdio: "pipe" });

  if (serviceType === "systemd") {
    log(CYAN, "Starting systemd service...");
    execSync("sudo systemctl start octoally", { stdio: "inherit" });
  } else if (serviceType === "launchd") {
    log(CYAN, "Starting launchd service...");
    try { execSync("launchctl start com.aigenius.octoally", { stdio: "pipe" }); } catch {}
  } else {
    log(CYAN, "Starting server...");
    execSync(`"${newCli}" start`, { cwd: INSTALL_DIR, stdio: "inherit" });
  }

  // Verify server is actually running
  try {
    const status = execSync(`"${newCli}" status`, { cwd: INSTALL_DIR, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    if (status.includes("stopped")) {
      log(YELLOW, "Server didn't stay running — retrying...");
      execSync(`"${newCli}" start`, { cwd: INSTALL_DIR, stdio: "inherit" });
    }
  } catch {}

  log(GREEN, `OctoAlly v${version} installed!`);

  // Launch desktop app (single instance)
  if (process.platform === "linux") {
    let desktopRunning = false;
    try { execSync('pgrep -f "[o]ctoally-desktop"', { stdio: "pipe" }); desktopRunning = true; } catch {}
    if (!desktopRunning) {
      const desktopBin = ["/usr/bin/octoally-desktop", "/opt/OctoAlly/octoally-desktop"]
        .find((p) => existsSync(p));
      if (desktopBin) {
        log(CYAN, "Launching desktop app...");
        const desktop = spawn(desktopBin, [], {
          stdio: "ignore",
          detached: true,
          env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
        });
        desktop.unref();
      }
    }
  } else if (process.platform === "darwin") {
    let desktopRunning = false;
    try { execSync('pgrep -f "[O]ctoAlly"', { stdio: "pipe" }); desktopRunning = true; } catch {}
    if (!desktopRunning && existsSync("/Applications/OctoAlly.app")) {
      log(CYAN, "Launching desktop app...");
      try { execSync('open -a OctoAlly', { stdio: "pipe" }); } catch {}
    }
  }
}

function launch(args) {
  const child = spawn(LOCAL_CLI, args, {
    stdio: "inherit",
    cwd: INSTALL_DIR,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    log(RED, `Failed to run: ${err.message}`);
    process.exit(1);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] || "";

// Explicit --install or --update flag
if (command === "--install" || command === "install" || command === "--update") {
  const v = getPackageVersion();
  if (!v) { log(RED, "Cannot determine version"); process.exit(1); }
  try { runInstallOrUpdate(v); } catch (err) {
    log(RED, `Failed: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// ── Not installed → install ──────────────────────────────────────────────────

if (!isInstalled()) {
  const v = getPackageVersion();
  if (!v) { log(RED, "Cannot determine version"); process.exit(1); }
  log(CYAN, `Installing OctoAlly v${v}...`);
  try {
    runInstallOrUpdate(v);
    // Server already started by runInstallOrUpdate — exit cleanly
    process.exit(0);
  } catch (err) {
    log(RED, `Installation failed: ${err.message}`);
    process.exit(1);
  }
} else {
  // ── Installed → check for update, then launch ─────────────────────────────

  const packageVersion = getPackageVersion();
  const localVersion = getLocalVersion();

  if (packageVersion && localVersion && isNewer(packageVersion, localVersion)) {
    log(CYAN, `Updating v${localVersion} → v${packageVersion}...`);
    try {
      runInstallOrUpdate(packageVersion);
      // Server already started — exit cleanly
      process.exit(0);
    } catch (err) {
      log(RED, `Update failed: ${err.message}`);
      log(CYAN, "Launching existing version...");
    }
  }

  // Launch desktop app if installed and not running (non-update path)
  if (!args.length || args[0] === "start") {
    if (process.platform === "linux") {
      let desktopRunning = false;
      try { execSync('pgrep -f "[o]ctoally-desktop"', { stdio: "pipe" }); desktopRunning = true; } catch {}
      if (!desktopRunning) {
        const desktopBin = ["/usr/bin/octoally-desktop", "/opt/OctoAlly/octoally-desktop"]
          .find((p) => existsSync(p));
        if (desktopBin) {
          log(CYAN, "Launching desktop app...");
          const desktop = spawn(desktopBin, [], {
            stdio: "ignore",
            detached: true,
            env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
          });
          desktop.unref();
        }
      }
    } else if (process.platform === "darwin") {
      let desktopRunning = false;
      try { execSync('pgrep -f "[O]ctoAlly"', { stdio: "pipe" }); desktopRunning = true; } catch {}
      if (!desktopRunning && existsSync("/Applications/OctoAlly.app")) {
        log(CYAN, "Launching desktop app...");
        try { execSync('open -a OctoAlly', { stdio: "pipe" }); } catch {}
      }
    }
  }

  launch(args.length ? args : ["start"]);
}
