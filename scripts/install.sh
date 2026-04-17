#!/usr/bin/env bash
# OctoAlly Installer
# Downloads a pre-built release, extracts it, and starts the server.
#
# Prerequisites:
#   - Node.js 20+    https://nodejs.org
#   - Claude Code     npm install -g @anthropic-ai/claude-code
#
# IMPORTANT: You must run `claude` at least once and accept the terms before
# installing OctoAlly. Sessions require non-interactive mode, so you must also
# run: claude --dangerously-skip-permissions
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ai-genius-automations/octoally/main/scripts/install.sh | bash
#   OCTOALLY_VERSION=0.1.0 bash install.sh
#   OCTOALLY_INSTALL_DIR=/opt/octoally bash install.sh
#
# For private repos / pre-release testing:
#   OCTOALLY_ARCHIVE_URL="https://example.com/octoally-v0.1.0.tar.gz" bash install.sh

set -euo pipefail

INSTALL_DIR="${OCTOALLY_INSTALL_DIR:-${HIVECOMMAND_INSTALL_DIR:-$HOME/octoally}}"
GITHUB_REPO="${OCTOALLY_GITHUB_REPO:-ai-genius-automations/octoally}"
VERSION="${OCTOALLY_VERSION:-latest}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

# Build auth header array for curl (used for private repo access)
AUTH_HEADER=()
if [ -n "$GITHUB_TOKEN" ]; then
  AUTH_HEADER=(-H "Authorization: token $GITHUB_TOKEN")
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[OctoAlly]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OctoAlly]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[OctoAlly]${NC} $1"; }
log_error() { echo -e "${RED}[OctoAlly]${NC} $1"; }
log_step()  { echo -e "\n${BOLD}[$1/$TOTAL_STEPS] $2${NC}"; }

TOTAL_STEPS=6

# Detect the target user (if running as root via sudo, install for the real user)
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  TARGET_USER="$SUDO_USER"
  TARGET_HOME=$(eval echo "~$SUDO_USER")
  INSTALL_DIR="${OCTOALLY_INSTALL_DIR:-${HIVECOMMAND_INSTALL_DIR:-$TARGET_HOME/octoally}}"
elif [ "$(id -u)" -eq 0 ]; then
  TARGET_USER="root"
  TARGET_HOME="$HOME"
else
  TARGET_USER="$(whoami)"
  TARGET_HOME="$HOME"
fi

OS="$(uname -s)"

# Use sudo for system commands when not running as root
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo &>/dev/null; then
    SUDO="sudo"
  fi
fi

# --- Step 1: Check prerequisites ---------------------------------------------

log_step 1 "Checking prerequisites..."

# Helper: prompt user to install something or exit
# Works even when piped (curl | bash) by reading from /dev/tty
prompt_install() {
  local name="$1"
  local install_msg="$2"
  if [ -e /dev/tty ]; then
    echo ""
    echo -n "  $name is required. Install it now? [Y/n]: "
    read -r answer < /dev/tty 2>/dev/null || answer="y"
    case "$answer" in
      [nN]|[nN][oO])
        log_error "$name is required to continue. Install it and re-run this installer."
        exit 1
        ;;
    esac
    return 0  # user said yes
  else
    # Truly non-interactive (no terminal at all)
    log_error "$name is required but not installed."
    echo ""
    echo "  $install_msg"
    echo "  Then re-run this installer."
    echo ""
    exit 1
  fi
}

# Check Node.js
NEED_NODE=false
if ! command -v node &>/dev/null; then
  NEED_NODE=true
else
  NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
  if [ "$NODE_MAJOR" -lt 20 ]; then
    NEED_NODE=true
    log_warn "Node.js $NODE_MAJOR found but 20+ is required"
  fi
fi

if [ "$NEED_NODE" = true ]; then
  prompt_install "Node.js 20+" "Install from: https://nodejs.org"
  log_info "Installing Node.js 22..."
  case "$OS" in
    Linux*)
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq ca-certificates curl gnupg
      $SUDO mkdir -p /etc/apt/keyrings
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | $SUDO gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | $SUDO tee /etc/apt/sources.list.d/nodesource.list > /dev/null
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq nodejs
      ;;
    Darwin*)
      if command -v brew &>/dev/null; then
        brew install node 2>&1 || true
      else
        log_error "Cannot auto-install Node.js without Homebrew. Install from https://nodejs.org"
        exit 1
      fi
      ;;
    *)
      log_error "Cannot auto-install Node.js on this OS. Install from https://nodejs.org"
      exit 1
      ;;
  esac
  if ! command -v node &>/dev/null; then
    log_error "Node.js installation failed. Install manually from https://nodejs.org"
    exit 1
  fi
  log_ok "Node.js $(node -v) installed"
fi

# Check Claude Code
if ! command -v claude &>/dev/null; then
  prompt_install "Claude Code" "Install with: npm install -g @anthropic-ai/claude-code"
  log_info "Installing Claude Code..."
  if [ "$OS" = "Darwin" ]; then
    npm install -g @anthropic-ai/claude-code 2>&1 || true
  else
    $SUDO npm install -g @anthropic-ai/claude-code 2>&1 || true
  fi
  if ! command -v claude &>/dev/null; then
    log_error "Claude Code installation failed. Install manually: npm install -g @anthropic-ai/claude-code"
    exit 1
  fi
  log_ok "Claude Code $(claude --version 2>/dev/null || echo 'installed')"
fi

# Check if Claude Code has been run with --dangerously-skip-permissions
# This is required for OctoAlly to run non-interactive agent sessions.
# The flag creates a config entry that persists — only needs to be run once.
CLAUDE_CONFIG_DIR="${HOME}/.claude"
if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
  CLAUDE_CONFIG_DIR="$TARGET_HOME/.claude"
fi

