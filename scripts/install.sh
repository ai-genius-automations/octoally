#!/usr/bin/env bash
# OpenFlow Installer
# Downloads a pre-built release, extracts it, and starts the server.
#
# Prerequisites:
#   - Node.js 20+    https://nodejs.org
#   - Claude Code     npm install -g @anthropic-ai/claude-code
#
# IMPORTANT: You must run `claude` at least once and accept the terms before
# installing OpenFlow. Sessions require non-interactive mode, so you must also
# run: claude --dangerously-skip-permissions
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ai-genius-automations/openflow/main/scripts/install.sh | bash
#   OPENFLOW_VERSION=0.1.0 bash install.sh
#   OPENFLOW_INSTALL_DIR=/opt/openflow bash install.sh
#
# For private repos / pre-release testing:
#   OPENFLOW_ARCHIVE_URL="https://example.com/openflow-v0.1.0.tar.gz" bash install.sh

set -euo pipefail

INSTALL_DIR="${OPENFLOW_INSTALL_DIR:-$HOME/openflow}"
GITHUB_REPO="${OPENFLOW_GITHUB_REPO:-ai-genius-automations/openflow}"
VERSION="${OPENFLOW_VERSION:-latest}"
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

log_info()  { echo -e "${CYAN}[OpenFlow]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OpenFlow]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[OpenFlow]${NC} $1"; }
log_error() { echo -e "${RED}[OpenFlow]${NC} $1"; }
log_step()  { echo -e "\n${BOLD}[$1/$TOTAL_STEPS] $2${NC}"; }

TOTAL_STEPS=6

# Detect the target user (if running as root via sudo, install for the real user)
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  TARGET_USER="$SUDO_USER"
  TARGET_HOME=$(eval echo "~$SUDO_USER")
  INSTALL_DIR="${OPENFLOW_INSTALL_DIR:-$TARGET_HOME/openflow}"
elif [ "$(id -u)" -eq 0 ]; then
  TARGET_USER="root"
  TARGET_HOME="$HOME"
else
  TARGET_USER="$(whoami)"
  TARGET_HOME="$HOME"
fi

OS="$(uname -s)"

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
      apt-get update -qq
      apt-get install -y -qq ca-certificates curl gnupg
      mkdir -p /etc/apt/keyrings
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list > /dev/null
      apt-get update -qq
      apt-get install -y -qq nodejs
      ;;
    Darwin*)
      if command -v brew &>/dev/null; then
        brew install node 2>&1 | tail -1
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
  npm install -g @anthropic-ai/claude-code 2>&1 | tail -1
  if ! command -v claude &>/dev/null; then
    log_error "Claude Code installation failed. Install manually: npm install -g @anthropic-ai/claude-code"
    exit 1
  fi
  log_ok "Claude Code $(claude --version 2>/dev/null || echo 'installed')"
fi

# Check if Claude Code has been run with --dangerously-skip-permissions
# This is required for OpenFlow to run non-interactive agent sessions.
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
  echo "  OpenFlow requires Claude Code to be set up with non-interactive permissions."
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
      apt-get update -qq
      apt-get install -y -qq "${NEEDED[@]}"
    fi
    ;;
  Darwin*)
    if [ ${#NEEDED[@]} -gt 0 ] && command -v brew &>/dev/null; then
      log_info "Installing: ${NEEDED[*]}..."
      brew install "${NEEDED[@]}" 2>&1 | tail -1
    fi
    ;;
esac

log_ok "Prerequisites met (Node $(node -v), Claude Code $(claude --version 2>/dev/null || echo 'ok'))"

# --- Step 2: Download release ------------------------------------------------

log_step 2 "Downloading OpenFlow..."

ARCHIVE_URL="${OPENFLOW_ARCHIVE_URL:-}"

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
      log_error "No releases found. Set OPENFLOW_ARCHIVE_URL to install from a direct URL."
      exit 1
    fi
    VERSION=$(echo "$RELEASE_INFO" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).tag_name.replace(/^v/,""))}catch{process.exit(1)}})' 2>/dev/null)

    # For private repos, extract the API asset URL (browser_download_url won't work with token)
    if [ -n "$GITHUB_TOKEN" ]; then
      ARCHIVE_URL=$(echo "$RELEASE_INFO" | node -e '
        let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
          try{const r=JSON.parse(d);const a=(r.assets||[]).find(x=>x.name.endsWith(".tar.gz"));
          if(a)console.log(a.url);else process.exit(1)}catch{process.exit(1)}
        })' 2>/dev/null || echo "")
    fi
  fi

  if [ -z "$ARCHIVE_URL" ]; then
    ARCHIVE_URL="https://github.com/$GITHUB_REPO/releases/download/v${VERSION}/openflow-v${VERSION}.tar.gz"
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
if [ -f "$INSTALL_DIR/.openflow.pid" ]; then
  local_pid=$(cat "$INSTALL_DIR/.openflow.pid" 2>/dev/null || echo "")
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

EXTRACTED=$(ls -d "$EXTRACT_DIR"/openflow-* 2>/dev/null | head -1)
if [ -z "$EXTRACTED" ] || [ ! -d "$EXTRACTED" ]; then
  log_error "Archive does not contain expected openflow-vX.Y.Z directory"
  rm -rf "$EXTRACT_DIR"
  exit 1
fi

