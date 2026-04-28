import { useState, useRef, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Session, Project } from '../lib/api';
import { Terminal } from './Terminal';
import { Monitor, ArrowLeft, ExternalLink, Minimize2, Maximize2, ChevronDown, X, Columns3, Rows3, Zap, Bot, TerminalSquare, Minus } from 'lucide-react';
import { ClaudeIcon, CodexIcon } from './CliIcons';

interface ActiveTerminalsProps {
  onBack: () => void;
  onGoToSession: (projectId: string, sessionId: string) => void;
  openProjectIds?: string[];
  hiddenSessionIds?: string[];
}

interface SessionGroup {
  label: string;
  projectId: string | null;
  sessions: Session[];
}

interface ExpandedSession {
  session: Session;
  groupLabel: string;
  projectId: string | null;
}

const COLUMNS_KEY = 'octoally-active-terminals-cols';
const ROWS_KEY = 'octoally-active-terminals-rows';
const MINIMIZED_KEY = 'octoally-active-terminals-minimized';

export function ActiveTerminals({ onBack, onGoToSession, openProjectIds, hiddenSessionIds }: ActiveTerminalsProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<ExpandedSession | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [rowsOpen, setRowsOpen] = useState(false);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [columns, setColumns] = useState(() => {
    const saved = localStorage.getItem(COLUMNS_KEY);
    return saved ? Math.min(10, Math.max(1, parseInt(saved, 10) || 3)) : 3;
  });
  const [rows, setRows] = useState<number | 'auto'>(() => {
    const saved = localStorage.getItem(ROWS_KEY);
    if (!saved || saved === 'auto') return 'auto';
    return Math.min(6, Math.max(1, parseInt(saved, 10) || 2));
  });
  const [minimizedSessionIds, setMinimizedSessionIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(MINIMIZED_KEY);
      if (!saved) return new Set();
      const arr = JSON.parse(saved);
      return new Set(Array.isArray(arr) ? (arr as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(420);

  // Persist column and row preferences
  useEffect(() => {
    localStorage.setItem(COLUMNS_KEY, String(columns));
  }, [columns]);
  useEffect(() => {
    localStorage.setItem(ROWS_KEY, String(rows));
  }, [rows]);
  // Persist minimized IDs. We compute the alive set inside the effect from the
  // ref-stable query cache instead of taking activeSessions as a dependency —
  // activeSessions changes identity on every poll, which would re-run the effect
  // unnecessarily. The localStorage write is idempotent so this is safe.
  useEffect(() => {
    const sessions = (queryClient.getQueryData(['sessions']) as { sessions?: Session[] } | undefined)?.sessions ?? [];
    const aliveIds = new Set(
      sessions.filter((s) => s.status === 'running' || s.status === 'detached').map((s) => s.id),
    );
    const valid = [...minimizedSessionIds].filter((id) => aliveIds.has(id));
    localStorage.setItem(MINIMIZED_KEY, JSON.stringify(valid));
  }, [minimizedSessionIds, queryClient]);

  // Calculate card height: row-count mode divides container height, auto uses 16:9 ratio
  useEffect(() => {
    function updateHeight() {
      if (rows !== 'auto') {
        if (!scrollContainerRef.current) return;
        const containerHeight = scrollContainerRef.current.clientHeight;
        const gap = 16; // gap-4 = 16px
        const padding = 32; // p-4 = 16px * 2
        const height = Math.round((containerHeight - padding - gap * (rows - 1)) / rows);
        setCardHeight(Math.max(150, height));
      } else {
        if (!gridRef.current) return;
        const gridWidth = gridRef.current.clientWidth;
        const gap = 16;
        const cardWidth = (gridWidth - gap * (columns - 1)) / columns;
        const height = Math.round(cardWidth * (9 / 16)) + 40;
        setCardHeight(Math.max(200, height));
      }
    }
    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, [columns, rows]);

  // Force terminal redraw on mount — terminals render before the grid is laid out,
  // so nudge cardHeight by ±1px after paint to trigger ResizeObserver in each Terminal,
  // then dispatch refresh-terminal at 500ms for reliable refit on all machines
  const [mounted, setMounted] = useState(false);
  const refreshedRef = useRef(false);
  useEffect(() => {
    const t1 = setTimeout(() => setMounted(true), 50);
    const t2 = setTimeout(() => setMounted(false), 150);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);


  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
  });

  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects.list(),
  });

  const sessions = sessionsData?.sessions || [];
  const projects = projectsData?.projects || [];
  const projectMap = new Map<string, Project>(projects.map((p) => [p.id, p]));

  const activeSessions = sessions.filter(
    (s) => s.status === 'running' || s.status === 'detached'
  );

  // Split into shown (open tab or plain terminal) vs hidden (tab not open or individually hidden)
  const openSet = openProjectIds ? new Set(openProjectIds) : null;
  const hiddenSet = hiddenSessionIds && hiddenSessionIds.length > 0 ? new Set(hiddenSessionIds) : null;
  const normallyShown = activeSessions.filter((s) => {
    // Exclude sessions from closed project tabs
    if (openSet && s.project_id && !openSet.has(s.project_id)) return false;
    // Exclude individually hidden session tabs
    if (hiddenSet && hiddenSet.has(s.id)) return false;
    return true;
  });
  const hiddenCount = activeSessions.length - normallyShown.length;
  const shownSessions = showAll ? activeSessions : normallyShown;

  // Group by project
  const groupMap = new Map<string, SessionGroup>();
  for (const session of shownSessions) {
    const key = session.project_id || '__plain__';
    if (!groupMap.has(key)) {
      const project = session.project_id ? projectMap.get(session.project_id) : null;
      groupMap.set(key, {
        label: project?.name || 'Plain Terminal',
        projectId: session.project_id,
        sessions: [],
      });
    }
    groupMap.get(key)!.sessions.push(session);
  }

  const groups = Array.from(groupMap.values());

  const allCards: { session: Session; groupLabel: string; projectId: string | null }[] = [];
  for (const group of groups) {
    for (const session of group.sessions) {
      allCards.push({ session, groupLabel: group.label, projectId: group.projectId });
    }
  }
  allCards.sort((a, b) => a.groupLabel.localeCompare(b.groupLabel));

  // Split into visible cards (rendered in grid) and minimized cards (rendered in tray).
  // Minimized cards keep their server-side PTY alive — we just unmount the Terminal,
  // and the WebSocket replays scrollback when the user restores them.
  const cards = allCards.filter((c) => !minimizedSessionIds.has(c.session.id));
  const minimizedCards = allCards.filter((c) => minimizedSessionIds.has(c.session.id));

  // Note: stale IDs in `minimizedSessionIds` (sessions that died while minimized)
  // are filtered out at derivation time (minimizedCards above) so they never
  // surface in the UI. We don't reconcile the in-memory Set in an effect to
  // avoid cascading renders — the persistence effect below strips dead IDs
  // before writing to localStorage, so storage stays clean across reloads.

  const minimize = useCallback((sessionId: string) => {
    setFocusedSessionId((cur) => (cur === sessionId ? null : cur));
    setMinimizedSessionIds((prev) => {
      if (prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.add(sessionId);
      return next;
    });
  }, []);

  const restore = useCallback((sessionId: string) => {
    setMinimizedSessionIds((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
    setFocusedSessionId(sessionId);
    // Force a refit once the card has had a frame to lay out
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('octoally:refresh-terminal', {
        detail: { sessionId },
      }));
    }, 50);
  }, []);

  // Dispatch refresh-terminal for all cards once after mount for reliable refit
  useEffect(() => {
    if (cards.length === 0 || refreshedRef.current) return;
    refreshedRef.current = true;
    const t = setTimeout(() => {
      for (const { session } of cards) {
        window.dispatchEvent(new CustomEvent('octoally:refresh-terminal', {
          detail: { sessionId: session.id },
        }));
      }
    }, 500);
    return () => clearTimeout(t);
  }, [cards.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const jumpToSession = useCallback((sessionId: string) => {
    setJumpOpen(false);
    setFocusedSessionId(sessionId);
    const card = cardRefs.current.get(sessionId);
    if (card && scrollContainerRef.current) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        const textarea = card.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
        textarea?.focus({ preventScroll: true });
      }, 400);
    }
  }, []);

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header bar */}
      <div
        className="flex items-center gap-3 px-4 py-2.5 border-b shrink-0"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </button>
        <div className="flex items-center gap-2">
          <Monitor className="w-4 h-4" style={{ color: 'var(--accent)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Active Sessions
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          >
            {activeSessions.length}
          </span>
          {hiddenCount > 0 && !showAll && (
            <>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full"
                style={{ color: 'var(--text-secondary)', opacity: 0.7 }}
              >
                ({normallyShown.length} shown, {hiddenCount} hidden)
              </span>
              <button
                onClick={() => setShowAll(true)}
                className="text-[10px] font-medium hover:underline"
                style={{ color: 'var(--accent)' }}
              >
                Show All
              </button>
            </>
          )}
        </div>

        {/* Columns dropdown */}
        <div className="relative ml-auto">
          <button
            onClick={() => setColsOpen(!colsOpen)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            <Columns3 className="w-3.5 h-3.5" />
            {columns} col{columns !== 1 ? 's' : ''}
            <ChevronDown className={`w-3 h-3 transition-transform ${colsOpen ? 'rotate-180' : ''}`} />
          </button>
          {colsOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setColsOpen(false)} />
              <div
                className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-xl overflow-hidden"
                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', width: '120px' }}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <button
                    key={n}
                    onClick={() => { setColumns(n); setColsOpen(false); }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors hover:bg-white/5"
                    style={{
                      color: n === columns ? 'var(--accent)' : 'var(--text-secondary)',
                      fontWeight: n === columns ? 600 : 400,
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
            onClick={() => setRowsOpen(!rowsOpen)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            <Rows3 className="w-3.5 h-3.5" />
            {rows === 'auto' ? 'Auto' : `${rows} row${rows !== 1 ? 's' : ''}`}
            <ChevronDown className={`w-3 h-3 transition-transform ${rowsOpen ? 'rotate-180' : ''}`} />
          </button>
          {rowsOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setRowsOpen(false)} />
              <div
                className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-xl overflow-hidden"
                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', width: '120px' }}
              >
                <button
                  onClick={() => { setRows('auto'); setRowsOpen(false); }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors hover:bg-white/5"
                  style={{
                    color: rows === 'auto' ? 'var(--accent)' : 'var(--text-secondary)',
                    fontWeight: rows === 'auto' ? 600 : 400,
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  Auto (16:9)
                </button>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <button
                    key={n}
                    onClick={() => { setRows(n); setRowsOpen(false); }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors hover:bg-white/5"
                    style={{
                      color: n === rows ? 'var(--accent)' : 'var(--text-secondary)',
                      fontWeight: n === rows ? 600 : 400,
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

        {/* Jump-to dropdown */}
        {cards.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setJumpOpen(!jumpOpen)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              Jump to
              <ChevronDown className={`w-3 h-3 transition-transform ${jumpOpen ? 'rotate-180' : ''}`} />
            </button>
            {jumpOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setJumpOpen(false)} />
                <div
                  className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-xl overflow-hidden"
                  style={{
                    background: 'var(--bg-secondary)',
                    borderColor: 'var(--border)',
                    width: '280px',
                    maxHeight: '320px',
                    overflowY: 'auto',
                  }}
                >
                  {cards.map(({ session, groupLabel, projectId: _projectId }) => (
                    <button
                      key={session.id}
                      onClick={() => jumpToSession(session.id)}
                      className="flex items-center gap-2 w-full px-3 py-2 text-left text-xs transition-colors hover:bg-white/5 overflow-hidden"
                      style={{ borderBottom: '1px solid var(--border)' }}
                    >
                      {(() => {
                        const isTerminal = session.task === 'Terminal';
                        const isAgent = session.task.startsWith('Agent (');
                        const isCodex = (session as any).cli_type === 'codex';
                        if (isTerminal) {
                          return <TerminalSquare className="w-3 h-3 shrink-0" style={{ color: '#f59e0b' }} />;
                        }
                        return (
                          <>
                            {isCodex ? (
                              <CodexIcon className="w-3 h-3 shrink-0" style={{ color: '#7A9DFF' }} />
                            ) : (
                              <ClaudeIcon className="w-3 h-3 shrink-0" style={{ color: '#D97757' }} />
                            )}
                            {isAgent ? (
                              <Bot className="w-2.5 h-2.5 shrink-0" style={{ color: '#ef4444' }} />
                            ) : (
                              <Zap className="w-2.5 h-2.5 shrink-0" style={{ color: '#60a5fa' }} />
                            )}
                          </>
                        );
                      })()}
                      <span className="font-medium shrink-0" style={{ color: 'var(--text-primary)' }}>
                        {groupLabel}
                      </span>
                      <span className="truncate min-w-0 flex-1" style={{ color: 'var(--text-secondary)' }}>
                        {session.task || 'Terminal'}
                      </span>
                      <div
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{
                          background: session.status === 'running' ? 'var(--success)' : 'var(--warning)',
                        }}
                      />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Minimized tray — sessions kept alive on the server but hidden from the grid */}
      {minimizedCards.length > 0 && (
        <div
          className="flex items-center gap-2 px-4 py-2 border-b shrink-0 flex-wrap"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
        >
          <span
            className="text-[10px] font-semibold uppercase tracking-wide shrink-0"
            style={{ color: 'var(--text-secondary)' }}
          >
            Minimized · {minimizedCards.length}
          </span>
          {minimizedCards.map(({ session, groupLabel }) => {
            const isTerminal = session.task === 'Terminal';
            const isAgent = session.task.startsWith('Agent (');
            const isCodex = (session as Session & { cli_type?: string }).cli_type === 'codex';
            return (
              <div
                key={session.id}
                className="flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md border"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}
              >
                {isTerminal ? (
                  <TerminalSquare className="w-3 h-3 shrink-0" style={{ color: '#f59e0b' }} />
                ) : (
                  <>
                    {isCodex ? (
                      <CodexIcon className="w-3 h-3 shrink-0" style={{ color: '#7A9DFF' }} />
                    ) : (
                      <ClaudeIcon className="w-3 h-3 shrink-0" style={{ color: '#D97757' }} />
                    )}
                    {isAgent ? (
                      <Bot className="w-2.5 h-2.5 shrink-0" style={{ color: '#ef4444' }} />
                    ) : (
                      <Zap className="w-2.5 h-2.5 shrink-0" style={{ color: '#60a5fa' }} />
                    )}
                  </>
                )}
                <button
                  onClick={() => restore(session.id)}
                  className="flex items-center gap-1.5 text-xs font-medium"
                  style={{ color: 'var(--text-primary)' }}
                  title="Restore to grid"
                >
                  <span>{groupLabel}</span>
                  <span style={{ color: 'var(--text-secondary)' }} className="max-w-[160px] truncate">
                    {session.task || 'Terminal'}
                  </span>
                </button>
                <div
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{
                    background: session.status === 'running' ? 'var(--success)' : 'var(--warning)',
                  }}
                />
                <button
                  onClick={() => restore(session.id)}
                  className="flex items-center justify-center w-5 h-5 rounded transition-colors hover:opacity-100 opacity-70"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                  title="Restore to grid"
                >
                  <Maximize2 className="w-2.5 h-2.5" />
                </button>
                <button
                  onClick={() => {
                    api.sessions.kill(session.id)
                      .catch(() => {})
                      .finally(() => queryClient.invalidateQueries({ queryKey: ['sessions'] }));
                  }}
                  className="flex items-center justify-center w-5 h-5 rounded transition-colors hover:opacity-100 opacity-70"
                  style={{ background: '#ef4444', color: 'white' }}
                  title="Kill session"
                >
                  <X className="w-3 h-3" strokeWidth={3} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Grid — always render the container so Terminal components don't get
          destroyed/recreated when the cards list changes between renders */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 relative">
        {cards.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <Monitor className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-secondary)', opacity: 0.4 }} />
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {minimizedCards.length > 0 ? 'All sessions minimized' : 'No active sessions'}
              </p>
            </div>
          </div>
        )}
        <div
          ref={gridRef}
          className="grid gap-4"
          style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
        >
          {cards.map(({ session, groupLabel, projectId }) => {
              const isFocused = focusedSessionId === session.id;
              return (
              <div
                key={session.id}
                ref={(el) => {
                  if (el) cardRefs.current.set(session.id, el);
                  else cardRefs.current.delete(session.id);
                }}
                className="rounded-lg border flex flex-col overflow-hidden transition-all duration-200"
                style={{
                  borderColor: isFocused ? '#22c55e' : 'var(--border)',
                  background: 'var(--bg-secondary)',
                  height: `${cardHeight + (mounted ? 1 : 0)}px`,
                }}
              >
                {/* Card header */}
                <div
                  className="flex items-center gap-1.5 px-2 h-[34px] border-b rounded-t-lg transition-colors duration-200 overflow-hidden"
                  style={{
                    borderColor: isFocused ? '#22c55e' : 'var(--border)',
                    background: isFocused ? '#22c55e30' : 'var(--bg-tertiary)',
                  }}
                >
                  {(() => {
                    const isTerminal = session.task === 'Terminal';
                    const isAgent = session.task.startsWith('Agent (');
                    const isCodex = (session as any).cli_type === 'codex';
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
                  <span className="text-xs font-medium shrink-0" style={{ color: 'var(--text-primary)' }}>
                    {groupLabel}
                  </span>
                  <span className="text-[10px] truncate min-w-0 ml-auto" style={{ color: 'var(--text-secondary)' }}>
                    {session.task || 'Terminal'}
                  </span>
                  <div
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{
                      background: session.status === 'running' ? 'var(--success)' : 'var(--warning)',
                    }}
                  />
                  <button
                    onClick={() => minimize(session.id)}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors hover:opacity-100 opacity-70"
                    style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                    title="Minimize to tray (keeps session alive)"
                  >
                    <Minus className="w-2.5 h-2.5" />
                  </button>
                  <button
                    onClick={() => {
                      setFocusedSessionId(session.id);
                      setExpanded({ session, groupLabel, projectId });
                    }}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors hover:opacity-100 opacity-70"
                    style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                    title="Expand terminal"
                  >
                    <Maximize2 className="w-2.5 h-2.5" />
                  </button>
                  {projectId && (
                    <button
                      onClick={() => onGoToSession(projectId, session.id)}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors hover:opacity-100 opacity-70"
                      style={{ background: 'var(--accent)', color: 'white' }}
                      title="Open full session view"
                    >
                      <ExternalLink className="w-2.5 h-2.5" />
                    </button>
                  )}
                  <button
                    onClick={() => {
                      api.sessions.kill(session.id)
                        .catch(() => {})
                        .finally(() => queryClient.invalidateQueries({ queryKey: ['sessions'] }));
                    }}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors hover:opacity-100 opacity-70"
                    style={{ background: '#ef4444', color: 'white' }}
                    title="Kill session"
                  >
                    <X className="w-3.5 h-3.5" strokeWidth={3} />
                  </button>
                </div>
                {/* Live terminal — overlay blocks scroll on unfocused terminals */}
                <div className="flex-1 min-h-0 relative">
                  <div
                    className="absolute inset-0 z-[5]"
                    style={{ pointerEvents: isFocused ? 'none' : 'auto' }}
                    onMouseDown={(e) => {
                      if (!isFocused) {
                        e.preventDefault();
                        e.stopPropagation();
                        setFocusedSessionId(session.id);
                        // Focus textarea directly — doesn't trigger ResizeObserver like removing overlay does
                        const card = cardRefs.current.get(session.id);
                        const textarea = card?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
                        textarea?.focus({ preventScroll: true });
                      }
                    }}
                  />
                  <Terminal sessionId={session.id} visible={!expanded} passiveResize={!!expanded || session.task === 'Terminal' || (session as any).cli_type === 'codex'} hideCursor={session.task !== 'Terminal'} cliType={(session as any).cli_type as 'claude' | 'codex' | undefined} onPopOut={() => queryClient.invalidateQueries({ queryKey: ['sessions'] })} />
                </div>
              </div>
              );
            })}
          </div>
        </div>

      {/* Expanded terminal modal */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => {
            const sid = expanded.session.id;
            setFocusedSessionId(sid);
            setExpanded(null);
          }}
        >
          <div
            className="flex flex-col rounded-lg border shadow-2xl"
            style={{
              width: 'calc(100vw - 48px)',
              height: 'calc(100vh - 48px)',
              borderColor: 'var(--border)',
              background: 'var(--bg-secondary)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div
              className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0 rounded-t-lg"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}
            >
              {(() => {
                const isTerminal = expanded.session.task === 'Terminal';
                const isAgent = expanded.session.task.startsWith('Agent (');
                const isCodex = (expanded.session as any).cli_type === 'codex';
                if (isTerminal) {
                  return <TerminalSquare className="w-4 h-4 shrink-0" style={{ color: '#f59e0b' }} />;
                }
                return (
                  <>
                    {isCodex ? (
                      <CodexIcon className="w-4 h-4 shrink-0" style={{ color: '#7A9DFF' }} />
                    ) : (
                      <ClaudeIcon className="w-4 h-4 shrink-0" style={{ color: '#D97757' }} />
                    )}
                    {isAgent ? (
                      <Bot className="w-3.5 h-3.5 shrink-0" style={{ color: '#ef4444' }} />
                    ) : (
                      <Zap className="w-3.5 h-3.5 shrink-0" style={{ color: '#60a5fa' }} />
                    )}
                  </>
                );
              })()}
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {expanded.groupLabel}
              </span>
              <span className="text-xs ml-2 truncate" style={{ color: 'var(--text-secondary)' }}>
                {expanded.session.task || 'Terminal'}
              </span>
              <div className="flex items-center gap-2 ml-auto shrink-0">
                {expanded.projectId && (
                  <button
                    onClick={() => {
                      onGoToSession(expanded.projectId!, expanded.session.id);
                      setExpanded(null);
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors"
                    style={{ background: 'var(--accent)', color: 'white' }}
                    title="Open full session view"
                  >
                    <ExternalLink className="w-3 h-3 shrink-0" />
                    <span>Open Session</span>
                  </button>
                )}
                <button
                  onClick={() => {
                    const sid = expanded.session.id;
                    setFocusedSessionId(sid);
                    setExpanded(null);
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                  title="Minimize back to grid"
                >
                  <Minimize2 className="w-3 h-3 shrink-0" />
                  <span>Minimize</span>
                </button>
              </div>
            </div>
            {/* Full interactive terminal */}
            <div className="flex-1 min-h-0">
              <Terminal sessionId={expanded.session.id} visible={true} hideCursor={expanded.session.task !== 'Terminal'} cliType={(expanded.session as any).cli_type as 'claude' | 'codex' | undefined} onPopOut={() => { setExpanded(null); queryClient.invalidateQueries({ queryKey: ['sessions'] }); }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
