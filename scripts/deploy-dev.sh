#!/usr/bin/env bash
# Deploy from source (progetti/octoally) to the local installation (~/octoally + /opt/OctoAlly)
# Usage: bash scripts/deploy-dev.sh

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="$HOME/octoally"
ELECTRON_ASAR="/opt/OctoAlly/resources/app.asar"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[deploy]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[deploy]${NC} $1"; }
log_error() { echo -e "${RED}[deploy]${NC} $1"; }

if [ ! -d "$INSTALL_DIR" ]; then
  log_error "Installation not found at $INSTALL_DIR"
  exit 1
fi

# 1. Stop running server
log_info "Stopping server..."
fuser -k 42010/tcp >/dev/null 2>&1 || true
sleep 1

# 2. Install dependencies & build all
log_info "Installing dependencies..."
cd "$SRC_DIR"
npm run install:all 2>&1 | tail -1

log_info "Building dashboard + server..."
npm run build 2>&1 | tail -1

log_info "Building desktop-electron..."
cd "$SRC_DIR/desktop-electron"
npm install 2>&1 | tail -1
npm run build 2>&1 | tail -1

# 3. Deploy server to ~/octoally
log_info "Deploying server..."
rsync -a --delete "$SRC_DIR/server/dist/" "$INSTALL_DIR/server/dist/"
# Copy new source files that may not exist in install (e.g. utils/)
rsync -a "$SRC_DIR/server/node_modules/" "$INSTALL_DIR/server/node_modules/" 2>/dev/null || true

# 4. Deploy dashboard to ~/octoally
log_info "Deploying dashboard..."
rsync -a --delete "$SRC_DIR/dashboard/dist/" "$INSTALL_DIR/dashboard/dist/"

# 5. Deploy Electron app (requires sudo for /opt/OctoAlly)
if [ -f "$ELECTRON_ASAR" ]; then
  log_info "Deploying desktop-electron (needs sudo)..."
  TMPDIR=$(mktemp -d)
  npx --yes @electron/asar extract "$ELECTRON_ASAR" "$TMPDIR/app" 2>/dev/null
  cp "$SRC_DIR/desktop-electron/dist/main.js" "$TMPDIR/app/dist/main.js"
  cp "$SRC_DIR/desktop-electron/dist/main.js.map" "$TMPDIR/app/dist/main.js.map"
  npx --yes @electron/asar pack "$TMPDIR/app" "$TMPDIR/app-new.asar" 2>/dev/null
  sudo cp "$ELECTRON_ASAR" "${ELECTRON_ASAR}.bak"
  sudo cp "$TMPDIR/app-new.asar" "$ELECTRON_ASAR"
  rm -rf "$TMPDIR"
  log_ok "Electron app updated"
else
  log_info "Skipping Electron (no asar found at $ELECTRON_ASAR)"
fi

# 6. Restart server
log_info "Starting server..."
"$INSTALL_DIR/bin/octoally" start 2>/dev/null || true

log_ok "Deploy complete! Launch octoally-desktop to test."