# Preserve user data from existing install
if [ -d "$INSTALL_DIR" ]; then
  for keep in logs .openflow .openflow.pid; do
    [ -e "$INSTALL_DIR/$keep" ] && cp -r "$INSTALL_DIR/$keep" "$EXTRACT_DIR/_keep_$keep" 2>/dev/null || true
  done
  rm -rf "$INSTALL_DIR"
fi

mv "$EXTRACTED" "$INSTALL_DIR"

for keep in logs .openflow .openflow.pid; do
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
npm ci --omit=dev --prefix "$INSTALL_DIR/server" 2>&1 | tail -3

log_ok "OpenFlow v${VERSION} installed to $INSTALL_DIR"

# --- Step 4: Install CLI -----------------------------------------------------

log_step 4 "Installing CLI..."

chmod +x "$INSTALL_DIR/bin/openflow"

LINK_DIR="/usr/local/bin"
if [ ! -w "$LINK_DIR" ]; then
  LINK_DIR="$TARGET_HOME/.local/bin"
  mkdir -p "$LINK_DIR"
fi

ln -sf "$INSTALL_DIR/bin/openflow" "$LINK_DIR/openflow"

# Fix ownership if running as root for another user
if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
  log_info "Setting ownership to $TARGET_USER..."
  chown -R "$TARGET_USER:$TARGET_USER" "$INSTALL_DIR"
fi

log_ok "CLI: $LINK_DIR/openflow"

# --- Step 5: Start server ----------------------------------------------------

log_step 5 "Starting OpenFlow..."

# Remove legacy Tauri desktop app if installed
if command -v dpkg &>/dev/null && dpkg -l open-flow &>/dev/null 2>&1; then
  log_info "Removing legacy desktop app (Tauri)..."
  dpkg -r open-flow 2>&1 || true
fi

# Start (as target user if we're root)
if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
  su - "$TARGET_USER" -c "PATH=\"$LINK_DIR:\$PATH\" openflow start"
else
  "$LINK_DIR/openflow" start
fi

# --- Step 6: Desktop app (optional) ------------------------------------------

log_step 6 "Desktop app..."

# Determine what desktop file we'd look for on this OS
DESKTOP_URL="${OPENFLOW_DESKTOP_URL:-}"
DESKTOP_FILE=""
DESKTOP_SUPPORTED=true

case "$OS" in
  Linux*)
    DESKTOP_FILE="openflow-desktop_${VERSION}_amd64.deb"
    ;;
  Darwin*)
    DESKTOP_FILE="OpenFlow-${VERSION}.dmg"
    ;;
  *)
    DESKTOP_SUPPORTED=false
    ;;
esac

if [ -z "$DESKTOP_URL" ] && [ -n "$DESKTOP_FILE" ]; then
  DESKTOP_URL="https://github.com/$GITHUB_REPO/releases/download/v${VERSION}/${DESKTOP_FILE}"
fi

# Check if the desktop binary actually exists (HEAD request, no download)
DESKTOP_AVAILABLE=false
if [ "$DESKTOP_SUPPORTED" = true ] && [ -n "$DESKTOP_URL" ]; then
  if [[ "$DESKTOP_URL" == file://* ]]; then
    # Local file — check if it exists
    local_path="${DESKTOP_URL#file://}"
    [ -f "$local_path" ] && DESKTOP_AVAILABLE=true
  else
    # Remote URL — check with HEAD request
    if curl -sfIL "${AUTH_HEADER[@]}" --max-time 5 "$DESKTOP_URL" >/dev/null 2>&1; then
      DESKTOP_AVAILABLE=true
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
      if [ "$(id -u)" -eq 0 ]; then
        dpkg -i "$TMPDESKTOP" 2>&1 || apt-get install -f -y -qq 2>&1
      else
        sudo dpkg -i "$TMPDESKTOP" 2>&1 || sudo apt-get install -f -y -qq 2>&1
      fi
      rm -f "$TMPDESKTOP"
      log_ok "Desktop app installed (launch from app menu or run: openflow-desktop)"
      ;;
    Darwin*)
      log_info "Mounting DMG..."
      local MOUNT_DIR
      MOUNT_DIR=$(hdiutil attach "$TMPDESKTOP" -nobrowse -quiet | tail -1 | awk '{print $NF}')
      if [ -d "$MOUNT_DIR" ]; then
        cp -R "$MOUNT_DIR"/OpenFlow.app /Applications/ 2>/dev/null || true
        hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || true
        log_ok "Desktop app installed to /Applications/OpenFlow.app"
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
  case "$OS" in
    Darwin*)
      log_info "macOS desktop app is not yet available — coming soon!"
      log_info "Use the web dashboard at http://localhost:42010 in the meantime."
      ;;
    *)
      log_info "Desktop app not found for this release — use the web dashboard at http://localhost:42010"
      ;;
  esac
elif [ -e /dev/tty ]; then
  # Interactive — prompt (works even when piped: curl | bash)
  echo ""
  echo -n "Install the OpenFlow desktop app? [y/N]: "
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
echo -e "${GREEN}${BOLD}OpenFlow v${VERSION} installed and running!${NC}"
echo ""
echo "  Dashboard:  http://localhost:42010"
echo "  CLI:        $LINK_DIR/openflow"
echo "  Install:    $INSTALL_DIR"
echo ""
echo "Commands:"
echo "  openflow status            # Check status"
echo "  openflow stop              # Stop the server"
echo "  openflow start             # Start the server"
echo "  openflow update            # Update to latest release"
echo "  openflow install-service   # Auto-start on boot"
echo ""
