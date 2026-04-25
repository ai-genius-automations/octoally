import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, FolderTree, Code2, GitBranch, Home, Plus, X, Download, LayoutGrid, Maximize2, Minimize2, ExternalLink, Globe, Zap, Bot, TerminalSquare, Columns3, Rows3, ChevronDown } from 'lucide-react';
import { ClaudeIcon, CodexIcon } from './CliIcons';
import { Terminal } from './Terminal';
import { FileExplorer } from './FileExplorer';
import { GitPanel } from './GitPanel';
import { SessionLauncher } from './SessionLauncher';
import { WebPageView } from './WebPageView';
import { api, type ScannedSession } from '../lib/api';
import { CloseTabModal } from './CloseTabModal';
import { useShortcut, markKeyboardNav } from '../lib/shortcuts';

interface ProjectViewProps {
  projectId: string;
  projectPath: string;
  projectName: string;
  active?: boolean;
  /** When true, disconnect terminal WebSockets (another view is using the sessions) */
  terminalsSuspended?: boolean;
  /** When set, switch to this terminal session ID and clear it */
  focusSessionId?: string | null;
  onFocusSessionHandled?: () => void;
  /** Report hidden (closed-tab) session IDs to parent */
  onHiddenSessionsChange?: (sessionIds: string[]) => void;
}

interface ExplorerInstance {
  id: string;
  label: string;
}

interface TerminalInstance {
  id: string; // session ID
  label: string;
}

interface WebPageInstance {
  id: string;
  label: string;
  url: string;
}

type ActiveMode = 'terminal' | 'explorer' | 'events' | 'git';

interface PersistedState {
  activeMode: ActiveMode;
  explorerInstances: ExplorerInstance[];
  activeExplorerId: string | null;
  terminalInstances: TerminalInstance[];
  activeTerminalId: string | null;
  webPageInstances?: WebPageInstance[];
  activeWebPageId?: string | null;
  /** When true, the "new session" launcher tab is active instead of a terminal */
  showLauncher: boolean;
}

let nextExplorerSeq = 1;

function storageKey(projectId: string) {
  return `octoally-project-${projectId}`;
}

function loadPersistedState(projectId: string): PersistedState | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.activeMode && Array.isArray(parsed.explorerInstances)) {
      return parsed;
    }
  } catch {}
  return null;
}

function persistState(projectId: string, state: PersistedState) {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(state));
  } catch {}
}

/** Remove all localStorage entries for a project and its explorer instances */
export function cleanupProjectStorage(projectId: string) {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.explorerInstances) {
        for (const inst of parsed.explorerInstances) {
          localStorage.removeItem(`octoally-explorer-${inst.id}`);
        }
      }
    }
    localStorage.removeItem(storageKey(projectId));
  } catch {}
}

const sidebarButtons = [
  { id: 'terminal' as const, icon: Monitor, title: 'Terminal' },
  { id: 'explorer' as const, icon: FolderTree, title: 'File Explorer' },
  { id: 'git' as const, icon: GitBranch, title: 'Source Control' },
] as const;

