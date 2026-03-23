#!/usr/bin/env node
// OctoAlly CLI — thin npm wrapper
// Delegates install/update to install.sh (single source of truth).
// Only handles version detection and launching.

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
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

function log(color, msg) {
  console.log(`${color}[OctoAlly]${NC} ${msg}`);
}

function isInstalled() {
  return existsSync(LOCAL_CLI) && existsSync(join(INSTALL_DIR, "server", "dist"));
}

/** Read the npm package version (baked into this wrapper at publish time). */
function getPackageVersion() {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

/** Read the locally installed version from ~/octoally/version.json. */
function getLocalVersion() {
  try {
    const versionFile = join(INSTALL_DIR, "version.json");
    const data = JSON.parse(readFileSync(versionFile, "utf8"));
    return data.version || null;
  } catch {
    return null;
  }
}

/** Compare two semver strings. Returns true if a > b. */
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
    rl.question(`${BOLD}${question} [Y/n]:${NC} `, resolve);
  });
  rl.close();
  return answer.toLowerCase() !== "n";
}

/**
 * Run install.sh — handles both fresh install and upgrade.
 * install.sh is the single source of truth for all install/update logic
 * including server, dashboard, desktop app, migrations, and service restart.
 */
function runInstaller() {
  log(CYAN, "Running OctoAlly installer...\n");
  execSync(`bash -c "$(curl -fsSL ${INSTALL_SCRIPT_URL})"`, {
    stdio: "inherit",
    env: { ...process.env, OCTOALLY_INSTALL_DIR: INSTALL_DIR },
  });
}

function proxyCommand(args) {
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

// Explicit --install or --update flag → run installer
if (command === "--install" || command === "install" || command === "--update") {
  try {
    runInstaller();
  } catch (err) {
    log(RED, `Failed: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// ── Not installed → run installer, then launch ──────────────────────────────

if (!isInstalled()) {
  log(YELLOW, "OctoAlly is not installed yet.");
  if (await promptYesNo("Install OctoAlly?")) {
    try {
      runInstaller();
      if (isInstalled()) {
        proxyCommand(args.length ? args : ["start"]);
      }
    } catch (err) {
      log(RED, `Installation failed: ${err.message}`);
      process.exit(1);
    }
  } else {
    process.exit(0);
  }
} else {
  // ── Installed → check for updates, then launch ───────────────────────────

  const packageVersion = getPackageVersion();
  const localVersion = getLocalVersion();

  if (packageVersion && localVersion && isNewer(packageVersion, localVersion)) {
    log(YELLOW, `Update available: v${localVersion} → v${packageVersion}`);
    if (await promptYesNo("Update before launching?")) {
      try {
        runInstaller();
      } catch (err) {
        log(RED, `Update failed: ${err.message}`);
        log(CYAN, "Launching existing version...");
      }
    }
  }

  // Default: launch the app
  proxyCommand(args.length ? args : ["start"]);
}
