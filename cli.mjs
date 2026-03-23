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

  // Stop server if running
  if (existsSync(LOCAL_CLI)) {
    try { execSync(`"${LOCAL_CLI}" stop`, { cwd: INSTALL_DIR, stdio: "pipe" }); } catch {}
  }

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

  // Setup CLI symlink
  execSync(`chmod +x "${LOCAL_CLI}"`, { stdio: "pipe" });
  const binDir = join(homedir(), ".local", "bin");
  execSync(`mkdir -p "${binDir}"`, { stdio: "pipe" });
  try { execSync(`ln -sf "${LOCAL_CLI}" "${binDir}/octoally"`, { stdio: "pipe" }); } catch {}

  // Desktop app: install/update .deb if available (Linux only)
  if (process.platform === "linux") {
    const debUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/octoally-desktop_${version}_amd64.deb`;
    const debFile = `/tmp/octoally-desktop_${version}_amd64.deb`;
    try {
      // Kill old desktop app if running
      try {
        execSync('pkill -9 -f "octoally-desktop"', { stdio: "pipe" });
        for (let i = 0; i < 10; i++) {
          try { execSync('pgrep -f "octoally-desktop"', { stdio: "pipe" }); } catch { break; }
          execSync("sleep 0.5", { stdio: "pipe" });
        }
      } catch {}
      // Download .deb (follows redirects)
      log(CYAN, "Downloading desktop app...");
      execSync(`curl -fSL -o "${debFile}" "${debUrl}"`, { stdio: "inherit" });
      log(CYAN, "Installing desktop app...");
      execSync(`sudo dpkg -i "${debFile}"`, { stdio: "inherit" });
      execSync(`rm -f "${debFile}"`, { stdio: "pipe" });
      log(GREEN, "Desktop app installed!");
      // Launch desktop app
      try {
        const desktop = spawn("octoally-desktop", [], { stdio: "ignore", detached: true });
        desktop.unref();
      } catch {}
    } catch {
      log(YELLOW, "Desktop app install skipped (download failed or dpkg unavailable)");
    }
  }

  // Start server
  log(CYAN, "Starting server...");
  execSync(`"${LOCAL_CLI}" start`, { cwd: INSTALL_DIR, stdio: "inherit" });

  log(GREEN, `OctoAlly v${version} installed!`);
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

  // Launch desktop app if installed and not running
  if (process.platform === "linux" && (!args.length || args[0] === "start")) {
    let desktopRunning = false;
    try {
      execSync('pgrep -x "octoally-desktop"', { stdio: "pipe" });
      desktopRunning = true;
    } catch {}

    if (!desktopRunning) {
      // Find desktop binary
      let desktopBin = null;
      try {
        desktopBin = execSync("which octoally-desktop 2>/dev/null", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      } catch {}
      if (!desktopBin) {
        desktopBin = ["/usr/bin/octoally-desktop", "/opt/OctoAlly/octoally-desktop"]
          .find((p) => existsSync(p)) || null;
      }

      if (desktopBin) {
        log(CYAN, "Launching desktop app...");
        try {
          const desktop = spawn(desktopBin, [], { stdio: "ignore", detached: true });
          desktop.unref();
        } catch (err) {
          log(YELLOW, `Desktop app launch failed: ${err.message}`);
        }
      }
    }
  }

  launch(args.length ? args : ["start"]);
}
