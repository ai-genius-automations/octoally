#!/bin/bash
# patch-sona.sh — Wire SONA trajectory learning into ruflo hook-handler.cjs
#
# Patches two things:
#   1. hook-handler.cjs — adds learning-service.mjs calls to session lifecycle
#   2. SonaTrajectoryService.js — replaces agentdb stub with working implementation
#
# Version-gated: auto-disables when ruflo ships native SONA support.
# Idempotent: safe to run multiple times (checks sentinel markers).
# DevCortex-compatible: uses same sentinel as DevCortex's patch-sona.sh.
#
# Usage: bash scripts/patch-sona.sh <project-path>
#        bash scripts/patch-sona.sh  (patches current directory)

set -euo pipefail

PROJECT_PATH="${1:-.}"
PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"

HOOK_HANDLER="$PROJECT_PATH/.claude/helpers/hook-handler.cjs"
LEARNING_SERVICE="$PROJECT_PATH/.claude/helpers/learning-service.mjs"
LEARNING_HOOKS="$PROJECT_PATH/.claude/helpers/learning-hooks.sh"
SONA_PATCH_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/patches/SonaTrajectoryService.js"

# Sentinels
HOOK_SENTINEL="// SONA_PATCH_v1"
SONA_SENTINEL="Using native @ruvector/sona"

# Colors (stderr only so stdout stays clean for machine consumption)
log()     { echo "[sona-patch] $1" >&2; }
success() { echo "[sona-patch] ✓ $1" >&2; }
skip()    { echo "[sona-patch] ○ $1" >&2; }
warn()    { echo "[sona-patch] ⚠ $1" >&2; }

# =============================================================================
# Version gate — skip if ruflo has native SONA support
# =============================================================================
check_version_gate() {
  # Check if ruflo's hook-handler already has native SONA wiring
  if [ -f "$HOOK_HANDLER" ] && grep -q "SONA_NATIVE_SUPPORT" "$HOOK_HANDLER" 2>/dev/null; then
    log "Native SONA support detected in ruflo"

    # Clean up our old patches if they exist alongside native support
    if grep -q "$HOOK_SENTINEL" "$HOOK_HANDLER" 2>/dev/null; then
      log "Removing obsolete SONA_PATCH_v1 from hook-handler.cjs..."
      # Restore from pre-patch backup if available
      if [ -f "${HOOK_HANDLER}.pre-sona-patch" ]; then
        # Don't restore the backup — native ruflo wrote a new version.
        # Just remove our bridge file and backup.
        rm -f "$PROJECT_PATH/.claude/helpers/sona-bridge.cjs"
        rm -f "${HOOK_HANDLER}.pre-sona-patch"
        success "Cleaned up obsolete SONA patch artifacts"
      fi
    fi

    exit 0
  fi
}

