#!/usr/bin/env bash
# Build a release archive for HiveCommand.
# Produces: hivecommand-vX.Y.Z.tar.gz (pre-built, ready to extract and run)
#
# Usage:
#   bash scripts/build-release.sh           # uses version from server/package.json
#   VERSION=0.2.0 bash scripts/build-release.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Get version
if [ -z "${VERSION:-}" ]; then
  VERSION=$(node -e "console.log(require('$ROOT_DIR/server/package.json').version)")
fi

ARCHIVE_NAME="hivecommand-v${VERSION}"
BUILD_DIR="$(mktemp -d)"
STAGE_DIR="$BUILD_DIR/$ARCHIVE_NAME"

echo "Building HiveCommand v${VERSION} release..."

# --- Build server ---
echo "  [1/5] Building server..."
cd "$ROOT_DIR/server"
npm ci --ignore-scripts 2>&1 | tail -1
npm run build

# --- Build dashboard ---
echo "  [2/5] Building dashboard..."
cd "$ROOT_DIR/dashboard"
npm ci --ignore-scripts 2>&1 | tail -1
npm run build

# --- Stage files ---
echo "  [3/5] Staging release files..."
mkdir -p "$STAGE_DIR"

# Server: built JS + package files (node_modules installed on target machine
# because native modules like better-sqlite3 need platform-specific binaries)
mkdir -p "$STAGE_DIR/server"
cp -r "$ROOT_DIR/server/dist" "$STAGE_DIR/server/dist"
cp "$ROOT_DIR/server/package.json" "$STAGE_DIR/server/package.json"
cp "$ROOT_DIR/server/package-lock.json" "$STAGE_DIR/server/package-lock.json" 2>/dev/null || true

# Dashboard: static build output
mkdir -p "$STAGE_DIR/dashboard"
cp -r "$ROOT_DIR/dashboard/dist" "$STAGE_DIR/dashboard/dist"

# CLI + scripts + service files
cp -r "$ROOT_DIR/bin" "$STAGE_DIR/bin"
chmod +x "$STAGE_DIR/bin/hivecommand"
cp -r "$ROOT_DIR/scripts" "$STAGE_DIR/scripts"

# Version metadata
cat > "$STAGE_DIR/version.json" <<VJSON
{
  "version": "$VERSION",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "node_version": "$(node -v)"
}
VJSON

# --- Create archive ---
echo "  [4/5] Creating archive..."
cd "$BUILD_DIR"
tar czf "$ROOT_DIR/$ARCHIVE_NAME.tar.gz" "$ARCHIVE_NAME"

# --- Cleanup ---
echo "  [5/5] Cleaning up..."
rm -rf "$BUILD_DIR"

SIZE=$(du -h "$ROOT_DIR/$ARCHIVE_NAME.tar.gz" | cut -f1)
echo ""
echo "Done! $ARCHIVE_NAME.tar.gz ($SIZE)"
echo "Upload this to a GitHub Release as an asset."
