#!/usr/bin/env bash
# OpenFlow Installer
# Clones and sets up OpenFlow from GitHub.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ai-genius-automations/openflow/main/scripts/install.sh | bash
#   OPENFLOW_INSTALL_DIR=/opt/openflow bash install.sh
#   OPENFLOW_REPO_URL="https://TOKEN@github.com/org/repo.git" bash install.sh

set -euo pipefail

INSTALL_DIR="${OPENFLOW_INSTALL_DIR:-$HOME/openflow}"
REPO_URL="${OPENFLOW_REPO_URL:-https://github.com/ai-genius-automations/openflow.git}"
BRANCH="${OPENFLOW_BRANCH:-main}"

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

TOTAL_STEPS=7

# --- Step 1: Check for Claude Code (user must install) ------------------------

log_step 1 "Checking for Claude Code..."

if ! command -v claude &>/dev/null; then
  log_error "Claude Code is required but not installed."
  echo ""
  echo "Install Claude Code first:"
  echo "  npm install -g @anthropic-ai/claude-code"
  echo ""
  echo "Then re-run this installer."
  exit 1
fi

log_ok "Claude Code found: $(claude --version 2>/dev/null || echo 'installed')"

# --- Step 2: Install system prerequisites ------------------------------------

log_step 2 "Installing system prerequisites..."

OS="$(uname -s)"