# =============================================================================
# Helper: Write sona-bridge.cjs to the project
# =============================================================================
_write_sona_bridge() {
  local wrapper="$1"
  cat > "$wrapper" << 'BRIDGE_EOF'
#!/usr/bin/env node
// SONA_PATCH_v1 — Bridge between CJS hook-handler and ESM learning-service
// Calls learning-service.mjs as subprocess to avoid CJS/ESM issues
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const helpersDir = __dirname;
const projectRoot = path.resolve(helpersDir, '../..');
const learningService = path.join(helpersDir, 'learning-service.mjs');
const learningHooks = path.join(helpersDir, 'learning-hooks.sh');

// Check if better-sqlite3 is available (required by learning-service.mjs)
function hasBetterSqlite3() {
  try {
    // Check project node_modules
    const localPath = path.join(projectRoot, 'node_modules', 'better-sqlite3');
    if (fs.existsSync(localPath)) return true;
    // Check shared ruflo cache
    const sharedPath = path.join(require('os').homedir(), '.octoally', 'ruflo', 'node_modules', 'better-sqlite3');
    if (fs.existsSync(sharedPath)) return true;
    return false;
  } catch { return false; }
}

function callLearningService(command, args) {
  if (!fs.existsSync(learningService)) return null;
  if (!hasBetterSqlite3()) return null;
  try {
    const result = execFileSync('node', [learningService, command, ...args], {
      cwd: projectRoot,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (e) {
    return null;
  }
}

function callLearningHooks(command, args) {
  if (!fs.existsSync(learningHooks)) return null;
  try {
    const result = execFileSync('bash', [learningHooks, command, ...args], {
      cwd: projectRoot,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (e) {
    return null;
  }
}

module.exports = {
  sessionStart(sessionId) {
    // Try learning-hooks.sh first (has better output), fall back to learning-service.mjs
    const result = callLearningHooks('session-start', sessionId ? [sessionId] : []);
    if (result) return result;
    return callLearningService('init', sessionId ? [sessionId] : []);
  },

  sessionEnd() {
    const result = callLearningHooks('session-end', []);
    if (result) return result;
    return callLearningService('consolidate', []);
  },

  storePattern(strategy, domain) {
    return callLearningService('store', [strategy, domain || 'general']);
  },

  searchPatterns(query, k) {
    return callLearningService('search', [query, String(k || 5)]);
  },

  isAvailable() {
    return fs.existsSync(learningService) && hasBetterSqlite3();
  },
};
BRIDGE_EOF
}

# =============================================================================
# Part 1: Patch hook-handler.cjs to call learning-service.mjs
# =============================================================================
patch_hook_handler() {
  if [ ! -f "$HOOK_HANDLER" ]; then
    warn "hook-handler.cjs not found at $HOOK_HANDLER — skipping"
    return 1
  fi

  if [ ! -f "$LEARNING_SERVICE" ]; then
    warn "learning-service.mjs not found — skipping hook-handler patch"
    return 1
  fi

  # Always regenerate sona-bridge.cjs (may have been updated)
  local wrapper="$PROJECT_PATH/.claude/helpers/sona-bridge.cjs"

  # Check sentinel — if already patched, just update the bridge and return
  if grep -q "$HOOK_SENTINEL" "$HOOK_HANDLER" 2>/dev/null; then
    _write_sona_bridge "$wrapper"
    skip "hook-handler.cjs already patched (bridge updated)"
    return 0
  fi

  # Back up original
  cp "$HOOK_HANDLER" "${HOOK_HANDLER}.pre-sona-patch"

  # Write the bridge file
  _write_sona_bridge "$wrapper"

  # Now patch hook-handler.cjs to use the bridge
  # Insert the require after the intelligence require (line ~48)
  local tempfile="${HOOK_HANDLER}.tmp"

  node -e "
    const fs = require('fs');
    let content = fs.readFileSync('$HOOK_HANDLER', 'utf-8');

    // Add sentinel at the top (after the first comment block)
    content = content.replace(
      \"const path = require('path');\",
      \"$HOOK_SENTINEL\\nconst path = require('path');\"
    );

    // Add sona-bridge require after intelligence require
    content = content.replace(
      /const intelligence = safeRequire\(path\.join\(helpersDir, 'intelligence\.cjs'\)\);/,
      \"const intelligence = safeRequire(path.join(helpersDir, 'intelligence.cjs'));\\n\" +
      \"const sonaBridge = safeRequire(path.join(helpersDir, 'sona-bridge.cjs'));\"
    );

    // Patch session-restore to init SONA learning
    content = content.replace(
      /\/\/ Initialize intelligence graph after session restore/,
      \"// Initialize SONA learning service\\n\" +
      \"    if (sonaBridge && sonaBridge.isAvailable && sonaBridge.isAvailable()) {\\n\" +
      \"      try {\\n\" +
      \"        const sonaResult = sonaBridge.sessionStart();\\n\" +
      \"        if (sonaResult) console.log('[SONA] ' + sonaResult.split('\\\\n').filter(l => l.includes('✓') || l.includes('patterns')).join(' | ').substring(0, 120));\\n\" +
      \"      } catch (e) { /* non-fatal */ }\\n\" +
      \"    }\\n\" +
      \"    // Initialize intelligence graph after session restore\"
    );

    // Patch post-edit to record file edit as SONA pattern
    content = content.replace(
      /\/\/ Record edit for intelligence consolidation/,
      \"// Record edit as SONA pattern\\n\" +
      \"    if (sonaBridge && sonaBridge.isAvailable && sonaBridge.isAvailable()) {\\n\" +
      \"      try {\\n\" +
      \"        const editFile = (hookInput.tool_input && hookInput.tool_input.file_path) || hookInput.file_path\\n\" +
      \"          || (hookInput.toolInput && hookInput.toolInput.file_path) || '';\\n\" +
      \"        if (editFile) sonaBridge.storePattern('Edit ' + editFile.split('/').slice(-2).join('/'), 'edit');\\n\" +
      \"      } catch (e) { /* non-fatal */ }\\n\" +
      \"    }\\n\" +
      \"    // Record edit for intelligence consolidation\"
    );

    // Patch session-end to consolidate SONA
    content = content.replace(
      /\/\/ Consolidate intelligence before ending session/,
      \"// Consolidate SONA learning data\\n\" +
      \"    if (sonaBridge && sonaBridge.isAvailable && sonaBridge.isAvailable()) {\\n\" +
      \"      try {\\n\" +
      \"        const sonaResult = sonaBridge.sessionEnd();\\n\" +
      \"        if (sonaResult) console.log('[SONA] Session consolidated');\\n\" +
      \"      } catch (e) { /* non-fatal */ }\\n\" +
      \"    }\\n\" +
      \"    // Consolidate intelligence before ending session\"
    );

    // Patch post-task to store pattern
    // SubagentStop sends: { agentName, taskDescription, ... } via stdin
    // PostToolUse sends: { tool_name, ... }
    // We try multiple fields to find the task description
    content = content.replace(
      /\/\/ Implicit success feedback for intelligence/,
      \"// Record task completion as SONA trajectory\\n\" +
      \"    const sonaPrompt = hookInput.taskDescription || hookInput.description || hookInput.task\\n\" +
      \"      || hookInput.agentName || prompt || '';\\n\" +
      \"    if (sonaBridge && sonaBridge.isAvailable && sonaBridge.isAvailable() && sonaPrompt) {\\n\" +
      \"      try {\\n\" +
      \"        sonaBridge.storePattern(sonaPrompt.substring(0, 500), 'task');\\n\" +
      \"      } catch (e) { /* non-fatal */ }\\n\" +
      \"    }\\n\" +
      \"    // Implicit success feedback for intelligence\"
    );

    fs.writeFileSync('$tempfile', content);
  "

  if [ -f "$tempfile" ]; then
    mv "$tempfile" "$HOOK_HANDLER"
    success "hook-handler.cjs patched with SONA lifecycle hooks"
  else
    warn "Failed to patch hook-handler.cjs"
    # Restore backup
    mv "${HOOK_HANDLER}.pre-sona-patch" "$HOOK_HANDLER"
    return 1
  fi
}

# =============================================================================
# Part 2: Patch SonaTrajectoryService.js in agentdb
# =============================================================================
patch_sona_service() {
  if [ ! -f "$SONA_PATCH_SOURCE" ]; then
    skip "SonaTrajectoryService.js patch not found — skipping agentdb patch"
    return 0
  fi

  local TARGETS=()

  # npx cache (all versions)
  for f in "$HOME"/.npm/_npx/*/node_modules/claude-flow/node_modules/agentdb/dist/src/services/SonaTrajectoryService.js; do
    [ -f "$f" ] && TARGETS+=("$f")
  done

  # Global install
  local GLOBAL
  GLOBAL="$(npm root -g 2>/dev/null)/claude-flow/node_modules/agentdb/dist/src/services/SonaTrajectoryService.js"
  [ -f "$GLOBAL" ] && TARGETS+=("$GLOBAL")

  # Local node_modules
  local LOCAL="$PROJECT_PATH/node_modules/claude-flow/node_modules/agentdb/dist/src/services/SonaTrajectoryService.js"
  [ -f "$LOCAL" ] && TARGETS+=("$LOCAL")

  # Shared ruflo cache
  local SHARED="$HOME/.octoally/ruflo/node_modules/claude-flow/node_modules/agentdb/dist/src/services/SonaTrajectoryService.js"
  [ -f "$SHARED" ] && TARGETS+=("$SHARED")

  if [ ${#TARGETS[@]} -eq 0 ]; then
    skip "No SonaTrajectoryService.js found to patch"
    return 0
  fi

  local PATCHED=0
  for t in "${TARGETS[@]}"; do
    if ! grep -q "$SONA_SENTINEL" "$t" 2>/dev/null; then
      cp "$t" "${t}.backup" 2>/dev/null || true
      if cp "$SONA_PATCH_SOURCE" "$t" 2>/dev/null; then
        PATCHED=$((PATCHED + 1))
      fi
    fi
  done

  if [ $PATCHED -gt 0 ]; then
    success "SonaTrajectoryService.js patched ($PATCHED location(s))"
  else
    skip "SonaTrajectoryService.js already patched in all locations"
  fi
}

# =============================================================================
# Part 3: Ensure better-sqlite3 is available
# =============================================================================
ensure_better_sqlite3() {
  local SHARED_RUFLO="$HOME/.octoally/ruflo"

  # Check if already natively installed in the project
  if [ -d "$PROJECT_PATH/node_modules/better-sqlite3" ] && [ ! -L "$PROJECT_PATH/node_modules/better-sqlite3" ]; then
    skip "better-sqlite3 natively installed in project"
    return 0
  fi

  # Ensure it's installed in shared cache
  if [ ! -d "$SHARED_RUFLO/node_modules/better-sqlite3" ]; then
    log "Installing better-sqlite3 in shared ruflo cache..."
    mkdir -p "$SHARED_RUFLO"
    if ! npm install --prefix "$SHARED_RUFLO" better-sqlite3 --save-dev --silent 2>/dev/null; then
      warn "Failed to install better-sqlite3 — SONA learning will use fallback"
      return 1
    fi
    success "better-sqlite3 installed in $SHARED_RUFLO"
  fi

  # Symlink into project so ESM `import` resolves (NODE_PATH doesn't work for ESM)
  mkdir -p "$PROJECT_PATH/node_modules"
  local DEPS=("better-sqlite3" "bindings" "file-uri-to-path")
  local LINKED=0
  for dep in "${DEPS[@]}"; do
    local target="$SHARED_RUFLO/node_modules/$dep"
    local link="$PROJECT_PATH/node_modules/$dep"
    if [ -d "$target" ]; then
      ln -sf "$target" "$link"
      LINKED=$((LINKED + 1))
    fi
  done

  if [ $LINKED -gt 0 ]; then
    success "Symlinked better-sqlite3 from shared cache ($LINKED deps)"
  else
    skip "better-sqlite3 already linked in project"
  fi
}

# =============================================================================
# Part 4: Patch intelligence.cjs to read SONA HNSW patterns during init
# =============================================================================
INTEL_SENTINEL="// SONA_READ_PATH_v1"

patch_intelligence_read() {
  local INTEL_FILE="$PROJECT_PATH/.claude/helpers/intelligence.cjs"

  if [ ! -f "$INTEL_FILE" ]; then
    warn "intelligence.cjs not found — skipping read-path patch"
    return 1
  fi

  if [ ! -f "$LEARNING_SERVICE" ]; then
    warn "learning-service.mjs not found — skipping read-path patch"
    return 1
  fi

  # Already patched?
  if grep -q "$INTEL_SENTINEL" "$INTEL_FILE" 2>/dev/null; then
    skip "intelligence.cjs already has SONA read path"
    return 0
  fi

  # Back up original
  cp "$INTEL_FILE" "${INTEL_FILE}.pre-sona-read"

  local tempfile="${INTEL_FILE}.tmp"

  node -e "
    const fs = require('fs');
    let content = fs.readFileSync('$INTEL_FILE', 'utf-8');

    // Add sentinel + execFileSync require after existing requires
    content = content.replace(
      \"const path = require('path');\",
      \"const path = require('path');\\n\" +
      \"$INTEL_SENTINEL\\n\" +
      \"const { execFileSync } = require('child_process');\"
    );

    // Skip if execFileSync is already imported (e.g. manually patched)
    if (content.indexOf('execFileSync') < content.indexOf('$INTEL_SENTINEL')) {
      // Already has execFileSync before our sentinel — skip that part
      content = content.replace(
        \"$INTEL_SENTINEL\\nconst { execFileSync } = require('child_process');\",
        \"$INTEL_SENTINEL\"
      );
    }

    // Add SONA helper functions after SESSION_FILE constant
    const sonaBlock = [
      '',
      '// ── SONA HNSW search via learning-service.mjs ───────────────────────────────',
      '',
      'const SONA_LEARNING_SERVICE = path.join(process.cwd(), \\'.claude\\', \\'helpers\\', \\'learning-service.mjs\\');',
      '',
      'function sonaAvailable() {',
      '  if (!fs.existsSync(SONA_LEARNING_SERVICE)) return false;',
      '  try {',
      '    var p1 = path.join(process.cwd(), \\'node_modules\\', \\'better-sqlite3\\');',
      '    if (fs.existsSync(p1)) return true;',
      '    var p2 = path.join(require(\\'os\\').homedir(), \\'.octoally\\', \\'ruflo\\', \\'node_modules\\', \\'better-sqlite3\\');',
      '    return fs.existsSync(p2);',
      '  } catch { return false; }',
      '}',
      '',
      'function sonaSearch(query, k) {',
      '  if (!sonaAvailable()) return [];',
      '  try {',
      '    var raw = execFileSync(\\'node\\', [SONA_LEARNING_SERVICE, \\'search\\', query, String(k || 10)], {',
      '      cwd: process.cwd(), timeout: 5000, encoding: \\'utf-8\\', stdio: [\\'pipe\\', \\'pipe\\', \\'pipe\\'],',
      '    }).trim();',
      '    if (!raw) return [];',
      '    var jsonStart = raw.indexOf(\\'{\\');',
      '    if (jsonStart < 0) return [];',
      '    var parsed = JSON.parse(raw.slice(jsonStart));',
      '    return (parsed.patterns || []).filter(function(p) { return p.strategy && p.similarity > 0.1; });',
      '  } catch { return []; }',
      '}',
    ].join('\\n');

    content = content.replace(
      /const SESSION_FILE = [^;]+;/,
      content.match(/const SESSION_FILE = [^;]+;/)[0] + sonaBlock
    );

    // Patch init() to merge SONA patterns before graph building.
    // Insert right before the 'Skip rebuild if graph is fresh' comment.
    const sonaInitBlock = [
      '  // Merge SONA HNSW patterns into store (runs once per init)',
      '  try {',
      '    var sonaPatterns = sonaSearch(\\'development patterns architecture bugs\\', 20);',
      '    if (sonaPatterns.length > 0) {',
      '      var existingKeys = new Set(store.map(function(e) { return e.key; }));',
      '      var sonaAdded = 0;',
      '      for (var si = 0; si < sonaPatterns.length; si++) {',
      '        var sp = sonaPatterns[si];',
      '        var sonaKey = \\'sona-\\' + (sp.strategy || \\'\\').toLowerCase().replace(/[^a-z0-9]+/g, \\'-\\').slice(0, 50);',
      '        if (!existingKeys.has(sonaKey)) {',
      '          store.push({',
      '            id: \\'sona-\\' + Date.now() + \\'-\\' + si,',
      '            key: sonaKey,',
      '            content: sp.strategy,',
      '            summary: sp.strategy.slice(0, 80),',
      '            namespace: sp.domain || \\'sona\\',',
      '            type: \\'semantic\\',',
      '            metadata: { source: \\'sona-hnsw\\', similarity: sp.similarity, quality: sp.quality },',
      '            createdAt: Date.now(),',
      '          });',
      '          existingKeys.add(sonaKey);',
      '          sonaAdded++;',
      '        }',
      '      }',
      '      if (sonaAdded > 0) writeJSON(STORE_PATH, store);',
      '    }',
      '  } catch (e) { /* SONA search failed — non-fatal */ }',
      '',
    ].join('\\n');

    content = content.replace(
      /  \/\/ Skip rebuild if graph is fresh/,
      sonaInitBlock + '  // Skip rebuild if graph is fresh'
    );

    fs.writeFileSync('$tempfile', content);
  "

  if [ -f "$tempfile" ]; then
    mv "$tempfile" "$INTEL_FILE"
    success "intelligence.cjs patched with SONA HNSW read path"
  else
    warn "Failed to patch intelligence.cjs read path"
    mv "${INTEL_FILE}.pre-sona-read" "$INTEL_FILE"
    return 1
  fi
}

# =============================================================================
# Main
# =============================================================================
main() {
  log "Patching SONA learning for: $PROJECT_PATH"

  check_version_gate
  patch_hook_handler
  patch_sona_service
  ensure_better_sqlite3
  patch_intelligence_read

  log "Done"
}

main
