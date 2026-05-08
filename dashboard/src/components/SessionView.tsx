import { useState, useEffect, useCallback, useRef } from 'react';
import { Monitor, FolderTree, Code2, Radio, GitBranch, Plus, X } from 'lucide-react';
import { Terminal } from './Terminal';
import { FileExplorer } from './FileExplorer';
import { EventStream } from './EventStream';
import { GitPanel } from './GitPanel';
import { api } from '../lib/api';

interface SessionViewProps {
  sessionId: string;
  projectPath: string;
  projectId?: string;
  onExit?: () => void;
}

interface ExplorerInstance {
  id: string;
  label: string;
}

interface TerminalInstance {
  id: string; // session ID
  label: string;
}

type ActiveMode = 'terminal' | 'explorer' | 'events' | 'git';

interface PersistedState {
  activeMode: ActiveMode;
  explorerInstances: ExplorerInstance[];
  activeExplorerId: string | null;
  terminalInstances: TerminalInstance[];
  activeTerminalId: string;
}

let nextExplorerSeq = 1;

function storageKey(sessionId: string) {
  return `octoally-session-${sessionId}`;
}

function loadPersistedState(sessionId: string): PersistedState | null {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.activeMode && Array.isArray(parsed.explorerInstances)) {
      return parsed;
    }
  } catch {}
  return null;
}

function persistState(sessionId: string, state: PersistedState) {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(state));
  } catch {}
}

/** Remove all localStorage entries for a session and its explorer instances */
export function cleanupSessionStorage(sessionId: string) {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (raw) {
      const parsed = JSON.parse(raw);
      // Clean up each explorer instance's persisted state
      if (parsed?.explorerInstances) {
        for (const inst of parsed.explorerInstances) {
          localStorage.removeItem(`octoally-explorer-${inst.id}`);
        }
      }
    }
    localStorage.removeItem(storageKey(sessionId));
  } catch {}
}

const sidebarButtons = [
  { id: 'terminal' as const, icon: Monitor, title: 'Terminal' },
  { id: 'explorer' as const, icon: FolderTree, title: 'File Explorer' },
  { id: 'events' as const, icon: Radio, title: 'Events' },
  { id: 'git' as const, icon: GitBranch, title: 'Source Control' },
] as const;

