#!/usr/bin/env node
// OctoAlly CLI — thin npm wrapper
// Installs OctoAlly from GitHub releases, then proxies commands to the local CLI.

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const INSTALL_DIR = process.env.OCTOALLY_INSTALL_DIR || join(homedir(), "octoally");
const GITHUB_REPO = "ai-genius-automations/octoally";
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

async function getLatestVersion() {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=5`);
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const releases = await res.json();
  const stable = releases.find((r) => !r.draft && !r.prerelease) || releases[0];
  if (!stable) throw new Error("No releases found");
  return { tag: stable.tag_name, version: stable.tag_name.replace(/^v/, ""), url: stable.html_url };
}

async function install() {
  log(CYAN, "Installing OctoAlly...");
  log(CYAN, `Install directory: ${INSTALL_DIR}`);

  // Check prerequisites
  try {
    execSync("node --version", { stdio: "pipe" });
  } catch {
    log(RED, "Node.js is required. Install it from https://nodejs.org");
    process.exit(1);
  }

  // Get latest release
  log(CYAN, "Fetching latest release...");
  const { version } = await getLatestVersion();
  log(CYAN, `Latest version: v${version}`);

  // Clone and build
  if (!existsSync(INSTALL_DIR)) {
    log(CYAN, "Cloning repository...");
    execSync(`git clone --depth 1 https://github.com/${GITHUB_REPO}.git "${INSTALL_DIR}"`, {
      stdio: "inherit",
    });
  } else {
    log(CYAN, "Updating existing installation...");
    execSync("git pull --ff-only", { cwd: INSTALL_DIR, stdio: "inherit" });
  }

  // Install dependencies
  log(CYAN, "Installing dependencies...");
  execSync("npm install", { cwd: INSTALL_DIR, stdio: "inherit" });
  execSync("npm install", { cwd: join(INSTALL_DIR, "server"), stdio: "inherit" });
  execSync("npm install", { cwd: join(INSTALL_DIR, "dashboard"), stdio: "inherit" });

  // Build
  log(CYAN, "Building...");
  execSync("npm run build", { cwd: INSTALL_DIR, stdio: "inherit" });

  // Symlink CLI to PATH
  const binDir = join(homedir(), ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const symlinkTarget = join(binDir, "octoally");
  try {
    execSync(`ln -sf "${LOCAL_CLI}" "${symlinkTarget}"`, { stdio: "pipe" });
    log(GREEN, `Symlinked to ${symlinkTarget}`);
  } catch {
    log(YELLOW, `Could not create symlink at ${symlinkTarget}`);
  }

  log(GREEN, `OctoAlly v${version} installed successfully!`);
  log(CYAN, `Start with: octoally start`);
  log(CYAN, `Dashboard:  http://localhost:42010`);
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

// Main
const args = process.argv.slice(2);
const command = args[0] || "help";

if (command === "install" || !isInstalled()) {
  if (!isInstalled()) {
    log(YELLOW, "OctoAlly is not installed yet.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question(`${BOLD}Install to ${INSTALL_DIR}? [Y/n]:${NC} `, resolve);
    });
    rl.close();
    if (answer.toLowerCase() === "n") {
      log(CYAN, "Installation cancelled.");
      process.exit(0);
    }
  }
  try {
    await install();
    // If there were additional args beyond "install", run them
    if (command !== "install" && command !== "help") {
      proxyCommand(args);
    }
  } catch (err) {
    log(RED, `Installation failed: ${err.message}`);
    process.exit(1);
  }
} else {
  proxyCommand(args);
}