CLAUDE_INITIALIZED=false
if [ -d "$CLAUDE_CONFIG_DIR" ]; then
  # Check if settings or any config file indicates permissions were accepted
  if [ -f "$CLAUDE_CONFIG_DIR/settings.json" ] || [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then
    CLAUDE_INITIALIZED=true
  fi
fi

if [ "$CLAUDE_INITIALIZED" = false ]; then
  log_warn "Claude Code has not been initialized yet."
  echo ""
  echo "  OctoAlly requires Claude Code to be set up with non-interactive permissions."
  echo "  You need to run these commands (as your user, not root):"
  echo ""
  echo "    1. claude                              # Accept terms & sign in"
  echo "    2. claude --dangerously-skip-permissions  # Enable non-interactive mode"
  echo ""
  if [ -e /dev/tty ]; then
    echo -n "  Have you already done this? [y/N]: "
    read -r answer < /dev/tty 2>/dev/null || answer="n"
    case "$answer" in
      [yY]|[yY][eE][sS])
        log_info "Continuing with install..."
        ;;
      *)
        echo ""
        log_info "Please run the commands above first, then re-run this installer."
        echo ""
        echo "  Quick setup:"
        echo "    claude                                 # Accept terms & sign in"
        echo "    claude --dangerously-skip-permissions   # Enable non-interactive mode"
        echo "    # Then re-run this installer"
        echo ""
        exit 1
        ;;
    esac
  else
    log_error "Run 'claude' and 'claude --dangerously-skip-permissions' first, then re-run this installer."
    exit 1
  fi
fi

# Install runtime deps if missing (tmux, dtach, curl, build tools)
NEEDED=()
command -v tmux &>/dev/null  || NEEDED+=(tmux)
command -v dtach &>/dev/null || NEEDED+=(dtach)
command -v curl &>/dev/null  || NEEDED+=(curl)

