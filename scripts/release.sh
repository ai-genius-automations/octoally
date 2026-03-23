#!/usr/bin/env bash
# OctoAlly Release Script
#
# Bumps version across all packages, commits, tags, and pushes to trigger
# the GitHub Actions release workflow.
#
# Usage:
#   bash scripts/release.sh 0.1.21-alpha
#   bash scripts/release.sh 0.2.0
#   bash scripts/release.sh patch          # auto-bump patch (0.1.20 → 0.1.21)
#   bash scripts/release.sh minor          # auto-bump minor (0.1.20 → 0.2.0)
#   bash scripts/release.sh major          # auto-bump major (0.1.20 → 1.0.0)
#
# Options:
#   --dry-run    Show what would happen without making changes
#   --no-push    Commit and tag locally but don't push
#   --npm        Also publish to npm after pushing
#   -m "msg"     Custom commit message (version and tag are still auto-set)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- Parse args ---------------------------------------------------------------

DRY_RUN=false
NO_PUSH=false
NPM_PUBLISH=false
CUSTOM_MSG=""
VERSION_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  DRY_RUN=true; shift ;;
    --no-push)  NO_PUSH=true; shift ;;
    --npm)      NPM_PUBLISH=true; shift ;;
    -m)         CUSTOM_MSG="$2"; shift 2 ;;
    -*)         echo "Unknown option: $1"; exit 1 ;;
    *)          VERSION_ARG="$1"; shift ;;
  esac
done

if [ -z "$VERSION_ARG" ]; then
  echo "Usage: bash scripts/release.sh <version|patch|minor|major> [--dry-run] [--no-push] [-m \"message\"]"
  echo ""
  echo "Examples:"
  echo "  bash scripts/release.sh 0.1.21-alpha"
  echo "  bash scripts/release.sh patch"
  echo "  bash scripts/release.sh minor"
  exit 1
fi

# --- Resolve current version --------------------------------------------------

CURRENT=$(node -e "console.log(require('./package.json').version)")
echo "Current version: $CURRENT"

# --- Resolve new version ------------------------------------------------------

# Strip -alpha/-beta/-rc suffix for semver arithmetic, reattach after
SUFFIX=""
BASE="$CURRENT"
if [[ "$CURRENT" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-(.+)$ ]]; then
  BASE="${BASH_REMATCH[1]}"
  SUFFIX="-${BASH_REMATCH[2]}"
fi

IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE"

case "$VERSION_ARG" in
  patch)
    NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))${SUFFIX}"
    ;;
  minor)
    NEW_VERSION="$MAJOR.$((MINOR + 1)).0${SUFFIX}"
    ;;
  major)
    NEW_VERSION="$((MAJOR + 1)).0.0${SUFFIX}"
    ;;
  *)
    NEW_VERSION="$VERSION_ARG"
    ;;
esac

echo "New version:     $NEW_VERSION"
echo ""

# --- Check working tree is clean ---------------------------------------------

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree is not clean. Commit or stash changes first."
  git status --short
  exit 1
fi

# --- Files to update ----------------------------------------------------------

VERSION_FILES=(
  package.json
  package-lock.json
  server/package.json
  server/package-lock.json
  dashboard/package.json
  desktop-electron/package.json
)

# --- Dry run ------------------------------------------------------------------

if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would update version in:"
  for f in "${VERSION_FILES[@]}"; do
    if [ -f "$f" ]; then
      echo "  $f"
    fi
  done
  echo "[dry-run] Would commit, tag v${NEW_VERSION}, and push"
  exit 0
fi

# --- Bump versions ------------------------------------------------------------

echo "Bumping versions..."
for f in "${VERSION_FILES[@]}"; do
  if [ -f "$f" ]; then
    if [[ "$f" == *lock* ]]; then
      # For lockfiles: only update the top-level "version" field (not dependency versions)
      python3 -c "
import json, sys
with open('$f') as fh:
    data = json.load(fh)
data['version'] = '$NEW_VERSION'
if '' in data.get('packages', {}):
    data['packages']['']['version'] = '$NEW_VERSION'
with open('$f', 'w') as fh:
    json.dump(data, fh, indent=2)
    fh.write('\n')
"
    else
      # For package.json: safe to replace version string (only appears once)
      sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" "$f"
    fi
    echo "  ✓ $f"
  fi
done

# --- Verify -------------------------------------------------------------------

VERIFY=$(node -e "console.log(require('./package.json').version)")
if [ "$VERIFY" != "$NEW_VERSION" ]; then
  echo "ERROR: Version mismatch after bump (got $VERIFY, expected $NEW_VERSION)"
  git checkout -- .
  exit 1
fi

# --- Build check --------------------------------------------------------------

echo ""
echo "Building..."
npm run build 2>&1 | tail -5

# --- Commit, tag, push --------------------------------------------------------

MSG="${CUSTOM_MSG:-v${NEW_VERSION}}"

echo ""
echo "Committing..."
git add -A
git commit -m "$MSG"

echo "Tagging v${NEW_VERSION}..."
git tag "v${NEW_VERSION}"

if [ "$NO_PUSH" = true ]; then
  echo ""
  echo "Tagged v${NEW_VERSION} locally (--no-push). To release:"
  echo "  git push && git push origin v${NEW_VERSION}"
else
  echo "Pushing..."
  git push
  git push origin "v${NEW_VERSION}"
  echo ""
  echo "✓ v${NEW_VERSION} released — GitHub Actions workflow triggered"
  echo "  https://github.com/ai-genius-automations/octoally/actions"

  # --- npm publish (opt-in) ---------------------------------------------------
  if [ "$NPM_PUBLISH" = true ]; then
    echo ""
    echo "Publishing to npm..."
    npm publish
    echo "✓ Published octoally@${NEW_VERSION} to npm"
  fi
fi
