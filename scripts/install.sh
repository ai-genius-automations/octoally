#!/usr/bin/env bash
# HiveCommand Installer
# Downloads a pre-built release, extracts it, and starts the server.
#
# Prerequisites:
#   - Node.js 20+    https://nodejs.org
#   - Claude Code     npm install -g @anthropic-ai/claude-code
#
# IMPORTANT: You must run `claude` at least once and accept the terms before
# installing HiveCommand. Sessions require non-interactive mode, so you must also
# run: claude --dangerously-skip-permissions
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ai-genius-automations/hivecommand/main/scripts/install.sh | bash
#   HIVECOMMAND_VERSION=0.1.0 bash install.sh
#   HIVECOMMAND_INSTALL_DIR=/opt/hivecommand bash install.sh
#
# For private repos / pre-release testing:
#   HIVECOMMAND_ARCHIVE_URL="https://example.com/hivecommand-v0.1.0.tar.gz" bash install.sh

set -euo pipefail

INSTALL_DIR="${HIVECOMMAND_INSTALL_DIR:-$HOME/hivecommand}"
GITHUB_REPO="${HIVECOMMAND_GITHUB_REPO:-ai-genius-automations/hivecommand}"
VERSION="${HIVECOMMAND_VERSION:-latest}"
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

log_info()  { echo -e "${CYAN}[HiveCommand]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[HiveCommand]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[HiveCommand]${NC} $1"; }
log_error() { echo -e "${RED}[HiveCommand]${NC} $1"; }
log_step()  { echo -e "\n${BOLD}[$1/$TOTAL_STEPS] $2${NC}"; }

TOTAL_STEPS=6

# Detect the target user (if running as root via sudo, install for the real user)
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  TARGET_USER="$SUDO_USER"
  TARGET_HOME=$(eval echo "~$SUDO_USER")
  INSTALL_DIR="${HIVECOMMAND_INSTALL_DIR:-$TARGET_HOME/hivecommand}"
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
# This is required for HiveCommand to run non-interactive agent sessions.
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
  echo "  HiveCommand requires Claude Code to be set up with non-interactive permissions."
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

# --- Migrate from OpenFlow (if upgrading) ------------------------------------

OLD_CONFIG_DIR="$TARGET_HOME/.openflow"
NEW_CONFIG_DIR="$TARGET_HOME/.hivecommand"

if [ -d "$OLD_CONFIG_DIR" ] && [ ! -d "$NEW_CONFIG_DIR" ]; then
  log_info "Migrating config directory: ~/.openflow → ~/.hivecommand"
  mv "$OLD_CONFIG_DIR" "$NEW_CONFIG_DIR"
fi

if [ -d "$NEW_CONFIG_DIR" ] && [ -f "$NEW_CONFIG_DIR/openflow.db" ] && [ ! -f "$NEW_CONFIG_DIR/hivecommand.db" ]; then
  log_info "Migrating database: openflow.db → hivecommand.db"
  mv "$NEW_CONFIG_DIR/openflow.db" "$NEW_CONFIG_DIR/hivecommand.db"
  [ -f "$NEW_CONFIG_DIR/openflow.db-wal" ] && mv "$NEW_CONFIG_DIR/openflow.db-wal" "$NEW_CONFIG_DIR/hivecommand.db-wal"
  [ -f "$NEW_CONFIG_DIR/openflow.db-shm" ] && mv "$NEW_CONFIG_DIR/openflow.db-shm" "$NEW_CONFIG_DIR/hivecommand.db-shm"
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

# --- Step 2: Download release ------------------------------------------------

log_step 2 "Downloading HiveCommand..."

ARCHIVE_URL="${HIVECOMMAND_ARCHIVE_URL:-}"

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
      log_error "No releases found. Set HIVECOMMAND_ARCHIVE_URL to install from a direct URL."
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
    ARCHIVE_URL="https://github.com/$GITHUB_REPO/releases/download/v${VERSION}/hivecommand-v${VERSION}.tar.gz"
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

# Stop existing server if running
if [ -f "$INSTALL_DIR/.hivecommand.pid" ]; then
  local_pid=$(cat "$INSTALL_DIR/.hivecommand.pid" 2>/dev/null || echo "")
  if [ -n "$local_pid" ] && kill -0 "$local_pid" 2>/dev/null; then
    log_info "Stopping existing server..."
    kill "$local_pid" 2>/dev/null || true
    sleep 1
  fi
fi

# Extract
EXTRACT_DIR=$(mktemp -d)
tar xzf "$TMPFILE" -C "$EXTRACT_DIR"
rm -f "$TMPFILE"

EXTRACTED=$(ls -d "$EXTRACT_DIR"/hivecommand-* 2>/dev/null | head -1)
if [ -z "$EXTRACTED" ] || [ ! -d "$EXTRACTED" ]; then
  log_error "Archive does not contain expected hivecommand-vX.Y.Z directory"
  rm -rf "$EXTRACT_DIR"
  exit 1
