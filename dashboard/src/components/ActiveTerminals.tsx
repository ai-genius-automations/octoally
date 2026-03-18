import { useState, useRef, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Session, Project } from '../lib/api';
import { Terminal } from './Terminal';
import { Monitor, ArrowLeft, ExternalLink, Minimize2, Maximize2, ChevronDown, X, Columns3, Rows3, Zap, Bot, TerminalSquare } from 'lucide-react';

interface ActiveTerminalsProps {
  onBack: () => void;
  onGoToSession: (projectId: string, sessionId: string) => void;
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

const COLUMNS_KEY = 'hivecommand-active-terminals-cols';
const ROWS_KEY = 'hivecommand-active-terminals-rows';

export function ActiveTerminals({ onBack, onGoToSession }: ActiveTerminalsProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<ExpandedSession | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
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

  // Group by project
  const groupMap = new Map<string, SessionGroup>();
  for (const session of activeSessions) {
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

  const cards: { session: Session; groupLabel: string; projectId: string | null }[] = [];
  for (const group of groups) {
    for (const session of group.sessions) {
      cards.push({ session, groupLabel: group.label, projectId: group.projectId });
    }
  }
  cards.sort((a, b) => a.groupLabel.localeCompare(b.groupLabel));

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
                      {session.task === 'Terminal' ? (
                        <TerminalSquare className="w-3 h-3 shrink-0" style={{ color: '#f59e0b' }} />
                      ) : session.task.startsWith('Agent (') ? (
                        <Bot className="w-3 h-3 shrink-0" style={{ color: '#ef4444' }} />
                      ) : (
                        <Zap className="w-3 h-3 shrink-0" style={{ color: '#60a5fa' }} />
                      )}
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

      {/* Grid — always render the container so Terminal components don't get
          destroyed/recreated when the cards list changes between renders */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 relative">
        {cards.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <Monitor className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-secondary)', opacity: 0.4 }} />
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                No active sessions
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
                  height: `${cardHeight}px`,
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
                  {session.task === 'Terminal' ? (
                    <TerminalSquare className="w-3.5 h-3.5 shrink-0" style={{ color: '#f59e0b' }} />
                  ) : session.task.startsWith('Agent (') ? (
                    <Bot className="w-3.5 h-3.5 shrink-0" style={{ color: '#ef4444' }} />
                  ) : (
                    <Zap className="w-3.5 h-3.5 shrink-0" style={{ color: '#60a5fa' }} />
                  )}
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
                  <Terminal sessionId={session.id} visible={!expanded} passiveResize={!!expanded || session.task === 'Terminal'} hideCursor={session.task !== 'Terminal'} />
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
              {expanded.session.task === 'Terminal' ? (
                <TerminalSquare className="w-4 h-4 shrink-0" style={{ color: '#f59e0b' }} />
              ) : expanded.session.task.startsWith('Agent (') ? (
                <Bot className="w-4 h-4 shrink-0" style={{ color: '#ef4444' }} />
              ) : (
                <Zap className="w-4 h-4 shrink-0" style={{ color: '#60a5fa' }} />
              )}
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
              <Terminal sessionId={expanded.session.id} visible={true} hideCursor={expanded.session.task !== 'Terminal'} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