export function ProjectView({ projectId, projectPath, projectName: _projectName, active = true, terminalsSuspended = false, focusSessionId, onFocusSessionHandled, onHiddenSessionsChange }: ProjectViewProps) {
  const queryClient = useQueryClient();

  // Fetch project data for SessionLauncher
  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects.list(),
  });
  const project = projectsData?.projects.find((p) => p.id === projectId);

  // Fetch running sessions for this project
  // No refetchInterval — driven by WebSocket invalidation (websocket.ts).
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
  });
  const projectSessions = useMemo(
    () => (sessionsData?.sessions || []).filter(
      (s) => s.project_id === projectId && (s.status === 'running' || s.status === 'detached' || s.status === 'pending')
    ),
    [sessionsData, projectId]
  );

  // Lookup map for session metadata (cli_type, task, etc.) — used in tab rendering
  const sessionLookup = useMemo(
    () => new Map(projectSessions.map((s) => [s.id, s])),
    [projectSessions]
  );

  // Initialize from persisted state or defaults
  const [initialized] = useState(() => {
    const saved = loadPersistedState(projectId);
    if (saved) {
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

  // Sidebar navigation shortcuts — only the active (visible) project view
  // registers these, so shortcuts switch the sidebar of the project the user
  // is looking at, not a background tab's.
  const cycleSidebar = useCallback((delta: number) => {
    const order = sidebarButtons.map((b) => b.id);
    const idx = order.indexOf(activeMode as typeof order[number]);
    const next = order[((idx === -1 ? 0 : idx) + delta + order.length) % order.length];
    markKeyboardNav();
    (document.activeElement as HTMLElement | null)?.blur?.();
    setActiveMode(next);
  }, [activeMode]);
  useShortcut('nav.nextSidebar', () => cycleSidebar(1), active);
  useShortcut('nav.prevSidebar', () => cycleSidebar(-1), active);

  // Discover external sessions available for adoption (on-demand only, no polling)
  const { data: discoverableData, refetch: refetchDiscoverable } = useQuery({
    queryKey: ['discoverable-sessions', projectPath],
    queryFn: () => api.sessions.discoverable(projectPath),
    enabled: false, // on-demand only — triggered by user clicking "Scan"
  });
  const discoverableSessions = discoverableData?.sessions || [];

  // Scan ALL claude processes system-wide (on-demand, no polling)
  const { data: scanAllData, refetch: refetchScanAll, isFetching: isScanningAll } = useQuery({
    queryKey: ['scan-all-sessions'],
    queryFn: () => api.sessions.scanAll(),
    enabled: false,
  });
  const [showScanAllMenu, setShowScanAllMenu] = useState(false);
  const [scanAllDone, setScanAllDone] = useState(false);
  const scanAllMenuRef = useRef<HTMLDivElement>(null);
  const scanAllDropdownRef = useRef<HTMLDivElement>(null);
  const scannedSessions: ScannedSession[] = scanAllData?.sessions || [];

  // Terminal instances — restored from persisted state + synced with server sessions
  const [terminalInstances, setTerminalInstances] = useState<TerminalInstance[]>(
    initialized?.terminalInstances ?? []
  );
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(
    initialized?.activeTerminalId ?? null
  );

  // Terminal-tab cycling shortcut — match the click-on-tab code path exactly
  // so perf is identical to clicking. No markKeyboardNav (that skips focus
  // which was causing xterm render issues on terminal tab switch). Debounced
  // so rapid keystrokes only trigger one switch instead of N reconnects.
  const pendingTabDeltaRef = useRef(0);
  const tabDebounceTimerRef = useRef<number | null>(null);
  const cycleTerminalTab = useCallback((delta: number) => {
    if (terminalInstances.length === 0) return;
    pendingTabDeltaRef.current += delta;
    if (tabDebounceTimerRef.current !== null) {
      window.clearTimeout(tabDebounceTimerRef.current);
    }
    tabDebounceTimerRef.current = window.setTimeout(() => {
      const d = pendingTabDeltaRef.current;
      pendingTabDeltaRef.current = 0;
      tabDebounceTimerRef.current = null;
      if (terminalInstances.length === 0) return;
      const ids = terminalInstances.map((t) => t.id);
      const current = activeTerminalId ?? ids[0];
      const idx = ids.indexOf(current);
      const next = ids[((idx === -1 ? 0 : idx) + d + ids.length * 100) % ids.length];
      // Mirror the onClick handler on the terminal tab button exactly.
      setActiveTerminalId(next);
      setActiveWebPageId(null);
      setShowLauncher(false);
      setShowAllTerminals(false);
      setActiveMode('terminal');
      focusTerminalById(next);
    }, 180);
  }, [terminalInstances, activeTerminalId]);
  useShortcut('terminal.nextTab', () => cycleTerminalTab(1), active);
  useShortcut('terminal.prevTab', () => cycleTerminalTab(-1), active);

  // Close active terminal/agent tab — opens the confirm modal with the same
  // args as the X button on the tab pill. CloseTabModal auto-focuses "Close
  // & Kill" so Enter confirms kill.
  useShortcut('terminal.closeTab', () => {
    if (!activeTerminalId) return;
    const inst = terminalInstances.find((t) => t.id === activeTerminalId);
    if (!inst) return;
    const type = inst.label.startsWith('Terminal')
      ? 'terminal'
      : inst.label.startsWith('Agent')
      ? 'agent'
      : 'session';
    setCloseConfirm({ id: inst.id, label: inst.label, type });
  }, active);

  const [showLauncher, setShowLauncher] = useState(
    initialized?.showLauncher ?? true
  );
  const [showAllTerminals, setShowAllTerminals] = useState(false);
  const [expandedTerminalId, setExpandedTerminalId] = useState<string | null>(null);
  const [gridFocusedId, setGridFocusedId] = useState<string | null>(null);
  const [gridColumns, setGridColumns] = useState(() => {
    const saved = localStorage.getItem(`octoally-project-grid-cols-${projectId}`);
    return saved ? Math.min(10, Math.max(1, parseInt(saved, 10) || 3)) : 3;
  });
  const [gridRows, setGridRows] = useState<number | 'auto'>(() => {
    const saved = localStorage.getItem(`octoally-project-grid-rows-${projectId}`);
    if (!saved || saved === 'auto') return 'auto';
    return Math.min(6, Math.max(1, parseInt(saved, 10) || 2));
  });
  const [gridColsOpen, setGridColsOpen] = useState(false);
  const [gridRowsOpen, setGridRowsOpen] = useState(false);
  const [gridCardHeight, setGridCardHeight] = useState(420);
  const [gridShowAll, setGridShowAll] = useState(false);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const gridInnerRef = useRef<HTMLDivElement>(null);
  const [gridMounted, setGridMounted] = useState(false);

  // Lazy-mount: only create xterm instances for terminals the user has actually viewed.
  // Prevents 8+ xterm instances from initializing simultaneously on page refresh.
  const mountedTerminals = useRef(new Set<string>());

  // Web page instances
  const [webPageInstances, setWebPageInstances] = useState<WebPageInstance[]>(
    initialized?.webPageInstances ?? []
  );
  const [activeWebPageId, setActiveWebPageId] = useState<string | null>(
    initialized?.activeWebPageId ?? null
  );

  // Close-tab confirmation modal state
  const [closeConfirm, setCloseConfirm] = useState<{
    id: string;
    label: string;
    type: 'session' | 'terminal' | 'agent';
  } | null>(null);

  // Dismiss grid view and expanded modal when the project tab loses focus
  // so grid terminals don't interfere with other projects' terminal focus
  useEffect(() => {
    if (!active) {
      setShowAllTerminals(false);
      setExpandedTerminalId(null);
    }
  }, [active]);

  // Track sessions the user explicitly closed so the sync effect doesn't re-add them
  const closedSessionIds = useRef(new Set<string>());
  // Counter to force re-render when closedSessionIds changes (refs don't trigger re-renders)
  const [closedIdsVersion, setClosedIdsVersion] = useState(0);

  // Report hidden session IDs to parent (for Active Sessions filtering)
  useEffect(() => {
    onHiddenSessionsChange?.([...closedSessionIds.current]);
  }, [closedIdsVersion, onHiddenSessionsChange]);

  // Sync terminal instances with server sessions (auto-detect running sessions)
  const syncedRef = useRef(false);
  useEffect(() => {
    if (projectSessions.length === 0 && syncedRef.current) return;
    if (projectSessions.length === 0 && !syncedRef.current) {
      syncedRef.current = true;
      return;
    }
    syncedRef.current = true;

    // Prune closed IDs that are no longer alive on the server (kill completed)
    const allAliveIds = new Set(
      (sessionsData?.sessions || [])
        .filter((s: any) => s.status === 'running' || s.status === 'detached')
        .map((s: any) => s.id)
    );
    let pruned = false;
    for (const id of closedSessionIds.current) {
      if (!allAliveIds.has(id)) {
        closedSessionIds.current.delete(id);
        pruned = true;
      }
    }
    if (pruned) setClosedIdsVersion((v) => v + 1);

    // Build a lookup of session type by ID
    const sessionById = new Map(projectSessions.map((s) => [s.id, s]));

    setTerminalInstances((prev) => {
      const existingIds = new Set(prev.map((t) => t.id));
      const aliveIds = new Set(projectSessions.map((s) => s.id));
      // Build set of all session IDs the server knows about (any status)
      const allServerIds = new Set((sessionsData?.sessions || []).map((s: any) => s.id));

      // Remove sessions only if the server explicitly reports them as dead
      // (completed/failed/cancelled). Keep sessions the server hasn't seen yet
      // (just created locally, not in the poll response yet).
      const filtered = prev.filter((t) => aliveIds.has(t.id) || !allServerIds.has(t.id));

      // Relabel existing instances based on actual session data.
      // This fixes tabs restored from localStorage with stale labels.
      let sessionCount = 0;
      let terminalCount = 0;
      let agentCount = 0;
      const relabeled = filtered.map((t) => {
        const session = sessionById.get(t.id);
        if (!session) return t; // not yet known — keep as-is
        const isTerminal = session.task === 'Terminal';
        const isAgent = session.task.startsWith('Agent (');
        const prefix = isTerminal ? 'Terminal' : isAgent ? 'Agent' : 'Session';
        const num = isTerminal ? ++terminalCount : isAgent ? ++agentCount : ++sessionCount;
        const newLabel = `${prefix} ${num}`;
        return newLabel !== t.label ? { ...t, label: newLabel } : t;
      });

      // Add new sessions not yet tracked (skip user-closed sessions)
      const newTerminals: TerminalInstance[] = [];
      for (const s of projectSessions) {
        if (!existingIds.has(s.id) && !closedSessionIds.current.has(s.id)) {
          const isTerminal = s.task === 'Terminal';
          const isAgent = s.task.startsWith('Agent (');
          const prefix = isTerminal ? 'Terminal' : isAgent ? 'Agent' : 'Session';
          const num = isTerminal ? ++terminalCount : isAgent ? ++agentCount : ++sessionCount;
          newTerminals.push({ id: s.id, label: `${prefix} ${num}` });
        }
      }

      const result = [...relabeled, ...newTerminals];
      // Sort: session first, then agent, then terminal
      const sortOrder = (label: string) => label.startsWith('Session') ? 0 : label.startsWith('Agent') ? 1 : 2;
      result.sort((a, b) => {
        const diff = sortOrder(a.label) - sortOrder(b.label);
        if (diff !== 0) return diff;
        return 0; // preserve relative order within each group
      });
      // Check if anything actually changed
      if (result.length === prev.length && newTerminals.length === 0 && result.every((t, i) => t.id === prev[i]?.id && t.label === prev[i]?.label)) return prev;

      return result;
    });
  }, [projectSessions]);

  // If terminals appeared and launcher was showing, switch to terminal
  // (but not if the user explicitly navigated to the Home/launcher tab)
  useEffect(() => {
    if (terminalInstances.length > 0 && !activeTerminalId && !activeWebPageId && !showLauncher) {
      setActiveTerminalId(terminalInstances[0].id);
    }
  }, [terminalInstances, activeTerminalId, activeWebPageId, showLauncher]);

  // Focus a specific session when requested (e.g. from Active Sessions "go to" button or voice command)
  useEffect(() => {
    if (!focusSessionId) return;

    // Voice command: show all terminals/sessions in grid
    if (focusSessionId === '__voice_show_all') {
      setShowAllTerminals(true);
      setExpandedTerminalId(null);
      onFocusSessionHandled?.();
      return;
    }

    // Voice command: refresh active terminal display
    if (focusSessionId === '__voice_refresh_tab') {
      if (activeTerminalId) {
        window.dispatchEvent(new CustomEvent('octoally:refresh-terminal', {
          detail: { sessionId: activeTerminalId },
        }));
      }
      onFocusSessionHandled?.();
      return;
    }

    // Voice command / quick-launch: create new terminal, session, or agent (optionally with cli type)
    const createMatch = focusSessionId.match(/^__voice_create_(terminal|session|agent)(?:_(claude|codex))?$/);
    if (createMatch) {
      const type = createMatch[1] as 'terminal' | 'session' | 'agent';
      const cliType = (createMatch[2] as 'claude' | 'codex' | undefined) || 'claude';
      console.log(`[QuickLaunch] Creating new ${type} (${cliType})`);
      if (type === 'terminal') {
        api.sessions.create({ project_path: projectPath, mode: 'terminal', project_id: projectId })
          .then((data) => {
            if (data.session?.id) {
              handleSessionCreated(data.session.id, undefined, 'terminal');
              queryClient.invalidateQueries({ queryKey: ['sessions'] });
            }
          })
          .catch((err) => console.error(`[QuickLaunch] Failed to create terminal:`, err));
      } else {
        const cfPrompt = (project?.session_prompt ?? '').trim();
        const defaultTask = 'Start up and ask me what I want you to do and NOTHING ELSE';
        const task = cfPrompt
          ? `${defaultTask}\n\n---\nAdditional Instructions:\n${cfPrompt}`
          : defaultTask;
        api.sessions.create({
          project_path: projectPath,
          task,
          mode: type === 'agent' ? 'agent' : 'session',
          agent_type: type === 'agent' ? 'coder' : undefined,
          project_id: projectId,
          cli_type: cliType,
        })
          .then((data) => {
            if (data.session?.id) {
              handleSessionCreated(data.session.id, undefined, 'session');
              queryClient.invalidateQueries({ queryKey: ['sessions'] });
            }
          })
          .catch((err) => console.error(`[QuickLaunch] Failed to create ${type}:`, err));
      }
      onFocusSessionHandled?.();
      return;
    }

    // Voice command: close active terminal or session
    const closeMatch = focusSessionId.match(/^__voice_close_(terminal|session)$/);
    if (closeMatch) {
      const type = closeMatch[1];
      const targetLabel = type === 'session' ? 'Session' : 'Terminal';
      // Close the currently active session if it matches the type
      const activeInst = terminalInstances.find((t) => t.id === activeTerminalId);
      if (activeInst && activeInst.label.startsWith(targetLabel)) {
        console.log(`[STT] Closing active ${type}: ${activeInst.label} (${activeInst.id})`);
        closeTerminal(activeInst.id);
      } else {
        console.warn(`[STT] Active session is not a ${type}, cannot close`);
      }
      onFocusSessionHandled?.();
      return;
    }

    // Voice command: __voice_terminal_N or __voice_session_N
    const voiceMatch = focusSessionId.match(/^__voice_(terminal|session)_(\d+)$/);
    if (voiceMatch) {
      const [, type, numStr] = voiceMatch;
      const num = parseInt(numStr, 10);
      // Find the Nth terminal or session by label ordering
      const targetLabel = type === 'session' ? 'Session' : 'Terminal';
      const matching = terminalInstances.filter((t) =>
        t.label.startsWith(targetLabel)
      );
      console.log(`[STT] Voice focus: type=${type} num=${num} targetLabel=${targetLabel}`,
        'all instances:', terminalInstances.map(t => `${t.label} (${t.id})`),
        'matching:', matching.map(t => `${t.label} (${t.id})`));
      const target = matching[num - 1]; // 1-indexed
      if (target) {
        console.log(`[STT] Switching to: ${target.label} (${target.id})`);
        setActiveTerminalId(target.id);
        setShowLauncher(false);
        setShowAllTerminals(false);
        setActiveMode('terminal');
      } else {
        console.warn(`[STT] No ${targetLabel} #${num} found. Have ${matching.length} matching instances.`);
      }
      onFocusSessionHandled?.();
      return;
    }

    // Regular session ID focus
    if (terminalInstances.some((t) => t.id === focusSessionId)) {
      setActiveTerminalId(focusSessionId);
      setActiveWebPageId(null);
      setShowLauncher(false);
      setShowAllTerminals(false);
      setActiveMode('terminal');
      onFocusSessionHandled?.();
      focusTerminalById(focusSessionId);
    }
  }, [focusSessionId, terminalInstances]);

  // Explorer instances
  const [explorerInstances, setExplorerInstances] = useState<ExplorerInstance[]>(() => {
    if (initialized?.explorerInstances?.length) {
      return initialized.explorerInstances;
    }
    const id = `${projectId}-explorer-${nextExplorerSeq++}`;
    return [{ id, label: 'Explorer 1' }];
  });

  const [activeExplorerId, setActiveExplorerId] = useState(
    initialized?.activeExplorerId ?? explorerInstances[0].id
  );

  // Persist state whenever it changes
  useEffect(() => {
    persistState(projectId, {
      activeMode,
      explorerInstances,
      activeExplorerId,
      terminalInstances,
      activeTerminalId,
      webPageInstances,
      activeWebPageId,
      showLauncher,
    });
  }, [projectId, activeMode, explorerInstances, activeExplorerId, terminalInstances, activeTerminalId, webPageInstances, activeWebPageId, showLauncher]);

  function handleOpenVSCode() {
    api.files.openVSCode(projectPath).catch((err) => {
      console.error('Failed to open VS Code:', err);
    });
  }

  function handleSessionCreated(sessionId: string, _projectName?: string, mode?: 'session' | 'terminal') {
    const isTerminal = mode === 'terminal';
    setTerminalInstances((prev) => {
      if (prev.some((t) => t.id === sessionId)) return prev;
      const prefix = isTerminal ? 'Terminal' : 'Session';
      const count = prev.filter(t => t.label.startsWith(prefix)).length + 1;
      return [...prev, { id: sessionId, label: `${prefix} ${count}` }];
    });
    setActiveTerminalId(sessionId);
    setActiveWebPageId(null);
    setShowLauncher(false);
  }

  // Track when an adopt is in flight to suppress the hidden list during the race
  const adoptingRef = useRef(false);

  // Compute hidden sessions (user hid the tab but process is still running)
  // Use all sessions (not projectSessions) because project_id filtering may not match
  // closedSessionIds is already scoped to this ProjectView instance
  const hiddenSessions = useMemo(() => {
    void closedIdsVersion; // depend on version counter so this recomputes when sessions are hidden/unhidden
    // Suppress hidden list while adopt is in flight (avoids race with SSE-driven refetch)
    if (adoptingRef.current) return [];
    if (closedSessionIds.current.size === 0) return [];
    // Only show hidden sessions for this project, and exclude sessions with open tabs
    const openTabIds = new Set(terminalInstances.map((t) => t.id));
    return projectSessions.filter((s: any) =>
      closedSessionIds.current.has(s.id) &&
      !openTabIds.has(s.id)
    );
  }, [projectSessions, closedIdsVersion, terminalInstances]);

  function unhideSession(id: string) {
    closedSessionIds.current.delete(id);
    setClosedIdsVersion((v) => v + 1);

    // Find the session data to determine its type and re-add the tab
    const allSessions = sessionsData?.sessions || [];
    const session = allSessions.find((s: any) => s.id === id);
    if (session) {
      setTerminalInstances((prev) => {
        if (prev.some((t) => t.id === id)) return prev;
        const isTerminal = session.task === 'Terminal';
        const isAgent = session.task?.startsWith('Agent (');
        const prefix = isTerminal ? 'Terminal' : isAgent ? 'Agent' : 'Session';
        const count = prev.filter((t) => t.label.startsWith(prefix)).length + 1;
        const result = [...prev, { id, label: `${prefix} ${count}` }];
        const order = (l: string) => l.startsWith('Session') ? 0 : l.startsWith('Agent') ? 1 : 2;
        result.sort((a, b) => order(a.label) - order(b.label));
        return result;
      });
      setActiveTerminalId(id);
      setShowLauncher(false);
      setShowAllTerminals(false);
    }

    queryClient.invalidateQueries({ queryKey: ['sessions'] });
    setShowAdoptMenu(false);
  }

  function unhideAll() {
    const ids = [...closedSessionIds.current];
    closedSessionIds.current.clear();
    setClosedIdsVersion((v) => v + 1);

    const allSessions = sessionsData?.sessions || [];
    setTerminalInstances((prev) => {
      let updated = [...prev];
      for (const id of ids) {
        if (updated.some((t) => t.id === id)) continue;
        const session = allSessions.find((s: any) => s.id === id && (s.status === 'running' || s.status === 'detached'));
        if (!session) continue;
        const isTerminal = session.task === 'Terminal';
        const isAgent = session.task?.startsWith('Agent (');
        const prefix = isTerminal ? 'Terminal' : isAgent ? 'Agent' : 'Session';
        const count = updated.filter((t) => t.label.startsWith(prefix)).length + 1;
        updated.push({ id, label: `${prefix} ${count}` });
      }
      const order = (l: string) => l.startsWith('Session') ? 0 : l.startsWith('Agent') ? 1 : 2;
      updated.sort((a, b) => order(a.label) - order(b.label));
      return updated;
    });

    setShowLauncher(false);
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
    setShowAdoptMenu(false);
  }

  const [showAdoptMenu, setShowAdoptMenu] = useState(false);
  const adoptMenuRef = useRef<HTMLDivElement>(null);
  const adoptDropdownRef = useRef<HTMLDivElement>(null);

  // Close adopt menu on outside click
  useEffect(() => {
    if (!showAdoptMenu) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (adoptMenuRef.current?.contains(target)) return;
      if (adoptDropdownRef.current?.contains(target)) return;
      setShowAdoptMenu(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAdoptMenu]);

  async function handleResumeExternal(s: ScannedSession) {
    setShowScanAllMenu(false);
    try {
      const result = await api.sessions.resumeExternal(
        s.pid,
        s.sessionId,
        s.projectPath,
        s.task,
        s.projectPath === projectPath ? projectId : undefined,
      );
      const sid = result.session.id;
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['scan-all-sessions'] });
      handleSessionCreated(sid, undefined, 'session');
    } catch (err) {
      console.error('Failed to resume external session:', err);
    }
  }

  // Close scan-all menu on outside click
  useEffect(() => {
    if (!showScanAllMenu) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (scanAllMenuRef.current?.contains(target)) return;
      if (scanAllDropdownRef.current?.contains(target)) return;
      setShowScanAllMenu(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showScanAllMenu]);

  async function handleAdoptSession(socketPath: string) {
    setShowAdoptMenu(false);
    adoptingRef.current = true;
    try {
      const result = await api.sessions.adopt(socketPath, projectId);
      const sid = result.session.id;

      // Clear from hidden sessions so it doesn't show up in the adopt dropdown
      closedSessionIds.current.delete(sid);
      setClosedIdsVersion((v) => v + 1);

      // Refresh sessions data so projectSessions includes the re-adopted session
      // (needed for hideCursor prop which enables the force-resize redraw trick)
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['discoverable-sessions'] });

      // If the tab already exists (re-adopting a popped-out session),
      // force remount the Terminal component to reset its WebSocket state
      const existing = terminalInstances.find((t) => t.id === sid);
      if (existing) {
        setTerminalInstances((prev) =>
          prev.map((t) => (t.id === sid ? { ...t, id: sid + '_readopting' } : t))
        );
        setTimeout(() => {
          setTerminalInstances((prev) =>
            prev.map((t) => (t.id === sid + '_readopting' ? { ...t, id: sid } : t))
          );
          setActiveTerminalId(sid);
        }, 100);
      } else {
        handleSessionCreated(sid, undefined, 'session');
      }
    } catch (err) {
      console.error('Failed to adopt session:', err);
    } finally {
      adoptingRef.current = false;
      setClosedIdsVersion((v) => v + 1); // force recompute now that adopt is done
    }
  }

  function closeTerminal(id: string) {
    closedSessionIds.current.add(id);
    api.sessions.kill(id)
      .then(() => queryClient.invalidateQueries({ queryKey: ['sessions'] }))
      .catch((err) => console.error('Failed to kill session:', id, err));
    setTerminalInstances((prev) => prev.filter((t) => t.id !== id));
    if (activeTerminalId === id) {
      const remaining = terminalInstances.filter((t) => t.id !== id);
      if (remaining.length > 0) {
        setActiveTerminalId(remaining[0].id);
        setShowLauncher(false);
      } else {
        setActiveTerminalId(null);
        setShowLauncher(true);
      }
    }
  }

  function closeTerminalTab(id: string) {
    closedSessionIds.current.add(id);
    setClosedIdsVersion((v) => v + 1);
    setTerminalInstances((prev) => prev.filter((t) => t.id !== id));
    if (activeTerminalId === id) {
      const remaining = terminalInstances.filter((t) => t.id !== id);
      if (remaining.length > 0) {
        setActiveTerminalId(remaining[0].id);
        setShowLauncher(false);
      } else {
        setActiveTerminalId(null);
        setShowLauncher(true);
      }
    }
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
  }

  async function reconnectTerminal(oldId: string) {
    try {
      const { session: oldSession } = await api.sessions.get(oldId).catch(() => ({ session: null }));
      if (oldSession?.status === 'detached') {
        await api.sessions.reconnect(oldId);
        setTerminalInstances((prev) =>
          prev.map((t) => (t.id === oldId ? { ...t, id: oldId + '_reconnecting' } : t))
        );
        setTimeout(() => {
          setTerminalInstances((prev) =>
            prev.map((t) => (t.id === oldId + '_reconnecting' ? { ...t, id: oldId } : t))
          );
          setActiveTerminalId(oldId);
        }, 50);
        return;
      }

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

  function addExplorer() {
    const id = `${projectId}-explorer-${nextExplorerSeq++}`;
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

  let nextWebPageSeq = webPageInstances.length + 1;

  function addWebPage(url: string) {
    const id = `${projectId}-webpage-${Date.now()}`;
    const label = `Web ${nextWebPageSeq++}`;
    setWebPageInstances((prev) => [...prev, { id, label, url }]);
    setActiveWebPageId(id);
    setShowLauncher(false);
    setShowAllTerminals(false);
  }

  function closeWebPage(id: string) {
    setWebPageInstances((prev) => prev.filter((w) => w.id !== id));
    if (activeWebPageId === id) {
      const remaining = webPageInstances.filter((w) => w.id !== id);
      if (remaining.length > 0) {
        setActiveWebPageId(remaining[0].id);
      } else {
        setActiveWebPageId(null);
        // If no terminals either, show launcher
        if (terminalInstances.length === 0) {
          setShowLauncher(true);
        }
      }
    }
  }

  // Focus a terminal's xterm textarea after switching views
  function focusTerminalById(sessionId: string) {
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('octoally:focus-terminal', {
        detail: { sessionId },
      }));
    }, 100);
  }

  function handleWebPageCreated(url: string) {
    addWebPage(url);
  }

  // Cross-tab refresh coordination
  const [gitSavedFile, setGitSavedFile] = useState<string | null>(null);
  const [explorerSavedFile, setExplorerSavedFile] = useState<string | null>(null);

  const handleGitFileSaved = useCallback((filePath: string) => {
    setGitSavedFile(filePath);
  }, []);

  const handleExplorerFileSaved = useCallback((filePath: string) => {
    setExplorerSavedFile(filePath);
  }, []);

  const prevMode = useRef(activeMode);
  useEffect(() => {
    if (activeMode === 'git' && prevMode.current !== 'git' && explorerSavedFile) {
      setExplorerSavedFile(null);
    }
    prevMode.current = activeMode;
  }, [activeMode, explorerSavedFile]);

  // Sub-tab bar for terminal and explorer modes
  const showSubTabs = activeMode === 'terminal' || activeMode === 'explorer';

  const gridMode = showAllTerminals && !showLauncher && (terminalInstances.length + hiddenSessions.length) >= 2;

  // Persist grid preferences
  useEffect(() => {
    localStorage.setItem(`octoally-project-grid-cols-${projectId}`, String(gridColumns));
  }, [gridColumns, projectId]);
  useEffect(() => {
    localStorage.setItem(`octoally-project-grid-rows-${projectId}`, String(gridRows));
  }, [gridRows, projectId]);

  // Calculate grid card height
  useEffect(() => {
    if (!gridMode) return;
    function updateHeight() {
      if (gridRows !== 'auto') {
        if (!gridContainerRef.current) return;
        const containerHeight = gridContainerRef.current.clientHeight;
        const gap = 16;
        const padding = 32;
        const height = Math.round((containerHeight - padding - gap * (gridRows - 1)) / gridRows);
        setGridCardHeight(Math.max(150, height));
      } else {
        if (!gridInnerRef.current) return;
        const gridWidth = gridInnerRef.current.clientWidth;
        const gap = 16;
        const cardWidth = (gridWidth - gap * (gridColumns - 1)) / gridColumns;
        const height = Math.round(cardWidth * (9 / 16)) + 40;
        setGridCardHeight(Math.max(200, height));
      }
    }
    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, [gridColumns, gridRows, gridMode]);

  // Force terminal refit on grid mount — terminals were fitted to single-view
  // full width and need to refit to the narrower grid card width.
  // Dispatch refresh-terminal event for each terminal after layout settles.
  useEffect(() => {
    if (!gridMode) { setGridMounted(false); setGridShowAll(false); return; }
    const t1 = setTimeout(() => {
      setGridMounted(true);
    }, 100);
    const t2 = setTimeout(() => setGridMounted(false), 250);
    // Trigger refresh after layout is fully settled — same as clicking refresh button
    const t3 = setTimeout(() => {
      for (const term of terminalInstances) {
        window.dispatchEvent(new CustomEvent('octoally:refresh-terminal', {
          detail: { sessionId: term.id },
        }));
      }
    }, 500);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [gridMode, terminalInstances]);

  // Shown vs hidden sessions in grid — hiddenSessions are sessions with closed tabs
  // that are still running but not in terminalInstances
  const hiddenAsInstances: TerminalInstance[] = hiddenSessions.map((s) => {
    const isTerminal = s.task === 'Terminal';
    const isAgent = s.task?.startsWith('Agent (');
    const prefix = isTerminal ? 'Terminal' : isAgent ? 'Agent' : 'Session';
    return { id: s.id, label: `${prefix} (hidden)` };
  });
  const allGridInstances = [...terminalInstances, ...hiddenAsInstances];
  const gridVisibleInstances = gridShowAll ? allGridInstances : terminalInstances;
  const gridHiddenCount = hiddenSessions.length;

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

      {/* Main content area */}
      <div className="flex-1 min-w-0 flex flex-col">

        {/* Sub-tab bar */}
        {showSubTabs && (
          <div
            className="flex items-center gap-0.5 px-2 py-1 shrink-0 overflow-x-auto"
            style={{
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-secondary)',
            }}
          >
            {activeMode === 'terminal' && (
              <>
                {/* Home tab — always first */}
                <button
                  onClick={() => { setShowLauncher(true); setShowAllTerminals(false); setActiveWebPageId(null); }}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-md shrink-0 transition-colors text-xs font-medium"
                  style={{
                    color: showLauncher ? 'var(--accent)' : 'var(--text-secondary)',
                    background: showLauncher ? 'var(--bg-tertiary)' : 'transparent',
                  }}
                >
                  <Home className="w-3 h-3" />
                  Home
                </button>

                {/* Terminal session sub-tabs */}
                {terminalInstances.map((inst) => {
                  const isActive = !showLauncher && !showAllTerminals && !activeWebPageId && inst.id === activeTerminalId;
                  return (
                    <div
                      key={inst.id}
                      className="flex items-center gap-0.5 rounded-md shrink-0 group"
                      style={{ background: isActive ? 'var(--bg-tertiary)' : 'transparent' }}
                    >
                      <button
                        onClick={() => {
                          setActiveTerminalId(inst.id);
                          setActiveWebPageId(null);
                          setShowLauncher(false);
                          setShowAllTerminals(false);
                          // Focus the terminal after switching from grid to single view
                          focusTerminalById(inst.id);
                        }}
                        className="flex items-center gap-1.5 pl-3 pr-1 py-1 text-xs font-medium transition-colors"
                        style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                      >
                        {(() => {
                          const session = sessionLookup.get(inst.id);
                          const isTerminal = inst.label.startsWith('Terminal');
                          const isAgent = inst.label.startsWith('Agent');
                          const isCodex = session?.cli_type === 'codex';
                          if (isTerminal) {
                            return <TerminalSquare className="w-3 h-3 shrink-0" style={{ color: '#f59e0b' }} />;
                          }
                          // Show CLI icon + type icon for session/agent
                          return (
                            <>
                              {isCodex ? (
                                <CodexIcon className="w-3 h-3 shrink-0" style={{ color: '#7A9DFF' }} />
                              ) : (
                                <ClaudeIcon className="w-3 h-3 shrink-0" style={{ color: '#D97757' }} />
                              )}
                              {isAgent ? (
                                <Bot className="w-3 h-3 shrink-0" style={{ color: '#ef4444' }} />
                              ) : (
                                <Zap className="w-3 h-3 shrink-0" style={{ color: '#60a5fa' }} />
                              )}
                            </>
                          );
                        })()}
                        <span className="truncate">{inst.label}</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const type = inst.label.startsWith('Terminal') ? 'terminal'
                            : inst.label.startsWith('Agent') ? 'agent'
                            : 'session';
                          setCloseConfirm({ id: inst.id, label: inst.label, type });
                        }}
                        className="p-0.5 rounded opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity mr-1"
                        style={{ color: 'var(--text-secondary)' }}
                        title="Close session"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}

                {/* All Terminals grid view button — shown when 2+ total sessions (visible + hidden) */}
                {(terminalInstances.length + hiddenSessions.length) >= 2 && (
                  <button
                    onClick={() => {
                      setShowAllTerminals(!showAllTerminals);
                      setShowLauncher(false);
                      setActiveWebPageId(null);
                      if (showAllTerminals) { setGridShowAll(false); setGridFocusedId(null); }
                    }}
                    className="flex items-center gap-1 px-2 rounded-md shrink-0 transition-colors text-xs"
                    title="View all terminals"
                    style={{
                      height: 28,
                      color: showAllTerminals ? 'var(--accent)' : 'var(--text-secondary)',
                      background: showAllTerminals ? 'var(--bg-tertiary)' : 'transparent',
                    }}
                  >
                    <LayoutGrid className="w-3 h-3" />
                    <span>All</span>
                  </button>
                )}

                {/* Adopt external session button — on-demand scan */}
                <div ref={adoptMenuRef}>
                  <button
                    onClick={async () => {
                      if (showAdoptMenu) {
                        setShowAdoptMenu(false);
                      } else {
                        await refetchDiscoverable();
                        setShowAdoptMenu(true);
                      }
                    }}
                    className="flex items-center gap-1 px-2 rounded-md shrink-0 transition-colors text-xs"
                    title={hiddenSessions.length > 0 ? `${hiddenSessions.length} hidden session(s) — click to restore` : 'Scan for external sessions to adopt'}
                    style={{
                      height: 28,
                      color: hiddenSessions.length > 0 ? '#f59e0b' : showAdoptMenu ? 'var(--warning, #f59e0b)' : 'var(--text-secondary)',
                      background: showAdoptMenu ? 'var(--bg-tertiary)' : 'transparent',
                    }}
                  >
                    <Download className="w-3.5 h-3.5" />
                    {hiddenSessions.length > 0 && (
                      <span
                        className="text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center"
                        style={{ background: '#f59e0b', color: '#000' }}
                      >
                        {hiddenSessions.length}
                      </span>
                    )}
                  </button>

                  {showAdoptMenu && createPortal(
                    <div
                      ref={adoptDropdownRef}
                      className="fixed rounded-lg shadow-lg border z-[9999] min-w-[280px] max-w-[400px] py-1"
                      style={{
                        background: 'var(--bg-primary)',
                        borderColor: 'var(--border)',
                        top: (adoptMenuRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                        left: adoptMenuRef.current?.getBoundingClientRect().left ?? 0,
                      }}
                    >
                      {/* Hidden sessions (tabs the user hid but processes still running) */}
                      {hiddenSessions.length > 0 && (
                        <>
                          <div className="flex items-center justify-between px-3 py-1.5">
                            <span
                              className="text-[10px] font-semibold uppercase tracking-wider"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              Hidden
                            </span>
                            {hiddenSessions.length > 1 && (
                              <button
                                onClick={unhideAll}
                                className="text-[10px] font-medium px-1.5 py-0.5 rounded hover:opacity-80 transition-opacity"
                                style={{ color: 'var(--accent)', background: 'var(--bg-tertiary)' }}
                              >
                                Restore All
                              </button>
                            )}
                          </div>
                          {hiddenSessions.map((s: any) => {
                            const isTerminal = s.task === 'Terminal';
                            const isAgent = s.task?.startsWith('Agent (');
                            const isCodex = s.cli_type === 'codex';
                            const cliLabel = isCodex ? 'Codex' : 'Claude';
                            const typeLabel = isTerminal ? 'Terminal' : `${cliLabel} ${isAgent ? 'Agent' : 'Session'}`;
                            const typeColor = isTerminal ? '#f59e0b' : isCodex ? '#10b981' : isAgent ? '#ef4444' : '#60a5fa';
                            return (
                              <button
                                key={s.id}
                                onClick={() => unhideSession(s.id)}
                                className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors"
                                style={{ color: 'var(--text-primary)' }}
                              >
                                <div className="flex items-center gap-1.5">
                                  <span
                                    className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                                    style={{ background: `${typeColor}20`, color: typeColor }}
                                  >
                                    {typeLabel}
                                  </span>
                                  <span className="truncate">{s.task === 'Terminal' ? 'Interactive shell' : s.task?.slice(0, 50)}</span>
                                </div>
                                <div className="truncate mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                                  {s.status} · {s.created_at ? new Date(s.created_at + (s.created_at.endsWith('Z') ? '' : 'Z')).toLocaleString() : 'unknown'}
                                </div>
                              </button>
                            );
                          })}
                        </>
                      )}

                      {/* Divider between sections */}
                      {hiddenSessions.length > 0 && discoverableSessions.length > 0 && (
                        <div className="mx-3 my-1" style={{ height: 1, background: 'var(--border)' }} />
                      )}

                      {/* External sessions (tmux sessions not tracked by OctoAlly) */}
                      <div
                        className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        External
                      </div>
                      {discoverableSessions.length === 0 ? (
                        <div
                          className="px-3 py-2 text-xs"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          No external sessions found
                        </div>
                      ) : (
                        discoverableSessions.map((s) => {
                          const isTerminal = !s.task || s.task === 'Terminal';
                          const isAgent = s.task?.startsWith('Agent (');
                          const cliLabel = s.cliType === 'codex' ? 'Codex' : s.cliType === 'claude' ? 'Claude' : '';
                          const typeLabel = isTerminal ? 'Terminal' : `${cliLabel ? cliLabel + ' ' : ''}${isAgent ? 'Agent' : 'Session'}`;
                          const typeColor = isTerminal ? '#f59e0b' : s.cliType === 'codex' ? '#7A9DFF' : '#60a5fa';
                          return (
                            <button
                              key={s.socketPath}
                              onClick={() => handleAdoptSession(s.socketPath)}
                              className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors"
                              style={{ color: 'var(--text-primary)' }}
                            >
                              <div className="flex items-center gap-1.5">
                                <span
                                  className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                                  style={{ background: `${typeColor}20`, color: typeColor }}
                                >
                                  {typeLabel}
                                </span>
                                <span className="truncate">{s.task?.slice(0, 60) || 'Session'}</span>
                              </div>
                              <div className="truncate mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                                {s.startedAt ? new Date(s.startedAt + (String(s.startedAt).endsWith('Z') ? '' : 'Z')).toLocaleString() : 'unknown time'}
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>,
                    document.body
                  )}
                </div>

                {/* Scan everywhere — red button, scans all claude processes via /proc */}
                <div ref={scanAllMenuRef}>
                  <button
                    onClick={async () => {
                      if (showScanAllMenu) {
                        setShowScanAllMenu(false);
                      } else {
                        setScanAllDone(false);
                        await refetchScanAll();
                        setScanAllDone(true);
                        setShowScanAllMenu(true);
                      }
                    }}
                    className="flex items-center gap-1 px-2 rounded-md shrink-0 transition-colors text-xs"
                    title="Scan everywhere — find all running claude sessions system-wide"
                    style={{
                      height: 28,
                      color: isScanningAll ? '#f87171' : showScanAllMenu ? '#ef4444' : '#f87171',
                      background: showScanAllMenu ? 'rgba(239,68,68,0.12)' : 'transparent',
                      border: '1px solid rgba(239,68,68,0.35)',
                    }}
                  >
                    {isScanningAll ? (
                      <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                        <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
                      </svg>
                    )}
                    {!isScanningAll && scannedSessions.length > 0 && (
                      <span
                        className="text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center"
                        style={{ background: '#ef4444', color: '#fff' }}
                      >
                        {scannedSessions.length}
                      </span>
                    )}
                  </button>

                  {showScanAllMenu && createPortal(
                    <div
                      ref={scanAllDropdownRef}
                      className="fixed rounded-lg shadow-lg border z-[9999] min-w-[320px] max-w-[460px] py-1"
                      style={{
                        background: 'var(--bg-primary)',
                        borderColor: 'rgba(239,68,68,0.4)',
                        top: (scanAllMenuRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                        left: scanAllMenuRef.current?.getBoundingClientRect().left ?? 0,
                      }}
                    >
                      <div className="flex items-center justify-between px-3 py-1.5">
                        <span
                          className="text-[10px] font-semibold uppercase tracking-wider"
                          style={{ color: '#ef4444' }}
                        >
                          All External Claude Sessions
                        </span>
                        <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                          {scannedSessions.length} found
                        </span>
                      </div>
                      <div className="mx-3 mb-1" style={{ height: 1, background: 'rgba(239,68,68,0.25)' }} />
                      {scannedSessions.length === 0 ? (
                        <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {scanAllDone ? 'No external claude sessions found.' : 'Scanning…'}
                        </div>
                      ) : (
                        scannedSessions.map((s) => {
                          const isCurrent = s.projectPath === projectPath;
                          const shortPath = s.projectPath.replace(/^\/home\/[^/]+/, '~');
                          return (
                            <button
                              key={s.pid}
                              onClick={() => handleResumeExternal(s)}
                              className="w-full text-left px-3 py-2 text-xs transition-colors"
                              style={{
                                color: 'var(--text-primary)',
                                borderLeft: isCurrent ? '2px solid #ef4444' : '2px solid transparent',
                                background: 'transparent',
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(239,68,68,0.07)')}
                              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                            >
                              <div className="flex items-center gap-1.5">
                                <span
                                  className="text-[9px] font-semibold px-1.5 py-0.5 rounded shrink-0"
                                  style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}
                                >
                                  PID {s.pid}
                                </span>
                                <span className="truncate font-medium">{s.task.slice(0, 70)}</span>
                              </div>
                              <div className="mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>
                                {shortPath}
                                {isCurrent && (
                                  <span className="ml-1.5 text-[9px] font-semibold" style={{ color: '#ef4444' }}>
                                    ← this project
                                  </span>
                                )}
                              </div>
                              {s.startedAt && (
                                <div className="mt-0.5" style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>
                                  {new Date(s.startedAt).toLocaleString()} · click to resume in OctoAlly
                                </div>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>,
                    document.body
                  )}
                </div>

                {/* Web page tabs — shown alongside terminal tabs */}
                {webPageInstances.length > 0 && (
                  <div
                    className="mx-1 self-stretch"
                    style={{ width: 1, background: 'var(--border)' }}
                  />
                )}
                {webPageInstances.map((inst) => {
                  const isActive = !showLauncher && !showAllTerminals && activeWebPageId === inst.id && !activeTerminalId;
                  return (
                    <div
                      key={inst.id}
                      className="flex items-center gap-0.5 rounded-md shrink-0 group"
                      style={{ background: isActive ? 'var(--bg-tertiary)' : 'transparent' }}
                    >
                      <button
                        onClick={() => {
                          setActiveWebPageId(inst.id);
                          setActiveTerminalId(null);
                          setShowLauncher(false);
                          setShowAllTerminals(false);
                        }}
                        className="flex items-center gap-1.5 pl-3 pr-1 py-1 text-xs font-medium transition-colors"
                        style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                      >
                        <Globe className="w-3 h-3 shrink-0" style={{ color: 'var(--accent)' }} />
                        <span className="truncate max-w-[120px]">{inst.label}</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          closeWebPage(inst.id);
                        }}
                        className="p-0.5 rounded opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity mr-1"
                        style={{ color: 'var(--text-secondary)' }}
                        title="Close web page"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </>
            )}

            {activeMode === 'explorer' && (
              <>
                {explorerInstances.map((inst) => {
                  const isActive = inst.id === activeExplorerId;
                  const canClose = explorerInstances.length > 1;
                  return (
                    <div
                      key={inst.id}
                      className="flex items-center gap-0.5 rounded-md shrink-0 group"
                      style={{ background: isActive ? 'var(--bg-tertiary)' : 'transparent' }}
                    >
                      <button
                        onClick={() => setActiveExplorerId(inst.id)}
                        className="flex items-center gap-1.5 pl-3 pr-1 py-1 text-xs font-medium transition-colors"
                        style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                      >
                        <FolderTree className="w-3 h-3 shrink-0" style={{ color: 'var(--accent)' }} />
                        <span className="truncate">{inst.label}</span>
                      </button>
                      {canClose && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            closeExplorer(inst.id);
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
                <button
                  onClick={addExplorer}
                  className="flex items-center justify-center rounded-md shrink-0 transition-colors"
                  title="New Explorer"
                  style={{ width: 28, height: 28, color: 'var(--text-secondary)' }}
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        )}

        {/* Panel content */}
        <div className="flex-1 min-h-0 relative">
          {/* Terminal mode */}
          {activeMode === 'terminal' && (
            <>
              {/* Show launcher when requested or no sessions */}
              {(showLauncher || (terminalInstances.length === 0 && webPageInstances.length === 0)) && project && (
                <div className="h-full absolute inset-0">
                  <SessionLauncher
                    project={project}
                    onSessionCreated={handleSessionCreated}
                    onWebPageCreated={handleWebPageCreated}
                  />
                </div>
              )}

              {/* Terminal instances — always mounted, layout switches via CSS
                  between single-view (absolute positioned) and grid view.
                  This avoids duplicate WebSocket connections and 5000-chunk replays. */}
              <div
                className={gridMode
                  ? "h-full absolute inset-0 z-10 flex flex-col"
                  : "h-full absolute inset-0"
                }
                style={gridMode
                  ? { background: 'var(--bg-primary)' }
                  : { pointerEvents: 'none' }
                }
              >
                {/* Grid header bar with controls */}
                {gridMode && (
                  <div
                    className="flex items-center gap-2 px-4 py-2 shrink-0 border-b"
                    style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
                  >
                    <Monitor className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
                    <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                      All Sessions
                    </span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full"
                      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                    >
                      {allGridInstances.length}
                    </span>
                    {gridHiddenCount > 0 && !gridShowAll && (
                      <>
                        <span className="text-[10px]" style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>
                          ({gridVisibleInstances.length} shown, {gridHiddenCount} hidden)
                        </span>
                        <button
                          onClick={() => setGridShowAll(true)}
                          className="text-[10px] font-medium hover:underline"
                          style={{ color: 'var(--accent)' }}
                        >
                          Show All
                        </button>
                      </>
                    )}

                    {/* Columns dropdown */}
                    <div className="relative ml-auto">
                      <button
                        onClick={() => setGridColsOpen(!gridColsOpen)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                      >
                        <Columns3 className="w-3.5 h-3.5" />
                        {gridColumns} col{gridColumns !== 1 ? 's' : ''}
                        <ChevronDown className={`w-3 h-3 transition-transform ${gridColsOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {gridColsOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setGridColsOpen(false)} />
                          <div
                            className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-xl overflow-hidden"
                            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', width: '120px' }}
                          >
                            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                              <button
                                key={n}
                                onClick={() => { setGridColumns(n); setGridColsOpen(false); }}
                                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors hover:bg-white/5"
                                style={{
                                  color: n === gridColumns ? 'var(--accent)' : 'var(--text-secondary)',
                                  fontWeight: n === gridColumns ? 600 : 400,
                                  borderBottom: '1px solid var(--border)',
                                }}
                              >
                                {n} column{n !== 1 ? 's' : ''}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>

                    {/* Rows dropdown */}
                    <div className="relative">
                      <button
                        onClick={() => setGridRowsOpen(!gridRowsOpen)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                      >
                        <Rows3 className="w-3.5 h-3.5" />
                        {gridRows === 'auto' ? 'Auto' : `${gridRows} row${gridRows !== 1 ? 's' : ''}`}
                        <ChevronDown className={`w-3 h-3 transition-transform ${gridRowsOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {gridRowsOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setGridRowsOpen(false)} />
                          <div
                            className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-xl overflow-hidden"
                            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', width: '120px' }}
                          >
                            <button
                              onClick={() => { setGridRows('auto'); setGridRowsOpen(false); }}
                              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors hover:bg-white/5"
                              style={{
                                color: gridRows === 'auto' ? 'var(--accent)' : 'var(--text-secondary)',
                                fontWeight: gridRows === 'auto' ? 600 : 400,
                                borderBottom: '1px solid var(--border)',
                              }}
                            >
                              Auto (16:9)
                            </button>
                            {[1, 2, 3, 4, 5, 6].map((n) => (
                              <button
                                key={n}
                                onClick={() => { setGridRows(n); setGridRowsOpen(false); }}
                                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors hover:bg-white/5"
                                style={{
                                  color: n === gridRows ? 'var(--accent)' : 'var(--text-secondary)',
                                  fontWeight: n === gridRows ? 600 : 400,
                                  borderBottom: '1px solid var(--border)',
                                }}
                              >
                                {n} row{n !== 1 ? 's' : ''}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* Grid scroll area */}
                <div ref={gridContainerRef} className={gridMode ? "flex-1 overflow-y-auto p-4" : ""}>
                {/* Backdrop inside grid wrapper so it shares the same stacking
                    context as the expanded card (z-10 on wrapper creates a context) */}
                {gridMode && expandedTerminalId && (
                  <div
                    className="fixed inset-0 z-40"
                    style={{ background: 'rgba(0,0,0,0.7)' }}
                    onClick={() => setExpandedTerminalId(null)}
                  />
                )}
                <div
                  ref={gridInnerRef}
                  className={gridMode ? "grid gap-4" : "contents"}
                  style={gridMode ? { gridTemplateColumns: `repeat(${gridColumns}, 1fr)` } : undefined}
                >
                  {(gridMode ? gridVisibleInstances : terminalInstances).map((term) => {
                    const isSingleActive = !showLauncher && !showAllTerminals && !activeWebPageId && activeTerminalId === term.id;
                    const isExpanded = gridMode && expandedTerminalId === term.id;
                    const isFocused = gridMode && gridFocusedId === term.id;
                    const termVisible = gridMode
                      ? (active && (expandedTerminalId ? isExpanded : true))
                      : (isSingleActive && active);

                    // Lazy-mount: in single-view, only mount terminals user has viewed
                    if (termVisible || gridMode) mountedTerminals.current.add(term.id);
                    const shouldMount = gridMode || mountedTerminals.current.has(term.id);

                    return (
                      <div
                        key={term.id}
                        className={gridMode
                          ? `rounded-lg border flex flex-col overflow-hidden ${isExpanded ? 'fixed z-50 shadow-2xl' : ''}`
                          : ""
                        }
                        style={gridMode
                          ? (isExpanded ? {
                              borderColor: 'var(--border)',
                              background: '#0f1117',
                              width: 'calc(100vw - 48px)',
                              height: 'calc(100vh - 48px)',
                              top: '24px',
                              left: '24px',
                            } : {
                              borderColor: isFocused ? '#22c55e' : 'var(--border)',
                              background: 'var(--bg-secondary)',
                              height: `${gridCardHeight + (gridMounted ? 1 : 0)}px`,
                            })
                          : {
                              visibility: isSingleActive ? 'visible' : 'hidden',
                              pointerEvents: isSingleActive ? 'auto' : 'none',
                              zIndex: isSingleActive ? 1 : 0,
                              position: 'absolute' as const,
                              inset: 0,
                              height: '100%',
                            }
                        }
                        onClick={isExpanded ? (e) => e.stopPropagation() : undefined}
                        onMouseDown={gridMode && !isExpanded ? () => setGridFocusedId(term.id) : undefined}
                      >
                        {/* Card header — always in DOM for stable React tree, hidden in single view */}
                        <div
                          className="items-center gap-2 px-3 py-2 border-b shrink-0 rounded-t-lg transition-colors duration-200"
                          style={{
                            borderColor: isFocused && gridMode ? '#22c55e' : 'var(--border)',
                            background: isFocused && gridMode ? '#22c55e30' : 'var(--bg-tertiary)',
                            display: gridMode ? 'flex' : 'none',
                          }}
                        >
                          {(() => {
                            const s = sessionLookup.get(term.id);
                            const isTerminal = term.label.startsWith('Terminal');
                            const isAgent = term.label.startsWith('Agent');
                            const isCodex = s?.cli_type === 'codex';
                            if (isTerminal) {
                              return <TerminalSquare className="w-3.5 h-3.5 shrink-0" style={{ color: '#f59e0b' }} />;
                            }
                            return (
                              <>
                                {isCodex ? (
                                  <CodexIcon className="w-3.5 h-3.5 shrink-0" style={{ color: '#7A9DFF' }} />
                                ) : (
                                  <ClaudeIcon className="w-3.5 h-3.5 shrink-0" style={{ color: '#D97757' }} />
                                )}
                                {isAgent ? (
                                  <Bot className="w-3 h-3 shrink-0" style={{ color: '#ef4444' }} />
                                ) : (
                                  <Zap className="w-3 h-3 shrink-0" style={{ color: '#60a5fa' }} />
                                )}
                              </>
                            );
                          })()}
                          <span className={`font-medium shrink-0 ${isExpanded ? 'text-sm' : 'text-xs'}`} style={{ color: 'var(--text-primary)' }}>
                            {term.label}
                          </span>
                          <span className={`truncate min-w-0 ml-auto ${isExpanded ? 'text-xs ml-2' : 'text-[10px]'}`} style={{ color: 'var(--text-secondary)' }}>
                            {projectSessions.find((s) => s.id === term.id)?.task || 'Terminal'}
                          </span>
                          {isExpanded ? (
                            <div className="flex items-center gap-2 ml-auto">
                              <button
                                onClick={() => {
                                  setActiveTerminalId(term.id);
                                  setShowAllTerminals(false);
                                  setExpandedTerminalId(null);
                                  focusTerminalById(term.id);
                                }}
                                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors"
                                style={{ background: 'var(--accent)', color: 'white' }}
                                title="Focus this terminal"
                              >
                                <ExternalLink className="w-3 h-3" />
                                <span>Focus</span>
                              </button>
                              <button
                                onClick={() => setExpandedTerminalId(null)}
                                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                                title="Minimize back to grid"
                              >
                                <Minimize2 className="w-3 h-3" />
                                <span>Minimize</span>
                              </button>
                            </div>
                          ) : (
                            <>
                              <button
                                onClick={() => setExpandedTerminalId(term.id)}
                                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors hover:opacity-100 opacity-70"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                                title="Expand terminal"
                              >
                                <Maximize2 className="w-2.5 h-2.5" />
                              </button>
                              <button
                                onClick={() => {
                                  setActiveTerminalId(term.id);
                                  setShowAllTerminals(false);
                                  focusTerminalById(term.id);
                                }}
                                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors hover:opacity-100 opacity-70"
                                style={{ background: 'var(--accent)', color: 'white' }}
                                title="Focus this terminal"
                              >
                                <ExternalLink className="w-2.5 h-2.5" />
                              </button>
                            </>
                          )}
                        </div>
                        <div className={gridMode ? "flex-1 min-h-0" : "h-full"}>
                          {shouldMount && (
                            <Terminal
                              sessionId={term.id}
                              visible={termVisible}
                              suspended={terminalsSuspended || (!gridMode && !termVisible)}
                              passiveResize={gridMode && !isExpanded && projectSessions.find((s) => s.id === term.id)?.task === 'Terminal'}
                              hideCursor={projectSessions.find((s) => s.id === term.id)?.task !== 'Terminal' && projectSessions.some((s) => s.id === term.id)}
                              cliType={sessionLookup.get(term.id)?.cli_type as 'claude' | 'codex' | undefined}
                              onReconnect={() => reconnectTerminal(term.id)}
                              onPopOut={() => closeTerminalTab(term.id)}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                </div>{/* close gridContainerRef */}
              </div>
            </>
          )}

          {/* Web page instances */}
          {activeMode === 'terminal' && webPageInstances.map((wp) => {
            const isActiveWP = activeWebPageId === wp.id && !showLauncher && !showAllTerminals;
            return (
              <div
                key={wp.id}
                className="h-full absolute inset-0"
                style={{
                  visibility: isActiveWP ? 'visible' : 'hidden',
                  pointerEvents: isActiveWP ? 'auto' : 'none',
                  zIndex: isActiveWP ? 2 : 0,
                }}
              >
                <WebPageView
                  url={wp.url}
                  visible={isActiveWP && active}
                  onUrlChange={(newUrl) => {
                    setWebPageInstances((prev) =>
                      prev.map((w) => (w.id === wp.id ? { ...w, url: newUrl } : w))
                    );
                  }}
                />
              </div>
            );
          })}

          {/* Explorer instances */}
          {explorerInstances.map((expl) => (
            <div
              key={expl.id}
              className="h-full absolute inset-0"
              style={{
                display: activeMode === 'explorer' && activeExplorerId === expl.id ? 'block' : 'none',
              }}
            >
              <FileExplorer rootPath={projectPath} instanceId={expl.id} refreshFilePath={gitSavedFile} onFileSaved={handleExplorerFileSaved} />
            </div>
          ))}

          {/* Events panel */}
          {/* Git panel */}
          <div
            className="h-full absolute inset-0"
            style={{ display: activeMode === 'git' ? 'block' : 'none' }}
          >
            <GitPanel projectPath={projectPath} isVisible={activeMode === 'git'} onFileSaved={handleGitFileSaved} />
          </div>
        </div>
      </div>

      {/* Close tab confirmation modal */}
      {closeConfirm && (
        <CloseTabModal
          label={closeConfirm.label}
          type={closeConfirm.type}
          onHide={() => {
            closeTerminalTab(closeConfirm.id);
            setCloseConfirm(null);
          }}
          onKill={() => {
            closeTerminal(closeConfirm.id);
            setCloseConfirm(null);
          }}
          onCancel={() => setCloseConfirm(null)}
        />
      )}
    </div>
  );
}