export function SessionView({ sessionId, projectPath, projectId: _projectId, onExit }: SessionViewProps) {
  // Initialize from persisted state or defaults
  const [initialized] = useState(() => {
    const saved = loadPersistedState(sessionId);
    if (saved) {
      // Bump sequence counter past any persisted explorer IDs
      for (const e of saved.explorerInstances) {
        const match = e.id.match(/-explorer-(\d+)$/);
        if (match) nextExplorerSeq = Math.max(nextExplorerSeq, parseInt(match[1]) + 1);
      }
    }
    return saved;
  });

  const [activeMode, setActiveMode] = useState<ActiveMode>(
    initialized?.activeMode ?? 'terminal'
  );

  // Terminal instances — first one is the parent session; restore extras
  const [terminalInstances, setTerminalInstances] = useState<TerminalInstance[]>(() => {
    if (initialized?.terminalInstances?.length) {
      // Deduplicate by id (stale localStorage may have accumulated dupes)
      const seen = new Set<string>();
      const deduped = initialized.terminalInstances.filter(t => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
      const has = deduped.some((t) => t.id === sessionId);
      if (has) return deduped;
      return [{ id: sessionId, label: 'Terminal 1' }, ...deduped.filter(t => t.id !== sessionId)];
    }
    return [{ id: sessionId, label: 'Terminal 1' }];
  });

  const [activeTerminalId, setActiveTerminalId] = useState(
    initialized?.activeTerminalId ?? sessionId
  );

  // Explorer instances — IDs scoped to session to avoid cross-session collisions
  const [explorerInstances, setExplorerInstances] = useState<ExplorerInstance[]>(() => {
    if (initialized?.explorerInstances?.length) {
      return initialized.explorerInstances;
    }
    const id = `${sessionId}-explorer-${nextExplorerSeq++}`;
    return [{ id, label: 'Explorer 1' }];
  });

  const [activeExplorerId, setActiveExplorerId] = useState(
    initialized?.activeExplorerId ?? explorerInstances[0].id
  );

  const [creatingTerminal, setCreatingTerminal] = useState(false);

  // Auto-reconnect detached sessions (tmux survived a server restart)
  useEffect(() => {
    api.sessions.get(sessionId).then(({ session }) => {
      if (session.status === 'detached') {
        api.sessions.reconnect(sessionId).catch((err) => {
          console.error('Failed to auto-reconnect detached session:', err);
        });
      }
    }).catch(() => {});
  }, [sessionId]);

  // Persist state whenever it changes
  useEffect(() => {
    persistState(sessionId, {
      activeMode,
      explorerInstances,
      activeExplorerId,
      terminalInstances,
      activeTerminalId,
    });
  }, [sessionId, activeMode, explorerInstances, activeExplorerId, terminalInstances, activeTerminalId]);

  function handleOpenVSCode() {
    api.files.openVSCode(projectPath).catch((err) => {
      console.error('Failed to open VS Code:', err);
    });
  }

  async function addTerminal() {
    if (creatingTerminal) return;
    setCreatingTerminal(true);
    try {
      const result = await api.sessions.create({
        project_path: projectPath,
        task: 'Interactive session',
      });
      const newId = result.session.id;
      const label = `Terminal ${terminalInstances.length + 1}`;
      setTerminalInstances((prev) => [...prev, { id: newId, label }]);
      setActiveTerminalId(newId);
    } catch (err) {
      console.error('Failed to create terminal session:', err);
    } finally {
      setCreatingTerminal(false);
    }
  }

  async function reconnectTerminal(oldId: string) {
    try {
      // First try to reconnect to an existing tmux session
      const { session: oldSession } = await api.sessions.get(oldId).catch(() => ({ session: null }));
      if (oldSession?.status === 'detached') {
        await api.sessions.reconnect(oldId);
        // Force re-mount of the Terminal component by cycling the ID
        setTerminalInstances((prev) =>
          prev.map((t) => (t.id === oldId ? { ...t, id: oldId + '_reconnecting' } : t))
        );
        // Swap back after a tick so React unmounts/remounts the Terminal
        setTimeout(() => {
          setTerminalInstances((prev) =>
            prev.map((t) => (t.id === oldId + '_reconnecting' ? { ...t, id: oldId } : t))
          );
          setActiveTerminalId(oldId);
        }, 50);
        return;
      }

      // Otherwise create a new session
      const result = await api.sessions.create({
        project_path: projectPath,
        task: 'Interactive session',
      });
      const newId = result.session.id;
      setTerminalInstances((prev) =>
        prev.map((t) => (t.id === oldId ? { ...t, id: newId } : t))
      );
      setActiveTerminalId(newId);
    } catch (err) {
      console.error('Failed to reconnect terminal:', err);
    }
  }

  function closeTerminal(id: string) {
    if (id === sessionId) return;
    api.sessions.kill(id).catch(() => {});
    setTerminalInstances((prev) => prev.filter((t) => t.id !== id));
    if (activeTerminalId === id) {
      setActiveTerminalId(sessionId);
    }
  }

  function addExplorer() {
    const id = `${sessionId}-explorer-${nextExplorerSeq++}`;
    const label = `Explorer ${explorerInstances.length + 1}`;
    setExplorerInstances((prev) => [...prev, { id, label }]);
    setActiveExplorerId(id);
  }

  function closeExplorer(id: string) {
    if (explorerInstances.length <= 1) return;
    setExplorerInstances((prev) => prev.filter((e) => e.id !== id));
    if (activeExplorerId === id) {
      setActiveExplorerId(explorerInstances[0].id === id ? explorerInstances[1]?.id : explorerInstances[0].id);
    }
  }

  // Cross-tab refresh coordination:
  // When git diff view saves a file → tell explorer to refresh that file (if open and not dirty)
  // When explorer saves a file → tell git panel to re-fetch diff (if switching back)
  const [gitSavedFile, setGitSavedFile] = useState<string | null>(null);
  const [explorerSavedFile, setExplorerSavedFile] = useState<string | null>(null);

  const handleGitFileSaved = useCallback((filePath: string) => {
    // Git diff saved a file — tell explorer to refresh it
    setGitSavedFile(filePath);
  }, []);

  const handleExplorerFileSaved = useCallback((filePath: string) => {
    // Explorer saved a file — mark that git should refresh when it becomes visible
    setExplorerSavedFile(filePath);
  }, []);

  // "Reveal in explorer" — switch to explorer mode and tell the active explorer to open the file
  const [openInExplorerRequest, setOpenInExplorerRequest] = useState<{ path: string; key: number } | null>(null);
  const handleOpenInExplorer = useCallback((filePath: string) => {
    setActiveMode('explorer');
    setOpenInExplorerRequest({ path: filePath, key: Date.now() });
  }, []);

  // When switching to git view after explorer saved, trigger refresh
  const prevMode = useRef(activeMode);
  useEffect(() => {
    if (activeMode === 'git' && prevMode.current !== 'git' && explorerSavedFile) {
      // Git panel's isVisible prop change will trigger its own refresh via useEffect
      // Clear the flag
      setExplorerSavedFile(null);
    }
    prevMode.current = activeMode;
  }, [activeMode, explorerSavedFile]);

  // Sub-tab bar: only show for terminal and explorer modes (events has no instances)
  const showSubTabs = activeMode === 'terminal' || activeMode === 'explorer';
  const instances = activeMode === 'terminal' ? terminalInstances : explorerInstances;
  const activeInstanceId = activeMode === 'terminal' ? activeTerminalId : activeExplorerId;

  return (
    <div className="h-full flex">
      {/* Icon sidebar */}
      <div
        className="flex flex-col items-center py-2 gap-1 shrink-0"
        style={{
          width: 48,
          background: 'var(--bg-secondary)',
          borderRight: '1px solid var(--border)',
        }}
      >
        {sidebarButtons.map(({ id, icon: Icon, title }) => {
          const isActive = activeMode === id;
          return (
            <button
              key={id}
              onClick={() => setActiveMode(id)}
              title={title}
              className="flex items-center justify-center rounded-md transition-colors"
              style={{
                width: 36,
                height: 36,
                background: isActive ? 'var(--bg-tertiary)' : 'transparent',
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              <Icon className="w-5 h-5" />
            </button>
          );
        })}

        {/* VS Code button */}
        <button
          onClick={handleOpenVSCode}
          title="Open in VS Code"
          className="flex items-center justify-center rounded-md transition-colors"
          style={{
            width: 36,
            height: 36,
            background: 'transparent',
            color: 'var(--text-secondary)',
          }}
        >
          <Code2 className="w-5 h-5" />
        </button>
      </div>

      {/* Main content area with sub-tabs */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Sub-tab bar — only for terminal/explorer modes */}
        {showSubTabs && (
          <div
            className="flex items-center gap-0.5 px-2 py-1 shrink-0 overflow-x-auto"
            style={{
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-secondary)',
            }}
          >
            {instances.map((inst) => {
              const isActive = inst.id === activeInstanceId;
              const canClose = activeMode === 'terminal'
                ? inst.id !== sessionId
                : explorerInstances.length > 1;

              return (
                <div
                  key={inst.id}
                  className="flex items-center gap-0.5 rounded-md shrink-0 group"
                  style={{
                    background: isActive ? 'var(--bg-tertiary)' : 'transparent',
                  }}
                >
                  <button
                    onClick={() => {
                      if (activeMode === 'terminal') setActiveTerminalId(inst.id);
                      else setActiveExplorerId(inst.id);
                    }}
                    className="flex items-center gap-1.5 pl-3 pr-1 py-1 text-xs font-medium transition-colors"
                    style={{
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                  >
                    {activeMode === 'terminal' ? (
                      <Monitor className="w-3 h-3 shrink-0" style={{ color: 'var(--success)' }} />
                    ) : (
                      <FolderTree className="w-3 h-3 shrink-0" style={{ color: 'var(--accent)' }} />
                    )}
                    <span className="truncate">{inst.label}</span>
                  </button>
                  {canClose && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (activeMode === 'terminal') closeTerminal(inst.id);
                        else closeExplorer(inst.id);
                      }}
                      className="p-0.5 rounded opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity mr-1"
                      style={{ color: 'var(--text-secondary)' }}
                      title="Close"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}

            {/* Add instance button */}
            <button
              onClick={activeMode === 'terminal' ? addTerminal : addExplorer}
              disabled={activeMode === 'terminal' && creatingTerminal}
              className="flex items-center justify-center rounded-md shrink-0 transition-colors"
              title={activeMode === 'terminal' ? 'New Terminal' : 'New Explorer'}
              style={{
                width: 28,
                height: 28,
                color: 'var(--text-secondary)',
                opacity: creatingTerminal && activeMode === 'terminal' ? 0.4 : 1,
              }}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Panel content — all instances stay mounted, toggled via display */}
        <div className="flex-1 min-h-0 relative">
          {/* Terminal instances — stay mounted, toggled via display (preserves scrollback & WebSocket) */}
          {terminalInstances.map((term) => (
            <div
              key={term.id}
              className="h-full absolute inset-0"
              style={{
                display: activeMode === 'terminal' && activeTerminalId === term.id ? 'block' : 'none',
              }}
            >
              <Terminal
                sessionId={term.id}
                visible={activeMode === 'terminal' && activeTerminalId === term.id}
                hideCursor
                onExit={term.id === sessionId && onExit ? () => onExit() : undefined}
                onReconnect={() => reconnectTerminal(term.id)}
              />
            </div>
          ))}

          {/* Explorer instances */}
          {explorerInstances.map((expl) => (
            <div
              key={expl.id}
              className="h-full absolute inset-0"
              style={{
                display: activeMode === 'explorer' && activeExplorerId === expl.id ? 'block' : 'none',
              }}
            >
              <FileExplorer rootPath={projectPath} instanceId={expl.id} refreshFilePath={gitSavedFile} openFileRequest={expl.id === activeExplorerId ? openInExplorerRequest : null} onFileSaved={handleExplorerFileSaved} />
            </div>
          ))}

          {/* Events panel — filtered to this session's events */}
          <div
            className="h-full absolute inset-0"
            style={{ display: activeMode === 'events' ? 'block' : 'none' }}
          >
            <EventStream sessionId={sessionId} />
          </div>

          {/* Git panel */}
          <div
            className="h-full absolute inset-0"
            style={{ display: activeMode === 'git' ? 'block' : 'none' }}
          >
            <GitPanel projectPath={projectPath} isVisible={activeMode === 'git'} onFileSaved={handleGitFileSaved} onOpenInExplorer={handleOpenInExplorer} />
          </div>
        </div>
      </div>
    </div>
  );
}