fi

# Preserve user data from existing install
if [ -d "$INSTALL_DIR" ]; then
  for keep in logs .hivecommand .hivecommand.pid; do
    [ -e "$INSTALL_DIR/$keep" ] && cp -r "$INSTALL_DIR/$keep" "$EXTRACT_DIR/_keep_$keep" 2>/dev/null || true
  done
  rm -rf "$INSTALL_DIR"
fi

mv "$EXTRACTED" "$INSTALL_DIR"

for keep in logs .hivecommand .hivecommand.pid; do
  [ -e "$EXTRACT_DIR/_keep_$keep" ] && mv "$EXTRACT_DIR/_keep_$keep" "$INSTALL_DIR/$keep" 2>/dev/null || true
done
rm -rf "$EXTRACT_DIR"

mkdir -p "$INSTALL_DIR/logs"

# Read version from installed package
if [ -f "$INSTALL_DIR/version.json" ]; then
  VERSION=$(node -e "console.log(require('$INSTALL_DIR/version.json').version)" 2>/dev/null || echo "$VERSION")
fi

# Install server production dependencies (native modules compile on this platform)
log_info "Installing server dependencies..."
npm install --omit=dev --prefix "$INSTALL_DIR/server" 2>&1 | tail -3

log_ok "HiveCommand v${VERSION} installed to $INSTALL_DIR"

# --- Step 4: Install CLI -----------------------------------------------------

log_step 4 "Installing CLI..."

chmod +x "$INSTALL_DIR/bin/hivecommand"

LINK_DIR="/usr/local/bin"
if [ ! -w "$LINK_DIR" ]; then
  # Try with sudo
  if $SUDO ln -sf "$INSTALL_DIR/bin/hivecommand" "$LINK_DIR/hivecommand" 2>/dev/null; then
    : # success — symlinked to /usr/local/bin
  else
    # Fallback to ~/.local/bin and ensure it's in PATH
    LINK_DIR="$TARGET_HOME/.local/bin"
    mkdir -p "$LINK_DIR"
    ln -sf "$INSTALL_DIR/bin/hivecommand" "$LINK_DIR/hivecommand"

    # Add to PATH if not already there
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
  fi
else
  ln -sf "$INSTALL_DIR/bin/hivecommand" "$LINK_DIR/hivecommand"
fi

# Fix ownership if running as root for another user
if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
  log_info "Setting ownership to $TARGET_USER..."
  chown -R "$TARGET_USER:$TARGET_USER" "$INSTALL_DIR"
fi

log_ok "CLI: $LINK_DIR/hivecommand"

# --- Step 5: Start server ----------------------------------------------------

log_step 5 "Starting HiveCommand..."

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
  su - "$TARGET_USER" -c "PATH=\"$LINK_DIR:\$PATH\" hivecommand start"
else
  "$LINK_DIR/hivecommand" start
fi

# --- Step 5b: Install hivecommand shell function ----------------------------

# Shell function for launching hivemind sessions from the terminal with:
# - dtach persistence (session survives terminal close)
# - Process cleanup on exit (kills spawned daemons)
# - Sidecar files for HiveCommand dashboard adoption
# Works in bash and zsh, on Linux and macOS.

