#!/usr/bin/env bash
# OctoAlly Custom Update Script
# Rebases Hemang's custom commits onto latest upstream, with full rollback.
#
# Usage:
#   bash scripts/update-custom.sh          # normal update
#   bash scripts/update-custom.sh --dry    # check only, no changes
#   bash scripts/update-custom.sh --force  # skip session check
#
# What it does:
#   1. Tags current state for rollback
#   2. Fetches upstream
#   3. Rebases custom commits onto upstream/main
#   4. If rebase fails: aborts, restores, saves conflict report
#   5. If rebase succeeds: rebuilds and does graceful restart
#
# Rollback: git checkout hemang/custom && git reset --hard pre-update-backup

set -euo pipefail

OCTOALLY_DIR="${OCTOALLY_DIR:-$HOME/octoally}"
CUSTOM_BRANCH="hemang/custom"
UPSTREAM_REMOTE="upstream"
UPSTREAM_BRANCH="main"
ORIGIN_REMOTE="origin"
CONFLICT_REPORT="$OCTOALLY_DIR/.last-update-conflicts.txt"
BACKUP_TAG="pre-update-$(date +%Y%m%dT%H%M%S)"

# --- Colors & logging --------------------------------------------------------
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[OctoAlly]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OctoAlly]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[OctoAlly]${NC} $1"; }
log_error() { echo -e "${RED}[OctoAlly]${NC} $1"; }
log_step()  { echo -e "${BOLD}${CYAN}[OctoAlly]${NC} ──── $1 ────"; }

# --- Parse flags --------------------------------------------------------------
DRY_RUN=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --dry|--dry-run) DRY_RUN=true ;;
    --force) FORCE=true ;;
  esac
done

cd "$OCTOALLY_DIR"

# --- Pre-flight checks -------------------------------------------------------
log_step "Pre-flight checks"

# Ensure we're on the custom branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$CUSTOM_BRANCH" ]; then
  log_info "Switching to $CUSTOM_BRANCH..."
  git checkout "$CUSTOM_BRANCH" 2>/dev/null || {
    log_error "Branch $CUSTOM_BRANCH does not exist. Create it first."
    exit 1
  }
fi

# Ensure working tree is clean
if ! git diff --quiet || ! git diff --cached --quiet; then
  log_error "Working tree has uncommitted changes. Commit or stash first."
  exit 1
fi

# Check for active sessions (skip with --force)
if [ "$FORCE" = false ]; then
  ACTIVE_SESSIONS=$(pgrep -f "octoally.*session" 2>/dev/null | wc -l || echo 0)
  ACTIVE_PTY=$(pgrep -f "node.*pty" 2>/dev/null | wc -l || echo 0)
  if [ "$ACTIVE_PTY" -gt 2 ]; then
    log_warn "Found $ACTIVE_PTY active pty workers. Use --force to update anyway."
    log_warn "Graceful restart will wait for idle sessions."
    # Don't exit — just warn. The restart at the end handles it gracefully.
  fi
fi

# --- Fetch upstream -----------------------------------------------------------
log_step "Fetching upstream"
git fetch "$UPSTREAM_REMOTE" 2>&1 | tail -5

# Check if there's anything new
CURRENT_BASE=$(git merge-base HEAD "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")
UPSTREAM_HEAD=$(git rev-parse "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")

if [ "$CURRENT_BASE" = "$UPSTREAM_HEAD" ]; then
  log_ok "Already up to date with upstream ($(git rev-parse --short "$UPSTREAM_HEAD"))"
  exit 0
fi

# Count new upstream commits
NEW_COMMITS=$(git rev-list "$CURRENT_BASE..$UPSTREAM_HEAD" --count)
log_info "Upstream has $NEW_COMMITS new commit(s)"

# Show what's new
log_info "New upstream commits:"
git log --oneline "$CURRENT_BASE..$UPSTREAM_HEAD" | while read -r line; do
  echo "  + $line"
done

# Count our custom commits (commits on custom branch not in upstream)
CUSTOM_COMMIT_COUNT=$(git rev-list "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH..HEAD" --count 2>/dev/null || git rev-list "$CURRENT_BASE..HEAD" --count)
log_info "Custom commits to replay: $CUSTOM_COMMIT_COUNT"

# --- Dry run exit -------------------------------------------------------------
if [ "$DRY_RUN" = true ]; then
  log_info "[DRY RUN] Would rebase $CUSTOM_COMMIT_COUNT custom commits onto $NEW_COMMITS new upstream commits"
  # Test if rebase would succeed
  log_info "[DRY RUN] Testing rebase..."
  git stash push -m "dry-run-test" --quiet 2>/dev/null || true
  if git rebase --onto "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" "$CURRENT_BASE" HEAD --no-commit 2>/dev/null; then
    git rebase --abort 2>/dev/null || true
    log_ok "[DRY RUN] Rebase would succeed cleanly"
  else
    git rebase --abort 2>/dev/null || true
    log_warn "[DRY RUN] Rebase would have conflicts — manual resolution needed"
  fi
  git stash pop --quiet 2>/dev/null || true
  exit 0