case "$OS" in
  Linux*)
    command -v make &>/dev/null || NEEDED+=(build-essential)
    command -v g++ &>/dev/null  || NEEDED+=(build-essential)
    # Deduplicate
    if [ ${#NEEDED[@]} -gt 0 ]; then
      NEEDED=($(echo "${NEEDED[@]}" | tr ' ' '\n' | sort -u | tr '\n' ' '))
      log_info "Installing: ${NEEDED[*]}..."
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq "${NEEDED[@]}"
    fi
    ;;
  Darwin*)
    if [ ${#NEEDED[@]} -gt 0 ] && command -v brew &>/dev/null; then
      log_info "Installing: ${NEEDED[*]}..."
      brew install "${NEEDED[@]}" 2>&1 || true
    fi
    ;;
esac

NODE_VER="$(node -v 2>/dev/null || echo 'not found')"
CLAUDE_VER="$(claude --version 2>/dev/null || echo 'ok')"
log_ok "Prerequisites met (Node ${NODE_VER}, Claude Code ${CLAUDE_VER})"

# --- Migrate from OpenFlow and HiveCommand (if upgrading) ---------------------

NEW_CONFIG_DIR="$TARGET_HOME/.octoally"

# Migrate from OpenFlow
OLD_OPENFLOW_DIR="$TARGET_HOME/.openflow"
if [ -d "$OLD_OPENFLOW_DIR" ] && [ ! -d "$NEW_CONFIG_DIR" ]; then
  log_info "Migrating config directory: ~/.openflow → ~/.octoally"
  mv "$OLD_OPENFLOW_DIR" "$NEW_CONFIG_DIR"
fi

# Migrate from HiveCommand
OLD_HIVECOMMAND_DIR="$TARGET_HOME/.hivecommand"
if [ -d "$OLD_HIVECOMMAND_DIR" ] && [ ! -d "$NEW_CONFIG_DIR" ]; then
  log_info "Migrating config directory: ~/.hivecommand → ~/.octoally"
  mv "$OLD_HIVECOMMAND_DIR" "$NEW_CONFIG_DIR"
fi

# Migrate database: openflow.db → octoally.db
if [ -d "$NEW_CONFIG_DIR" ] && [ -f "$NEW_CONFIG_DIR/openflow.db" ] && [ ! -f "$NEW_CONFIG_DIR/octoally.db" ]; then
  log_info "Migrating database: openflow.db → octoally.db"
  mv "$NEW_CONFIG_DIR/openflow.db" "$NEW_CONFIG_DIR/octoally.db"
  [ -f "$NEW_CONFIG_DIR/openflow.db-wal" ] && mv "$NEW_CONFIG_DIR/openflow.db-wal" "$NEW_CONFIG_DIR/octoally.db-wal"
  [ -f "$NEW_CONFIG_DIR/openflow.db-shm" ] && mv "$NEW_CONFIG_DIR/openflow.db-shm" "$NEW_CONFIG_DIR/octoally.db-shm"
fi

# Migrate database: hivecommand.db → octoally.db
if [ -d "$NEW_CONFIG_DIR" ] && [ -f "$NEW_CONFIG_DIR/hivecommand.db" ] && [ ! -f "$NEW_CONFIG_DIR/octoally.db" ]; then
  log_info "Migrating database: hivecommand.db → octoally.db"
  mv "$NEW_CONFIG_DIR/hivecommand.db" "$NEW_CONFIG_DIR/octoally.db"
  [ -f "$NEW_CONFIG_DIR/hivecommand.db-wal" ] && mv "$NEW_CONFIG_DIR/hivecommand.db-wal" "$NEW_CONFIG_DIR/octoally.db-wal"
  [ -f "$NEW_CONFIG_DIR/hivecommand.db-shm" ] && mv "$NEW_CONFIG_DIR/hivecommand.db-shm" "$NEW_CONFIG_DIR/octoally.db-shm"
fi

# Remove old OpenFlow binaries and service files
if [ -L "/usr/local/bin/openflow" ] || [ -f "/usr/local/bin/openflow" ]; then
  log_info "Removing old CLI: /usr/local/bin/openflow"
  $SUDO rm -f "/usr/local/bin/openflow"
fi
if [ -L "$TARGET_HOME/.local/bin/openflow" ] || [ -f "$TARGET_HOME/.local/bin/openflow" ]; then
  rm -f "$TARGET_HOME/.local/bin/openflow"
fi
if [ -f "/etc/systemd/system/openflow.service" ]; then
  log_info "Removing old systemd service: openflow.service"
  $SUDO systemctl stop openflow 2>/dev/null || true
  $SUDO systemctl disable openflow 2>/dev/null || true
  $SUDO rm -f "/etc/systemd/system/openflow.service"
  $SUDO systemctl daemon-reload 2>/dev/null || true
fi
if launchctl list com.aigenius.openflow &>/dev/null 2>&1; then
  log_info "Removing old launchd service: com.aigenius.openflow"
  launchctl stop com.aigenius.openflow 2>/dev/null || true
  launchctl unload "$TARGET_HOME/Library/LaunchAgents/com.aigenius.openflow.plist" 2>/dev/null || true
  rm -f "$TARGET_HOME/Library/LaunchAgents/com.aigenius.openflow.plist"
fi

# Remove old HiveCommand binaries and service files
if [ -L "/usr/local/bin/hivecommand" ] || [ -f "/usr/local/bin/hivecommand" ]; then
  log_info "Removing old CLI: /usr/local/bin/hivecommand"
  $SUDO rm -f "/usr/local/bin/hivecommand"
fi
if [ -L "$TARGET_HOME/.local/bin/hivecommand" ] || [ -f "$TARGET_HOME/.local/bin/hivecommand" ]; then
  rm -f "$TARGET_HOME/.local/bin/hivecommand"
fi
if [ -f "/etc/systemd/system/hivecommand.service" ]; then
  log_info "Removing old systemd service: hivecommand.service"
  $SUDO systemctl stop hivecommand 2>/dev/null || true
  $SUDO systemctl disable hivecommand 2>/dev/null || true
  $SUDO rm -f "/etc/systemd/system/hivecommand.service"
  $SUDO systemctl daemon-reload 2>/dev/null || true
fi
if launchctl list com.aigenius.hivecommand &>/dev/null 2>&1; then
  log_info "Removing old launchd service: com.aigenius.hivecommand"
  launchctl stop com.aigenius.hivecommand 2>/dev/null || true
  launchctl unload "$TARGET_HOME/Library/LaunchAgents/com.aigenius.hivecommand.plist" 2>/dev/null || true
  rm -f "$TARGET_HOME/Library/LaunchAgents/com.aigenius.hivecommand.plist"
fi
# Purge old hivecommand-desktop deb package FIRST (it owns icons + desktop entries)
if dpkg -l hivecommand-desktop &>/dev/null 2>&1; then
  log_info "Purging old hivecommand-desktop package..."
  $SUDO dpkg --purge hivecommand-desktop 2>/dev/null || true
fi
# macOS: remove old HiveCommand app from /Applications
if [ -d "/Applications/HiveCommand.app" ]; then
  log_info "Removing old app: /Applications/HiveCommand.app"
  $SUDO rm -rf "/Applications/HiveCommand.app"
fi
# Fallback: remove /opt/HiveCommand if dpkg purge missed it
if [ -d "/opt/HiveCommand" ]; then
  log_info "Removing old install: /opt/HiveCommand"
  $SUDO rm -rf "/opt/HiveCommand"
fi
# Remove old HiveCommand desktop entries (Linux + macOS) — after purge in case it left stragglers
for _dentry in /usr/share/applications/hivecommand-desktop.desktop \
               "$TARGET_HOME/.local/share/applications/hivecommand-desktop.desktop" \
               "$TARGET_HOME/.local/share/applications/HiveCommand.desktop"; do
  if [ -f "$_dentry" ]; then
    log_info "Removing old desktop entry: $_dentry"
    if [ "$(dirname "$_dentry")" = "/usr/share/applications" ]; then
      $SUDO rm -f "$_dentry"
    else
      rm -f "$_dentry"
    fi
  fi
done
# Remove old HiveCommand icons from BOTH system and user icon dirs — after purge
for _size in 16x16 22x22 24x24 32x32 48x48 64x64 128x128 256x256 512x512; do
  _sys_icon="/usr/share/icons/hicolor/${_size}/apps/hivecommand-desktop.png"
  _usr_icon="$TARGET_HOME/.local/share/icons/hicolor/${_size}/apps/hivecommand-desktop.png"
  if [ -f "$_sys_icon" ]; then
    log_info "Removing old icon: $_sys_icon"
    $SUDO rm -f "$_sys_icon"
  fi
  if [ -f "$_usr_icon" ]; then
    log_info "Removing old icon: $_usr_icon"
    rm -f "$_usr_icon"
  fi
done
# Also sweep any HiveCommand icons from pixmaps
if [ -f "/usr/share/pixmaps/hivecommand-desktop.png" ]; then
  $SUDO rm -f "/usr/share/pixmaps/hivecommand-desktop.png"
fi
# Rebuild icon caches after all removals
if command -v gtk-update-icon-cache &>/dev/null; then
  $SUDO gtk-update-icon-cache -f /usr/share/icons/hicolor/ 2>/dev/null || true
  gtk-update-icon-cache -f "$TARGET_HOME/.local/share/icons/hicolor/" 2>/dev/null || true
fi
if command -v xdg-icon-resource &>/dev/null; then
  xdg-icon-resource forceupdate 2>/dev/null || true
fi

# --- Step 2: Download release ------------------------------------------------

log_step 2 "Downloading OctoAlly..."

ARCHIVE_URL="${OCTOALLY_ARCHIVE_URL:-${HIVECOMMAND_ARCHIVE_URL:-}}"

if [ -z "$ARCHIVE_URL" ]; then
  # Resolve version from GitHub Releases API
  if [ "$VERSION" = "latest" ]; then
    log_info "Fetching latest release from GitHub..."
    RELEASE_INFO=$(curl -sf "${AUTH_HEADER[@]}" "https://api.github.com/repos/$GITHUB_REPO/releases/latest" 2>/dev/null || echo "")
    if [ -z "$RELEASE_INFO" ]; then
      RELEASE_INFO=$(curl -sf "${AUTH_HEADER[@]}" "https://api.github.com/repos/$GITHUB_REPO/releases" 2>/dev/null | node -e '
        let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
          try{const a=JSON.parse(d);if(a[0])console.log(JSON.stringify(a[0]))}catch{}
        })' 2>/dev/null || echo "")
    fi
    if [ -z "$RELEASE_INFO" ]; then
      log_error "No releases found. Set OCTOALLY_ARCHIVE_URL to install from a direct URL."
      exit 1
    fi
    VERSION=$(echo "$RELEASE_INFO" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).tag_name.replace(/^v/,""))}catch{process.exit(1)}})' 2>/dev/null)
  elif [ -n "$GITHUB_TOKEN" ]; then
    # Explicit version with token — fetch release info for API asset URL (CDN won't work for private repos)
    log_info "Fetching release v${VERSION} from GitHub API..."
    RELEASE_INFO=$(curl -sf "${AUTH_HEADER[@]}" "https://api.github.com/repos/$GITHUB_REPO/releases/tags/v${VERSION}" 2>/dev/null || echo "")
  fi

  # For private repos, extract the API asset URL (browser_download_url / CDN won't work with token)
  if [ -n "$GITHUB_TOKEN" ] && [ -n "${RELEASE_INFO:-}" ]; then
    ARCHIVE_URL=$(echo "$RELEASE_INFO" | node -e '
      let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
        try{const r=JSON.parse(d);const a=(r.assets||[]).find(x=>x.name.endsWith(".tar.gz"));
        if(a)console.log(a.url);else process.exit(1)}catch{process.exit(1)}
      })' 2>/dev/null || echo "")
  fi

  if [ -z "$ARCHIVE_URL" ]; then
    ARCHIVE_URL="https://github.com/$GITHUB_REPO/releases/download/v${VERSION}/octoally-v${VERSION}.tar.gz"
  fi