HIVECOMMAND_FUNC_MARKER="# HiveCommand hivemind launcher function"
HIVECOMMAND_FUNC_END="# end-hivecommand-hivemind"
HIVECOMMAND_FUNC_BODY='hivecommand() {
  local DEFAULT_PROMPT="start up and then ask me what I want you to do. DO NOT DO ANYTHING ELSE, NO TASKS! Just initialize and then prompt me"
  local prompt="${*:-$DEFAULT_PROMPT}"

  if [ "$PWD" = "$HOME" ]; then
    echo "Note: Claude Code always prompts for workspace trust when run from your home directory. cd into a project to skip this."
  fi

  # Resolve ruflo-run.sh (shared cache or npx fallback)
  local RUFLO_RUN="$HOME/.hivecommand/ruflo-run.sh"
  if [ ! -f "$RUFLO_RUN" ]; then
    echo "ruflo-run.sh not found. Using npx (slower)."
    RUFLO_RUN=""
  fi

  _hc_run_ruflo() {
    if [ -n "$RUFLO_RUN" ]; then
      bash "$RUFLO_RUN" "$@"
    else
      npx ruflo@latest "$@"
    fi
  }

  # Check for dtach — fall back to direct mode if missing
  if ! command -v dtach &>/dev/null; then
    echo "dtach not found, running without session persistence."
    local before=$(pgrep -f "cli.js daemon" 2>/dev/null | sort)
    local _hc_cleaned=0
    _hc_cleanup() {
      [ "$_hc_cleaned" = "1" ] && return
      _hc_cleaned=1
      echo ""
      echo "Cleaning up hive-mind processes..."
      local after=$(pgrep -f "cli.js daemon" 2>/dev/null | sort)
      local new_daemons=$(comm -13 <(echo "$before") <(echo "$after"))
      for pid in $new_daemons; do
        pkill -P "$pid" 2>/dev/null
        kill "$pid" 2>/dev/null
      done
      sleep 1
      for pid in $new_daemons; do
        kill -9 "$pid" 2>/dev/null
      done
      trap - EXIT INT TERM HUP
    }
    trap _hc_cleanup EXIT INT TERM HUP
    _hc_run_ruflo hive-mind spawn "$prompt" --claude
    _hc_cleanup
    return
  fi

  # --- dtach mode: session survives terminal close ---
  local sid="$(date +%s)-$$"
  local sock="/tmp/hivemind-${sid}.sock"

  # Write sidecar files for HiveCommand dashboard discovery/adoption
  printf '\''%s\n'\'' "$(pwd)" > "/tmp/hivemind-${sid}.info"
  printf '\''%s\n'\'' "$(date -Iseconds)" >> "/tmp/hivemind-${sid}.info"
  printf '\''%s'\'' "$prompt" > "/tmp/hivemind-${sid}.prompt"

  # Write inner script (cleanup lives inside dtach so it works after detach)
  local inner="/tmp/hivemind-${sid}.run"
  cat > "$inner" <<'\''RUNEOF'\''
#!/bin/bash
SOCK="$1"; shift
PROMPT_FILE="${SOCK%.sock}.prompt"
INFO_FILE="${SOCK%.sock}.info"
PROMPT="$(cat "$PROMPT_FILE" 2>/dev/null)"

before=$(pgrep -f "cli.js daemon" 2>/dev/null | sort)
_cleaned=0
_cleanup() {
  [ "$_cleaned" = "1" ] && return; _cleaned=1
  echo ""; echo "Cleaning up hive-mind processes..."
  after=$(pgrep -f "cli.js daemon" 2>/dev/null | sort)
  for pid in $(comm -13 <(echo "$before") <(echo "$after")); do
    pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null
  done
  sleep 1
  for pid in $(comm -13 <(echo "$before") <(echo "$after")); do
    kill -9 "$pid" 2>/dev/null
  done
  rm -f "$SOCK" "$PROMPT_FILE" "$INFO_FILE" "$0"
  trap - EXIT INT TERM
}
trap _cleanup EXIT INT TERM

RUFLO_RUN="$HOME/.hivecommand/ruflo-run.sh"
if [ -f "$RUFLO_RUN" ]; then
  bash "$RUFLO_RUN" hive-mind spawn "$PROMPT" --claude
else
  npx ruflo@latest hive-mind spawn "$PROMPT" --claude
fi
_cleanup
RUNEOF
  chmod +x "$inner"

  # Create dtach session in background, then attach
  dtach -n "$sock" -Ez bash "$inner" "$sock"
  sleep 0.2
  dtach -a "$sock" -Ez

  # If socket still exists after attach returns, session was detached (not exited)
  if [ -S "$sock" ]; then
    echo ""
    echo "Session detached — still running in background."
    echo "Reattach: dtach -a $sock -Ez"
    echo "Or adopt in HiveCommand dashboard."
  fi
} '"$HIVECOMMAND_FUNC_END"

_install_shell_func() {
  local RC_FILE="$1"
  [ ! -f "$RC_FILE" ] && return

  # Remove old version if exists (uses end-marker for safe removal)
  if grep -q "$HIVECOMMAND_FUNC_MARKER" "$RC_FILE" 2>/dev/null; then
    if grep -q "$HIVECOMMAND_FUNC_END" "$RC_FILE" 2>/dev/null; then
      sed -i "/$HIVECOMMAND_FUNC_MARKER/,/$HIVECOMMAND_FUNC_END/d" "$RC_FILE"
    else
      # Fallback: remove from marker to closing brace on its own line
      sed -i "/$HIVECOMMAND_FUNC_MARKER/,/^}/d" "$RC_FILE"
    fi
  fi

  # Self-heal: remove orphaned tails left by buggy earlier installers
  # The end marker without a matching start marker means partial removal occurred
  if grep -q "$HIVECOMMAND_FUNC_END" "$RC_FILE" 2>/dev/null && \
     ! grep -q "$HIVECOMMAND_FUNC_MARKER" "$RC_FILE" 2>/dev/null; then
    # Find and remove everything from the orphaned heredoc body to the end marker
    sed -i "/^trap _cleanup EXIT INT TERM/,/$HIVECOMMAND_FUNC_END/d" "$RC_FILE"
    # Clean up any remaining blank lines left behind (collapse runs of >3 blanks)
    sed -i '/^$/N;/^\n$/N;/^\n\n$/N;/^\n\n\n$/d' "$RC_FILE"
  fi

  echo "" >> "$RC_FILE"
  echo "$HIVECOMMAND_FUNC_MARKER" >> "$RC_FILE"
  echo "$HIVECOMMAND_FUNC_BODY" >> "$RC_FILE"
  log_ok "Installed hivecommand() shell function in $(basename "$RC_FILE")"
}

