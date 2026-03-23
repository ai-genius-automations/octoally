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
 * Fresh install — use install.sh which handles everything:
 * prerequisites, download, desktop app, service setup, shell function.
 */
function runFreshInstall() {
  log(CYAN, "Running OctoAlly installer...\n");
  execSync(`bash -c "$(curl -fsSL ${INSTALL_SCRIPT_URL})"`, {
    stdio: "inherit",
    env: { ...process.env, OCTOALLY_INSTALL_DIR: INSTALL_DIR },
  });
}

/**
 * Update existing install — download tarball directly, extract, rebuild.
 * Does NOT use install.sh (avoids recursive loops, signal issues, duplicate prompts).
 * Does NOT stop/start the server — bin/octoally handles that.
 */
function runUpdate(version) {
  const tarballUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/octoally-v${version}.tar.gz`;
  const tmpFile = `/tmp/octoally-v${version}.tar.gz`;
  const extractDir = `/tmp/octoally-extract-${Date.now()}`;

  // Download
  log(CYAN, `Downloading v${version}...`);
  execSync(`curl -fsSL -o "${tmpFile}" "${tarballUrl}"`, { stdio: "inherit" });

  // Stop server
  if (existsSync(LOCAL_CLI)) {
    try {
      execSync(`"${LOCAL_CLI}" stop`, { cwd: INSTALL_DIR, stdio: "pipe" });
    } catch {
      // Server wasn't running — that's fine
    }
  }

  // Extract
  execSync(`mkdir -p "${extractDir}" && tar xzf "${tmpFile}" -C "${extractDir}"`, { stdio: "pipe" });
  execSync(`rm -f "${tmpFile}"`, { stdio: "pipe" });

  // Find extracted directory
  const extracted = execSync(`ls -d "${extractDir}"/octoally-* 2>/dev/null | head -1`, {
    encoding: "utf8",
  }).trim();

  if (!extracted) {
    throw new Error("Archive does not contain expected directory");
  }

  // Preserve user data
  const preserveFiles = ["logs", ".octoally", ".octoally.pid"];
  for (const f of preserveFiles) {
    const src = join(INSTALL_DIR, f);
    if (existsSync(src)) {
      try { execSync(`cp -r "${src}" "${extractDir}/_keep_${f}"`, { stdio: "pipe" }); } catch {}
    }
  }

  // Replace install
  execSync(`rm -rf "${INSTALL_DIR}"`, { stdio: "pipe" });
  execSync(`mv "${extracted}" "${INSTALL_DIR}"`, { stdio: "pipe" });

  // Restore preserved data
  for (const f of preserveFiles) {
    const kept = `${extractDir}/_keep_${f}`;
    if (existsSync(kept)) {
      try { execSync(`mv "${kept}" "${INSTALL_DIR}/${f}"`, { stdio: "pipe" }); } catch {}
    }
  }
  execSync(`rm -rf "${extractDir}"`, { stdio: "pipe" });

  // Install server dependencies (native modules like better-sqlite3)
  log(CYAN, "Installing dependencies...");
  execSync(`npm install --omit=dev --prefix "${INSTALL_DIR}/server"`, {
    cwd: INSTALL_DIR,
    stdio: "inherit",
  });

  // Update desktop app (.deb) if installed
  try {
    execSync("dpkg -l octoally-desktop", { stdio: "pipe" });
    // Desktop app is installed — download and update it
    const debUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/octoally-desktop_${version}_amd64.deb`;
    const debFile = `/tmp/octoally-desktop_${version}_amd64.deb`;
    log(CYAN, "Updating desktop app...");
    execSync(`curl -fsSL -o "${debFile}" "${debUrl}"`, { stdio: "pipe" });
    // Kill running desktop app before dpkg replaces the binary
    try { execSync('pkill -f "octoally-desktop"', { stdio: "pipe" }); } catch {}
    execSync(`sudo dpkg -i "${debFile}"`, { stdio: "inherit" });
    execSync(`rm -f "${debFile}"`, { stdio: "pipe" });
    log(GREEN, "Desktop app updated!");
    // Relaunch desktop app
    try { execSync('nohup octoally-desktop &>/dev/null & disown', { stdio: "pipe" }); } catch {}
  } catch {
    // Desktop app not installed or .deb not available — skip
  }

  // Start server
  log(CYAN, "Starting server...");
  execSync(`chmod +x "${LOCAL_CLI}" && "${LOCAL_CLI}" start`, {
    cwd: INSTALL_DIR,
    stdio: "inherit",
  });

  log(GREEN, `OctoAlly updated to v${version}!`);
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

// Explicit --install flag → fresh install via install.sh
if (command === "--install" || command === "install") {
  try { runFreshInstall(); } catch (err) {
    log(RED, `Install failed: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// Explicit --update flag
if (command === "--update") {
  const v = getPackageVersion();
  if (!v) { log(RED, "Cannot determine version"); process.exit(1); }
  try { runUpdate(v); } catch (err) {
    log(RED, `Update failed: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// ── Not installed → fresh install via install.sh ─────────────────────────────

if (!isInstalled()) {
  log(YELLOW, "OctoAlly is not installed yet.");
  if (await promptYesNo("Install OctoAlly?")) {
    try { runFreshInstall(); } catch (err) {
      log(RED, `Installation failed: ${err.message}`);
      process.exit(1);
    }
  } else {
    process.exit(0);
  }
  if (isInstalled()) {
    launch(args.length ? args : ["start"]);
  }
} else {
  // ── Installed → check for update, then launch ─────────────────────────────

  const packageVersion = getPackageVersion();
  const localVersion = getLocalVersion();

  if (packageVersion && localVersion && isNewer(packageVersion, localVersion)) {
    log(YELLOW, `Update available: v${localVersion} → v${packageVersion}`);
    if (await promptYesNo("Update now?")) {
      try {
        runUpdate(packageVersion);
        // Server already started by runUpdate — just exit cleanly
        process.exit(0);
      } catch (err) {
        log(RED, `Update failed: ${err.message}`);
        log(CYAN, "Launching existing version...");
      }
    }
  }

  launch(args.length ? args : ["start"]);
}