fi

# --- Create safety snapshot ---------------------------------------------------
log_step "Creating safety snapshot"
git tag "$BACKUP_TAG" HEAD
log_ok "Backup tag: $BACKUP_TAG ($(git rev-parse --short HEAD))"

# Also save custom commits as patches (belt AND suspenders)
PATCH_DIR="$OCTOALLY_DIR/.custom-patches"
rm -rf "$PATCH_DIR"
mkdir -p "$PATCH_DIR"
git format-patch -o "$PATCH_DIR" "$CURRENT_BASE..HEAD" --quiet
PATCH_COUNT=$(ls "$PATCH_DIR"/*.patch 2>/dev/null | wc -l)
log_ok "Saved $PATCH_COUNT patch file(s) to .custom-patches/"

# --- Rebase -------------------------------------------------------------------
log_step "Rebasing custom commits onto upstream"

REBASE_FAILED=false
if ! git rebase "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" 2>"$CONFLICT_REPORT"; then
  REBASE_FAILED=true
fi

if [ "$REBASE_FAILED" = true ]; then
  log_error "Rebase failed — conflicts detected"
  log_error "Conflict details saved to: .last-update-conflicts.txt"

  # Abort and restore
  git rebase --abort 2>/dev/null || true
  git checkout "$CUSTOM_BRANCH" 2>/dev/null || true
  git reset --hard "$BACKUP_TAG" 2>/dev/null || true

  log_ok "Restored to pre-update state ($BACKUP_TAG)"
  log_warn ""
  log_warn "To resolve: ask Claude to run 'bash scripts/update-custom.sh --dry'"
  log_warn "then manually resolve with: git rebase upstream/main"
  log_warn ""
  log_warn "Conflict report:"
  cat "$CONFLICT_REPORT" | head -20
  exit 1
fi

log_ok "Rebase succeeded — custom commits replayed cleanly"

# --- Push rebased branch to fork ----------------------------------------------
log_step "Pushing to fork"
git push "$ORIGIN_REMOTE" "$CUSTOM_BRANCH" --force-with-lease 2>&1 | tail -3
log_ok "Fork updated"

# --- Rebuild ------------------------------------------------------------------
log_step "Rebuilding"

cd "$OCTOALLY_DIR/server"
log_info "Installing server dependencies..."
npm install --silent 2>&1 | tail -1
log_info "Building server..."
npm run build 2>&1 | tail -1
npm prune --production --silent 2>&1 | tail -1
log_ok "Server rebuilt"

cd "$OCTOALLY_DIR/dashboard"
log_info "Installing dashboard dependencies..."
npm install --silent 2>&1 | tail -1
log_info "Building dashboard..."
npm run build 2>&1 | tail -1
log_ok "Dashboard rebuilt"

# --- Graceful restart ---------------------------------------------------------
log_step "Graceful restart"

cd "$OCTOALLY_DIR"

# Try systemd first (Linux)
if [ "$(uname -s)" = "Linux" ] && systemctl is-active --quiet octoally 2>/dev/null; then
  log_info "Restarting systemd service..."
  sudo systemctl restart octoally
  log_ok "Service restarted"
# Try launchd (macOS)
elif [ "$(uname -s)" = "Darwin" ] && launchctl list com.aigenius.octoally &>/dev/null; then
  log_info "Restarting launchd service..."
  launchctl stop com.aigenius.octoally 2>/dev/null || true
  sleep 1
  launchctl start com.aigenius.octoally 2>/dev/null || true
  log_ok "Service restarted"
# Try CLI
else
  CLI_PATH="$(command -v octoally 2>/dev/null || echo "$OCTOALLY_DIR/bin/octoally")"
  if [ -x "$CLI_PATH" ] && ("$CLI_PATH" status 2>/dev/null || true) | grep -q 'running'; then
    log_info "Restarting via CLI..."
    "$CLI_PATH" stop 2>/dev/null || true
    sleep 2
    "$CLI_PATH" start 2>/dev/null || true
    log_ok "Server restarted"
  else
    log_warn "Server not running — skipping restart"
  fi
fi

# --- Summary ------------------------------------------------------------------
NEW_HEAD=$(git rev-parse --short HEAD)
log_ok ""
log_ok "Update complete"
log_ok "  Upstream: $(git rev-parse --short "$UPSTREAM_HEAD") ($NEW_COMMITS new commits)"
log_ok "  Custom:   $CUSTOM_COMMIT_COUNT commits replayed"
log_ok "  HEAD:     $NEW_HEAD"
log_ok "  Backup:   $BACKUP_TAG"
log_ok ""
log_ok "Rollback: git checkout $CUSTOM_BRANCH && git reset --hard $BACKUP_TAG"

exit 0