_install_shell_func "$TARGET_HOME/.bashrc"
_install_shell_func "$TARGET_HOME/.zshrc"

# --- Step 6: Desktop app (optional) ------------------------------------------

log_step 6 "Desktop app..."

# Determine what desktop file we'd look for on this OS
DESKTOP_URL="${HIVECOMMAND_DESKTOP_URL:-}"
DESKTOP_FILE=""
DESKTOP_SUPPORTED=true

case "$OS" in
  Linux*)
    DESKTOP_FILE="hivecommand-desktop_${VERSION}_amd64.deb"
    ;;
  Darwin*)
    ARCH="$(uname -m)"
    if [ "$ARCH" = "arm64" ]; then
      DESKTOP_FILE="HiveCommand-${VERSION}-arm64.dmg"
    else
      DESKTOP_FILE="HiveCommand-${VERSION}.dmg"
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

  case "$OS" in
    Linux*)
      log_info "Installing desktop app (.deb)..."
      $SUDO dpkg -i "$TMPDESKTOP" 2>&1 || $SUDO apt-get install -f -y -qq 2>&1
      rm -f "$TMPDESKTOP"
      log_ok "Desktop app installed (launch from app menu or run: hivecommand-desktop)"

      # Configure espanso text expander if installed — xterm.js in Electron needs
      # clipboard backend instead of inject mode for text expansion to work
      ESPANSO_CONFIG_DIR="${TARGET_HOME}/.config/espanso/config"
      if [ -d "$ESPANSO_CONFIG_DIR" ] && [ ! -f "$ESPANSO_CONFIG_DIR/hivecommand.yml" ]; then
        cat > "$ESPANSO_CONFIG_DIR/hivecommand.yml" << 'ESPANSO_EOF'
# HiveCommand: force clipboard backend for text expansion in xterm.js/Electron
filter_class: hivecommand-desktop
backend: Clipboard
fast_inject: false
paste_shortcut: CTRL+SHIFT+V
apply_patch: false
ESPANSO_EOF
        if [ -n "${SUDO_USER:-}" ]; then
          chown "$TARGET_USER:$TARGET_USER" "$ESPANSO_CONFIG_DIR/hivecommand.yml"
        fi
        log_ok "Configured espanso text expander for HiveCommand"
      fi
      ;;
    Darwin*)
      log_info "Mounting DMG..."
      local MOUNT_DIR
      MOUNT_DIR=$(hdiutil attach "$TMPDESKTOP" -nobrowse -quiet | tail -1 | awk '{print $NF}')
      if [ -d "$MOUNT_DIR" ]; then
        cp -R "$MOUNT_DIR"/HiveCommand.app /Applications/ 2>/dev/null || true
        hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || true
        log_ok "Desktop app installed to /Applications/HiveCommand.app"
      else
        log_warn "Failed to mount DMG — install manually from GitHub Releases"
      fi
      rm -f "$TMPDESKTOP"
      ;;
  esac
}

if [ "$DESKTOP_SUPPORTED" = false ]; then
  log_warn "Desktop app is not available for this platform yet"
elif [ "$DESKTOP_AVAILABLE" = false ]; then
  log_info "Desktop app not found for this release — download from GitHub Releases or use the web dashboard at http://localhost:42010"
elif [ -e /dev/tty ]; then
  # Interactive — prompt (works even when piped: curl | bash)
  echo ""
  echo -n "Install the HiveCommand desktop app? [y/N]: "
  read -r answer < /dev/tty 2>/dev/null || answer="n"
  case "$answer" in
    [yY]|[yY][eE][sS])
      install_desktop_app
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
echo -e "${GREEN}${BOLD}HiveCommand v${VERSION} installed and running!${NC}"
echo ""
echo "  Dashboard:  http://localhost:42010"
echo "  CLI:        $LINK_DIR/hivecommand"
echo "  Install:    $INSTALL_DIR"
echo ""
echo "Commands:"
echo "  hivecommand                   # Launch hivemind session (CLI)"
echo "  hivecommand status            # Check status"
echo "  hivecommand stop              # Stop the server"
echo "  hivecommand start             # Start the server"
echo "  hivecommand update            # Update to latest release"
echo "  hivecommand install-service   # Auto-start on boot"
echo ""