fi

TMPFILE=$(mktemp)
log_info "Downloading $ARCHIVE_URL..."
if ! curl -fSL "${AUTH_HEADER[@]}" -H "Accept: application/octet-stream" --progress-bar -o "$TMPFILE" "$ARCHIVE_URL" 2>&1; then
  rm -f "$TMPFILE"
  log_error "Download failed. Check the URL or version and try again."
  exit 1
fi

log_ok "Downloaded ($(du -h "$TMPFILE" | cut -f1))"

# --- Step 3: Extract and install ---------------------------------------------

log_step 3 "Installing to $INSTALL_DIR..."

# Stop existing server if running — try PID file first, then CLI, then pkill.
# Check both old (hivecommand) and new (octoally) names for upgrade scenarios.
_stop_pid_file() {
  local pidfile="$1"
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile" 2>/dev/null || echo "")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log_info "Stopping existing server (PID $pid)..."
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    fi
  fi
}
_stop_pid_file "$INSTALL_DIR/.octoally.pid"
_stop_pid_file "$INSTALL_DIR/.hivecommand.pid"
_stop_pid_file "$TARGET_HOME/hivecommand/.hivecommand.pid"
_stop_pid_file "$TARGET_HOME/hivecommand/.octoally.pid"
# Fallback: use CLI stop if available (try both old and new names)
if command -v octoally &>/dev/null; then
  octoally stop 2>/dev/null || true
fi
if command -v hivecommand &>/dev/null; then
  hivecommand stop 2>/dev/null || true
