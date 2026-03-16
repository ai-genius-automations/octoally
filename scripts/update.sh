#!/usr/bin/env bash
# HiveCommand Update Script
# Pulls latest changes and rebuilds.
#
# Usage:
#   hivecommand update
#   bash scripts/update.sh

set -euo pipefail

# Find HiveCommand installation directory
if [ -z "${HIVECOMMAND_DIR:-}" ]; then
  for candidate in "$HOME/hivecommand" "/opt/hivecommand"; do
    if [ -d "$candidate/.git" ]; then
      HIVECOMMAND_DIR="$candidate"
      break
    fi
  done
fi

if [ -z "${HIVECOMMAND_DIR:-}" ] || [ ! -d "$HIVECOMMAND_DIR" ]; then
  echo "[HiveCommand] Error: Cannot find HiveCommand installation directory"
  exit 1
fi

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[HiveCommand]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[HiveCommand]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[HiveCommand]${NC} $1"; }
log_error() { echo -e "${RED}[HiveCommand]${NC} $1"; }

cd "$HIVECOMMAND_DIR"

# --- Migrate from OpenFlow (if upgrading) ------------------------------------

OLD_CONFIG_DIR="$HOME/.openflow"
NEW_CONFIG_DIR="$HOME/.hivecommand"

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

# Remove old OpenFlow CLI symlinks
for old_bin in /usr/local/bin/openflow "$HOME/.local/bin/openflow"; do
  [ -L "$old_bin" ] || [ -f "$old_bin" ] && rm -f "$old_bin" 2>/dev/null || true
done

# Get current and target versions
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
CURRENT_HASH=$(git rev-parse --short HEAD)

log_info "Updating HiveCommand ($CURRENT_BRANCH @ $CURRENT_HASH)..."

# Pull latest
git fetch origin
git pull origin "$CURRENT_BRANCH"

NEW_HASH=$(git rev-parse --short HEAD)
if [ "$CURRENT_HASH" = "$NEW_HASH" ]; then
  log_ok "Already up to date ($CURRENT_HASH)"
  exit 0
fi

log_info "Updated $CURRENT_HASH → $NEW_HASH"

# Rebuild server
log_info "Rebuilding server..."
cd "$HIVECOMMAND_DIR/server"
npm install 2>&1 | tail -1
npm run build 2>&1 | tail -1
npm prune --production 2>&1 | tail -1
log_ok "Server rebuilt"

# Rebuild dashboard
log_info "Rebuilding dashboard..."
cd "$HIVECOMMAND_DIR/dashboard"
npm install 2>&1 | tail -1
npm run build 2>&1 | tail -1
log_ok "Dashboard rebuilt"

# Restart server if running (service or manual)
if [ "$(uname -s)" = "Linux" ] && systemctl is-active --quiet hivecommand 2>/dev/null; then
  log_info "Restarting systemd service..."
  sudo systemctl restart hivecommand
  log_ok "Service restarted"
elif [ "$(uname -s)" = "Darwin" ] && launchctl list com.aigenius.hivecommand &>/dev/null; then
  log_info "Restarting launchd service..."
  launchctl stop com.aigenius.hivecommand 2>/dev/null || true
  launchctl start com.aigenius.hivecommand 2>/dev/null || true
  log_ok "Service restarted"
else
  CLI_PATH="$(command -v hivecommand 2>/dev/null || echo "$HIVECOMMAND_DIR/bin/hivecommand")"
  if ("$CLI_PATH" status 2>/dev/null || true) | grep -q 'running'; then
    log_info "Restarting running server..."
    "$CLI_PATH" stop 2>/dev/null || true
    sleep 1
    "$CLI_PATH" start 2>/dev/null || true
    log_ok "Server restarted"
  fi
fi

log_ok "Update complete ($CURRENT_HASH → $NEW_HASH)"
exit 0