install_linux_prereqs() {
  local NEEDED=()

  # Check what's missing
  command -v git &>/dev/null   || NEEDED+=(git)
  command -v tmux &>/dev/null  || NEEDED+=(tmux)
  command -v dtach &>/dev/null || NEEDED+=(dtach)
  dpkg -s build-essential &>/dev/null 2>&1 || NEEDED+=(build-essential)

  # Check Node.js (need 20+)
  local NEED_NODE=false
  if ! command -v node &>/dev/null; then
    NEED_NODE=true
  else
    local NODE_MAJOR
    NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
    if [ "$NODE_MAJOR" -lt 20 ]; then
      NEED_NODE=true
      log_warn "Node.js $NODE_MAJOR found, upgrading to 22..."
    fi
  fi

  if [ "$NEED_NODE" = true ]; then
    log_info "Installing Node.js 22 via NodeSource..."
    # Install NodeSource GPG key and repo
    sudo apt-get update -qq
    sudo apt-get install -y -qq ca-certificates curl gnupg
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list > /dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq nodejs
    log_ok "Node.js $(node -v) installed"
  fi

  if [ ${#NEEDED[@]} -gt 0 ]; then
    log_info "Installing: ${NEEDED[*]}..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq "${NEEDED[@]}"
    log_ok "System packages installed"
  fi
}

install_macos_prereqs() {
  # Check for Homebrew
  if ! command -v brew &>/dev/null; then
    log_error "Homebrew is required on macOS. Install it from https://brew.sh"
    exit 1
  fi

  local NEEDED=()

  command -v git &>/dev/null   || NEEDED+=(git)
  command -v tmux &>/dev/null  || NEEDED+=(tmux)
  command -v dtach &>/dev/null || NEEDED+=(dtach)

  # Check Node.js (need 20+)
  if ! command -v node &>/dev/null; then
    NEEDED+=(node)
  else
    local NODE_MAJOR
    NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
    if [ "$NODE_MAJOR" -lt 20 ]; then
      log_warn "Node.js $NODE_MAJOR found, upgrading..."
      brew upgrade node 2>&1 | tail -1
    fi
  fi

  if [ ${#NEEDED[@]} -gt 0 ]; then
    log_info "Installing: ${NEEDED[*]}..."
    brew install "${NEEDED[@]}" 2>&1 | tail -3
    log_ok "System packages installed"
  fi
}

case "$OS" in
  Linux*)  install_linux_prereqs ;;
  Darwin*) install_macos_prereqs ;;
  *)
    log_error "Unsupported OS: $OS"
    exit 1
    ;;
esac

# Verify everything is present
for cmd in node npm git tmux dtach; do
  if ! command -v "$cmd" &>/dev/null; then
    log_error "Failed to install $cmd. Please install it manually and re-run."
    exit 1
  fi
done

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  log_error "Node.js 20+ required (found v$(node -v))"
  exit 1
fi

log_ok "All prerequisites met (Node $(node -v), tmux $(tmux -V))"

# Install ruflo + claude-flow globally so per-project init doesn't re-download
if ! command -v ruflo &>/dev/null; then
  log_info "Installing RuFlo + Claude Flow CLI..."
  sudo npm install -g ruflo @claude-flow/cli 2>&1 | tail -1
  log_ok "RuFlo $(ruflo --version 2>/dev/null || echo 'installed')"
else
  log_ok "RuFlo already installed"
fi

# --- Step 3: Clone repository ------------------------------------------------

log_step 3 "Setting up OpenFlow in $INSTALL_DIR..."

if [ -d "$INSTALL_DIR/.git" ]; then
  log_info "Existing installation found, pulling latest..."
  cd "$INSTALL_DIR"
  git fetch origin
  git checkout "$BRANCH"
  git pull origin "$BRANCH"
else
  log_info "Cloning OpenFlow..."
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

log_ok "Source ready at $INSTALL_DIR"

# --- Step 4: Install dependencies --------------------------------------------

log_step 4 "Installing dependencies..."

cd "$INSTALL_DIR/server"
npm install 2>&1 | tail -1
log_ok "Server dependencies installed"

cd "$INSTALL_DIR/dashboard"
npm install 2>&1 | tail -1
log_ok "Dashboard dependencies installed"

# --- Step 5: Build -----------------------------------------------------------

log_step 5 "Building..."

cd "$INSTALL_DIR/server"
npm run build 2>&1 | tail -1
log_ok "Server built"

cd "$INSTALL_DIR/dashboard"
npm run build 2>&1 | tail -1
log_ok "Dashboard built"

# Prune server devDeps now that build is done
cd "$INSTALL_DIR/server" && npm prune --production 2>&1 | tail -1

# --- Step 6: Install CLI -----------------------------------------------------

log_step 6 "Installing CLI..."

chmod +x "$INSTALL_DIR/bin/openflow"

# Try /usr/local/bin first, fall back to ~/.local/bin
LINK_DIR="/usr/local/bin"
if [ ! -w "$LINK_DIR" ]; then
  LINK_DIR="$HOME/.local/bin"
  mkdir -p "$LINK_DIR"
fi

ln -sf "$INSTALL_DIR/bin/openflow" "$LINK_DIR/openflow"
log_ok "CLI installed: $LINK_DIR/openflow"

# --- Step 7: Finalize --------------------------------------------------------

log_step 7 "Finalizing..."

mkdir -p "$INSTALL_DIR/logs"

# Restart the server if it was already running
if ("$LINK_DIR/openflow" status 2>/dev/null || true) | grep -q 'running'; then
  log_info "Restarting running server to apply updates..."
  "$LINK_DIR/openflow" stop 2>/dev/null || true
  sleep 1
  "$LINK_DIR/openflow" start 2>/dev/null || true
  log_ok "Server restarted"
fi

# Remove legacy Tauri desktop app if installed
if command -v dpkg &>/dev/null && dpkg -l open-flow &>/dev/null 2>&1; then
  log_info "Removing legacy desktop app (Tauri)..."
  sudo dpkg -r open-flow 2>&1 || true
  log_ok "Legacy desktop app removed"
fi

# --- Summary -----------------------------------------------------------------

echo ""
echo -e "${GREEN}${BOLD}OpenFlow installed successfully!${NC}"
echo ""
echo "  Install dir:  $INSTALL_DIR"
echo "  CLI:          $LINK_DIR/openflow"
echo ""
echo "Next steps:"
echo "  openflow start             # Start the server"
echo "  openflow install-service   # Install as system service (auto-start on boot)"
echo "  openflow status            # Check status and version info"
echo ""