fi
# Fallback: kill any remaining server process on our port. Respect a
# user-customized port — read from existing server/.env or settings DB before
# the extraction replaces $INSTALL_DIR. Falls back to 42010.
_resolve_install_port() {
  local default_port=42010
  if [ -n "${PORT:-}" ] && [[ "${PORT}" =~ ^[0-9]+$ ]]; then echo "$PORT"; return; fi
  local env_file="$INSTALL_DIR/server/.env"
  if [ -f "$env_file" ]; then
    local p
    p=$(grep -E '^[[:space:]]*PORT[[:space:]]*=' "$env_file" 2>/dev/null | tail -1 \
        | sed -E 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*//; s/^["'"'"']//; s/["'"'"'][[:space:]]*$//; s/[[:space:]]*$//' || true)
    if [[ "$p" =~ ^[0-9]+$ ]]; then echo "$p"; return; fi
  fi
  local db="$TARGET_HOME/.octoally/octoally.db"
  if [ -f "$db" ]; then
    local p=""
    if command -v sqlite3 >/dev/null 2>&1; then
      p=$(sqlite3 "$db" "SELECT value FROM settings WHERE key='server_port' LIMIT 1;" 2>/dev/null || true)
    elif command -v node >/dev/null 2>&1 && [ -d "$INSTALL_DIR/server/node_modules/better-sqlite3" ]; then
      p=$(DB="$db" NM="$INSTALL_DIR/server/node_modules" node -e '
        try { const D=require(process.env.NM+"/better-sqlite3");
          const db=new D(process.env.DB,{readonly:true,fileMustExist:true});
          const r=db.prepare("SELECT value FROM settings WHERE key=?").get("server_port");
          db.close(); if(r&&r.value) process.stdout.write(String(r.value));
        } catch(e){}' 2>/dev/null || true)
    fi
    if [[ "$p" =~ ^[0-9]+$ ]]; then echo "$p"; return; fi
  fi
  echo "$default_port"
}
KILL_PORT="$(_resolve_install_port)"
if command -v fuser &>/dev/null; then
  if fuser -s "${KILL_PORT}/tcp" 2>/dev/null; then
    log_info "Force-stopping process on port ${KILL_PORT}..."
    fuser -k -TERM "${KILL_PORT}/tcp" 2>/dev/null || true
    sleep 1
    fuser -s "${KILL_PORT}/tcp" 2>/dev/null && fuser -k -KILL "${KILL_PORT}/tcp" 2>/dev/null || true
  fi
elif command -v lsof &>/dev/null; then
  # macOS: lsof is available where fuser is not
  pids="$(lsof -ti "tcp:${KILL_PORT}" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    log_info "Force-stopping process on port ${KILL_PORT}..."
    echo "$pids" | xargs -r kill -TERM 2>/dev/null || true
    sleep 1
    pids="$(lsof -ti "tcp:${KILL_PORT}" 2>/dev/null || true)"
    [ -n "$pids" ] && echo "$pids" | xargs -r kill -KILL 2>/dev/null || true
  fi
fi

# Catch stale octoally servers the port-based kill above missed. Port-based
# detection is blind to any prior install bound to a non-default port — a
# leftover server on 42011 (old default) or a dev-mode PORT=42012 survives
# every subsequent upgrade. Mirrors octoally-pro's _kill_stale_pro_servers.
#
# CRITICAL: match "octoally/server" WITHOUT matching "octoally-pro/server".
# Pro is a separate app with its own installer; we must never touch it. Every
# pattern below either explicitly excludes "octoally-pro" or uses a case
# ordering that short-circuits on it first. Verified against a machine running
# both apps before shipping.
_kill_stale_octoally_servers() {
  local target_uid
  target_uid=$(id -u "$TARGET_USER" 2>/dev/null || echo "")
  [ -z "$target_uid" ] && return 0

  local pids=""

  # Pattern 1: pgrep cmdline match, then explicitly filter out Pro cmdlines.
  # pgrep's regex doesn't do negative lookahead, so we post-filter instead.
  if command -v pgrep >/dev/null 2>&1; then
    for pid in $(pgrep -u "$target_uid" -f 'octoally/server/dist/index\.js' 2>/dev/null); do
      local cl
      cl=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || echo '')
      case "$cl" in
        *octoally-pro*) continue ;;
      esac
      pids="$pids $pid"
    done
  fi

  # Pattern 2: Linux /proc/cwd — case ordering matters. Pro exclusion fires
  # FIRST so "*/octoally-pro/server/*" short-circuits before it could match
  # "*/octoally/server/*".
  if [ -d /proc ]; then
    for pid_dir in /proc/[0-9]*; do
      local pid="${pid_dir##*/}"
      [ "$pid" = "$$" ] && continue
      [ "$pid" = "$PPID" ] && continue
      local p_uid
      p_uid=$(stat -c %u "$pid_dir" 2>/dev/null || echo "-1")
      [ "$p_uid" = "$target_uid" ] || continue
      local cwd
      cwd=$(readlink "$pid_dir/cwd" 2>/dev/null || true)
      case "$cwd" in
        */octoally-pro/*) continue ;;
        */octoally/server|*/octoally/server/*) ;;
        *) continue ;;
      esac
      local cmdline
      cmdline=$(tr '\0' ' ' < "$pid_dir/cmdline" 2>/dev/null || true)
      case "$cmdline" in
        *pty-worker*) continue ;;
        *octoally-pro*) continue ;;
        *node*dist/index.js*) pids="$pids $pid" ;;
      esac
    done
  fi

  pids=$(echo "$pids" | tr ' ' '\n' | sort -u | grep -v '^$' || true)
  [ -z "$pids" ] && return 0

  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    log_info "Stopping stale octoally server (PID $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 2
  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}
_kill_stale_octoally_servers

# Kill running desktop app — SIGTERM first, then SIGKILL after 1s.
# Electron hangs on close when the server is dead (webview stuck reconnecting).
# Kill both old (hivecommand-desktop) and new (octoally-desktop) process names.
if pkill -f "hivecommand-desktop" 2>/dev/null || pkill -f "octoally-desktop" 2>/dev/null; then
  log_info "Stopping desktop app..."
  sleep 1
  pkill -9 -f "hivecommand-desktop" 2>/dev/null || true
  pkill -9 -f "octoally-desktop" 2>/dev/null || true
fi

# Extract
EXTRACT_DIR=$(mktemp -d)
tar xzf "$TMPFILE" -C "$EXTRACT_DIR"
rm -f "$TMPFILE"

EXTRACTED=$(ls -d "$EXTRACT_DIR"/octoally-* 2>/dev/null | head -1)
if [ -z "$EXTRACTED" ] || [ ! -d "$EXTRACTED" ]; then
  log_error "Archive does not contain expected octoally-vX.Y.Z directory"
  rm -rf "$EXTRACT_DIR"
  exit 1
fi

# Preserve user data from existing install
if [ -d "$INSTALL_DIR" ]; then
  for keep in logs .octoally .octoally.pid; do
    [ -e "$INSTALL_DIR/$keep" ] && cp -r "$INSTALL_DIR/$keep" "$EXTRACT_DIR/_keep_$keep" 2>/dev/null || true
  done
  rm -rf "$INSTALL_DIR"
fi

mv "$EXTRACTED" "$INSTALL_DIR"

for keep in logs .octoally .octoally.pid; do
  [ -e "$EXTRACT_DIR/_keep_$keep" ] && mv "$EXTRACT_DIR/_keep_$keep" "$INSTALL_DIR/$keep" 2>/dev/null || true
done
rm -rf "$EXTRACT_DIR"

mkdir -p "$INSTALL_DIR/logs"

# Read version from installed package
if [ -f "$INSTALL_DIR/version.json" ]; then
  VERSION=$(node -e "console.log(require('$INSTALL_DIR/version.json').version)" 2>/dev/null || echo "$VERSION")
fi

# Install server production dependencies (native modules compile on this platform)
# Reset CWD — the old $INSTALL_DIR was deleted and replaced above, so the shell's
# working directory may no longer exist (causes npm "uv_cwd" ENOENT).
cd "$INSTALL_DIR" || cd /
log_info "Installing server dependencies..."
if ! npm install --omit=dev --prefix "$INSTALL_DIR/server" 2>&1; then
  # On Node 22+, node-gyp 11.x has a known post-build ENOENT on
  # `build/node_gyp_bins` that exits non-zero even when the native module
  # actually built successfully. If better-sqlite3 and node-pty load, the
  # install is functionally complete — accept it and continue.
  if (cd "$INSTALL_DIR/server" \
       && node -e "require('better-sqlite3'); require('node-pty-prebuilt-multiarch')") >/dev/null 2>&1; then
    log_warn "npm install exited non-zero, but native modules load — continuing"
  else
    log_error "npm install failed — see errors above"
    exit 1
  fi
fi

log_ok "OctoAlly v${VERSION} installed to $INSTALL_DIR"

# --- Step 4: Install CLI -----------------------------------------------------

log_step 4 "Installing CLI..."

chmod +x "$INSTALL_DIR/bin/octoally"

# Always install to ~/.local/bin (no sudo needed)
LINK_DIR="$TARGET_HOME/.local/bin"
mkdir -p "$LINK_DIR"
ln -sf "$INSTALL_DIR/bin/octoally" "$LINK_DIR/octoally"

# Also symlink to /usr/local/bin if writable (no sudo needed) or if sudo already active
if [ -w "/usr/local/bin" ]; then
  ln -sf "$INSTALL_DIR/bin/octoally" "/usr/local/bin/octoally" 2>/dev/null || true
fi

# Add ~/.local/bin to PATH if not already there
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$LINK_DIR"; then
  SHELL_RC=""
  if [ -f "$TARGET_HOME/.bashrc" ]; then
    SHELL_RC="$TARGET_HOME/.bashrc"
  elif [ -f "$TARGET_HOME/.zshrc" ]; then
    SHELL_RC="$TARGET_HOME/.zshrc"
  elif [ -f "$TARGET_HOME/.profile" ]; then
    SHELL_RC="$TARGET_HOME/.profile"
  fi
  if [ -n "$SHELL_RC" ]; then
    if ! grep -q '.local/bin' "$SHELL_RC" 2>/dev/null; then
      echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_RC"
      log_info "Added ~/.local/bin to PATH in $(basename "$SHELL_RC")"
    fi
  fi
  export PATH="$LINK_DIR:$PATH"
fi

# Fix ownership if running as root for another user
if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
  log_info "Setting ownership to $TARGET_USER..."
  chown -R "$TARGET_USER:$TARGET_USER" "$INSTALL_DIR"
fi

log_ok "CLI: $LINK_DIR/octoally"

# --- Step 5: Start server ----------------------------------------------------

log_step 5 "Starting OctoAlly..."

# Remove legacy Tauri desktop app if installed
if command -v dpkg &>/dev/null && dpkg -l open-flow &>/dev/null 2>&1; then
  log_info "Removing legacy desktop app (Tauri)..."
  $SUDO dpkg -r open-flow 2>&1 || true
fi

# Remove old OpenFlow Electron desktop app if installed
if command -v dpkg &>/dev/null && dpkg -l openflow-desktop &>/dev/null 2>&1; then
  log_info "Removing old desktop app (openflow-desktop)..."
  $SUDO dpkg -r openflow-desktop 2>&1 || true
fi

# Start (as target user if we're root)
if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
  su - "$TARGET_USER" -c "PATH=\"$LINK_DIR:\$PATH\" octoally start"
else
  "$LINK_DIR/octoally" start
fi

# --- Step 5b: Install octoally shell function ----------------------------

# Shell function for launching Claude Code sessions from the terminal.
# Works in bash and zsh, on Linux and macOS.

OCTOALLY_FUNC_MARKER="# OctoAlly session launcher function"
OCTOALLY_FUNC_END="# end-octoally-session"
OCTOALLY_FUNC_BODY='octoally() {
  local DEFAULT_PROMPT="start up and then ask me what I want you to do. DO NOT DO ANYTHING ELSE, NO TASKS! Just initialize and then prompt me"
  local prompt="${*:-$DEFAULT_PROMPT}"

  if [ "$PWD" = "$HOME" ]; then
    echo "Note: Claude Code always prompts for workspace trust when run from your home directory. cd into a project to skip this."
  fi

  claude "$prompt"
} '"$OCTOALLY_FUNC_END"

# Cross-platform sed -i (BSD sed on macOS requires -i '', GNU sed does not)
_sed_i() {
  if [ "$OS" = "Darwin" ]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# Legacy markers for cleanup (old hivemind versions)
LEGACY_MARKERS=(
  "# HiveCommand hivemind launcher function|# end-hivecommand-hivemind"
  "# OctoAlly hivemind launcher function|# end-octoally-hivemind"
)

_install_shell_func() {
  local RC_FILE="$1"
  [ ! -f "$RC_FILE" ] && return

  # Remove all legacy versions (HiveCommand + old OctoAlly hivemind)
  for marker_pair in "${LEGACY_MARKERS[@]}"; do
    local START="${marker_pair%%|*}"
    local END="${marker_pair##*|}"
    if grep -q "$START" "$RC_FILE" 2>/dev/null; then
      if grep -q "$END" "$RC_FILE" 2>/dev/null; then
        _sed_i "/$START/,/$END/d" "$RC_FILE"
      else
        _sed_i "/$START/,/^}/d" "$RC_FILE"
      fi
    fi
    # Self-heal orphaned tails
    if grep -q "$END" "$RC_FILE" 2>/dev/null && \
       ! grep -q "$START" "$RC_FILE" 2>/dev/null; then
      _sed_i "/^trap _cleanup EXIT INT TERM/,/$END/d" "$RC_FILE"
      _sed_i '/^$/N;/^\n$/N;/^\n\n$/N;/^\n\n\n$/d' "$RC_FILE"
    fi
  done

  # Remove old OctoAlly session version if exists
  if grep -q "$OCTOALLY_FUNC_MARKER" "$RC_FILE" 2>/dev/null; then
    if grep -q "$OCTOALLY_FUNC_END" "$RC_FILE" 2>/dev/null; then
      _sed_i "/$OCTOALLY_FUNC_MARKER/,/$OCTOALLY_FUNC_END/d" "$RC_FILE"
    else
      _sed_i "/$OCTOALLY_FUNC_MARKER/,/^}/d" "$RC_FILE"
    fi
  fi

  echo "" >> "$RC_FILE"
  echo "$OCTOALLY_FUNC_MARKER" >> "$RC_FILE"
  echo "$OCTOALLY_FUNC_BODY" >> "$RC_FILE"
  log_ok "Installed octoally() shell function in $(basename "$RC_FILE")"
}

_install_shell_func "$TARGET_HOME/.bashrc"
_install_shell_func "$TARGET_HOME/.zshrc"

# --- Step 6: Desktop app (optional) ------------------------------------------

log_step 6 "Desktop app..."

# Determine what desktop file we'd look for on this OS
DESKTOP_URL="${OCTOALLY_DESKTOP_URL:-${HIVECOMMAND_DESKTOP_URL:-}}"
DESKTOP_FILE=""
DESKTOP_SUPPORTED=true

case "$OS" in
  Linux*)
    DESKTOP_FILE="octoally-desktop_${VERSION}_amd64.deb"
    ;;
  Darwin*)
    ARCH="$(uname -m)"
    if [ "$ARCH" = "arm64" ]; then
      DESKTOP_FILE="OctoAlly-${VERSION}-arm64.dmg"
    else
      DESKTOP_FILE="OctoAlly-${VERSION}.dmg"
    fi
    ;;
  *)
    DESKTOP_SUPPORTED=false
    ;;
esac

if [ -z "$DESKTOP_URL" ] && [ -n "$DESKTOP_FILE" ]; then
  # Try CDN URL first (fast for public repos)
  CDN_URL="https://github.com/$GITHUB_REPO/releases/download/v${VERSION}/${DESKTOP_FILE}"
  DESKTOP_URL="$CDN_URL"
fi

# Check if the desktop binary actually exists
DESKTOP_AVAILABLE=false
if [ "$DESKTOP_SUPPORTED" = true ] && [ -n "$DESKTOP_URL" ]; then
  if [[ "$DESKTOP_URL" == file://* ]]; then
    local_path="${DESKTOP_URL#file://}"
    [ -f "$local_path" ] && DESKTOP_AVAILABLE=true
  elif curl -sfIL "${AUTH_HEADER[@]}" --max-time 5 "$DESKTOP_URL" >/dev/null 2>&1; then
    DESKTOP_AVAILABLE=true
  else
    # CDN URL failed — try finding the asset via API (private repo or version mismatch)
    if [ -n "$GITHUB_TOKEN" ]; then
      if [ -z "${RELEASE_INFO:-}" ]; then
        RELEASE_INFO=$(curl -sf "${AUTH_HEADER[@]}" "https://api.github.com/repos/$GITHUB_REPO/releases/tags/v${VERSION}" 2>/dev/null || echo "")
      fi
    fi
    if [ -n "$GITHUB_TOKEN" ] && [ -n "${RELEASE_INFO:-}" ]; then
      # Search for any .deb (Linux) or .dmg (macOS) asset in the release
      case "$OS" in
        Linux*)  ASSET_PATTERN=".deb" ;;
        Darwin*) ASSET_PATTERN=".dmg" ;;
      esac
      API_URL=$(echo "$RELEASE_INFO" | node -e "
        let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
          try{const r=JSON.parse(d);const a=(r.assets||[]).find(x=>x.name.endsWith('${ASSET_PATTERN}'));
          if(a)console.log(a.url);else process.exit(1)}catch{process.exit(1)}
        })" 2>/dev/null || echo "")
      if [ -n "$API_URL" ]; then
        DESKTOP_URL="$API_URL"
        DESKTOP_AVAILABLE=true
      fi
    fi
  fi
fi

install_desktop_app() {
  local TMPDESKTOP
  TMPDESKTOP=$(mktemp)
  log_info "Downloading desktop app..."
  if ! curl -fSL "${AUTH_HEADER[@]}" -H "Accept: application/octet-stream" --progress-bar -o "$TMPDESKTOP" "$DESKTOP_URL" 2>&1; then
    rm -f "$TMPDESKTOP"
    log_warn "Desktop app download failed — skipping (you can install it later)"
    return 0
  fi

  # Kill any running desktop app before installing — dpkg replaces the binary
  # while the old process is still running, causing crashes and tray conflicts.
  # SIGTERM then SIGKILL — Electron hangs on close when server is dead.
  pkill -f "octoally-desktop" 2>/dev/null || true
  sleep 1
  pkill -9 -f "octoally-desktop" 2>/dev/null || true
  sleep 1  # wait for process to fully exit and release tray

  case "$OS" in
    Linux*)
      log_info "Installing desktop app (.deb)..."
      $SUDO dpkg -i "$TMPDESKTOP" 2>&1 || $SUDO apt-get install -f -y -qq 2>&1
      rm -f "$TMPDESKTOP"
      log_ok "Desktop app installed (launch from app menu or run: octoally-desktop)"

      # Configure espanso text expander if installed — xterm.js in Electron needs
      # clipboard backend instead of inject mode for text expansion to work
      ESPANSO_CONFIG_DIR="${TARGET_HOME}/.config/espanso/config"
      if [ -d "$ESPANSO_CONFIG_DIR" ] && [ ! -f "$ESPANSO_CONFIG_DIR/octoally.yml" ]; then
        cat > "$ESPANSO_CONFIG_DIR/octoally.yml" << 'ESPANSO_EOF'
# OctoAlly: force clipboard backend for text expansion in xterm.js/Electron
filter_class: octoally-desktop
backend: Clipboard
fast_inject: false
paste_shortcut: CTRL+SHIFT+V
apply_patch: false
ESPANSO_EOF
        if [ -n "${SUDO_USER:-}" ]; then
          chown "$TARGET_USER:$TARGET_USER" "$ESPANSO_CONFIG_DIR/octoally.yml"
        fi
        log_ok "Configured espanso text expander for OctoAlly"
      fi
      # Remove old espanso config if present
      [ -f "$ESPANSO_CONFIG_DIR/hivecommand.yml" ] && rm -f "$ESPANSO_CONFIG_DIR/hivecommand.yml" || true
      ;;
    Darwin*)
      log_info "Mounting DMG..."
      local MOUNT_DIR
      # hdiutil -plist gives reliable XML output; extract mount point from it
      local HDIUTIL_OUT
      HDIUTIL_OUT=$(hdiutil attach "$TMPDESKTOP" -nobrowse -plist 2>/dev/null || echo "")
      if [ -n "$HDIUTIL_OUT" ]; then
        MOUNT_DIR=$(echo "$HDIUTIL_OUT" | grep -A1 'mount-point' | grep '<string>' | sed 's/.*<string>\(.*\)<\/string>.*/\1/' | head -1)
      fi
      if [ -n "$MOUNT_DIR" ] && [ -d "$MOUNT_DIR" ]; then
        # Find the .app inside the mounted DMG
        local APP_PATH
        APP_PATH=$(find "$MOUNT_DIR" -maxdepth 1 -name "*.app" -type d | head -1)
        if [ -n "$APP_PATH" ]; then
          local APP_NAME
          APP_NAME=$(basename "$APP_PATH")
          rm -rf "/Applications/$APP_NAME" 2>/dev/null || true
          if cp -R "$APP_PATH" /Applications/; then
            log_ok "Desktop app installed to /Applications/$APP_NAME"
          else
            log_warn "Failed to copy app to /Applications — install manually from the DMG"
          fi
        else
          log_warn "No .app found in DMG — install manually from GitHub Releases"
        fi
        hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || true
      else
        log_warn "Failed to mount DMG — install manually from GitHub Releases"
      fi
      rm -f "$TMPDESKTOP"
      ;;
  esac
}

# Detect if desktop app is already installed (upgrade vs. fresh install)
DESKTOP_ALREADY_INSTALLED=false
case "$OS" in
  Linux*)
    command -v octoally-desktop &>/dev/null && DESKTOP_ALREADY_INSTALLED=true
    dpkg -l octoally-desktop &>/dev/null 2>&1 && DESKTOP_ALREADY_INSTALLED=true
    ;;
  Darwin*)
    [ -d "/Applications/OctoAlly.app" ] && DESKTOP_ALREADY_INSTALLED=true
    ;;
esac

DESKTOP_INSTALLED_NOW=false
if [ "$DESKTOP_SUPPORTED" = false ]; then
  log_warn "Desktop app is not available for this platform yet"
elif [ "$DESKTOP_AVAILABLE" = false ]; then
  log_info "Desktop app not found for this release — download from GitHub Releases or use the web dashboard at http://localhost:42010"
elif [ "$DESKTOP_ALREADY_INSTALLED" = true ]; then
  # Already installed — update without asking
  log_info "Updating desktop app..."
  install_desktop_app
  DESKTOP_INSTALLED_NOW=true
elif [ "${OCTOALLY_NONINTERACTIVE:-${HIVECOMMAND_NONINTERACTIVE:-}}" = "1" ]; then
  log_info "Desktop app available — skipping in non-interactive mode"
elif [ -e /dev/tty ]; then
  # Interactive — prompt (works even when piped: curl | bash)
  echo ""
  echo -n "Install the OctoAlly desktop app? [y/N]: "
  read -r answer < /dev/tty 2>/dev/null || answer="n"
  case "$answer" in
    [yY]|[yY][eE][sS])
      install_desktop_app
      DESKTOP_INSTALLED_NOW=true
      ;;
    *)
      log_info "Skipped (install later from GitHub Releases)"
      ;;
  esac
else
  log_info "Desktop app available — run installer interactively to install, or download from GitHub Releases"
fi

# --- Done --------------------------------------------------------------------

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  OctoAlly v${VERSION} installed successfully!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Dashboard${NC}   http://localhost:42010"
echo -e "  ${BOLD}CLI${NC}         $LINK_DIR/octoally"
echo -e "  ${BOLD}Install${NC}     $INSTALL_DIR"
if [ "$DESKTOP_INSTALLED_NOW" = true ]; then
  echo -e "  ${BOLD}Desktop${NC}     Installed"
fi
echo ""
echo -e "  ${BOLD}Commands:${NC}"
echo "    octoally                   Launch Claude Code session"
echo "    octoally status            Check status"
echo "    octoally stop / start      Stop or start the server"
echo "    octoally update            Update to latest release"
echo "    octoally install-service   Auto-start on boot"
echo ""

# Auto-launch desktop app if it was just installed/updated
if [ "$DESKTOP_INSTALLED_NOW" = true ]; then
  if [ "${OCTOALLY_NONINTERACTIVE:-${HIVECOMMAND_NONINTERACTIVE:-}}" = "1" ]; then
    # Non-interactive (dashboard-triggered update) — launch immediately
    case "$OS" in
      Linux*)  nohup octoally-desktop &>/dev/null & disown ;;
      Darwin*) open -a OctoAlly ;;
    esac
  elif [ -e /dev/tty ]; then
    echo -e "  Press ${BOLD}Enter${NC} to launch OctoAlly, or ${BOLD}Ctrl+C${NC} to exit."
    read -r < /dev/tty 2>/dev/null || true
    case "$OS" in
      Linux*)  nohup octoally-desktop &>/dev/null & disown ;;
      Darwin*) open -a OctoAlly ;;
    esac
  fi
fi
