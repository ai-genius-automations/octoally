import { useEffect, useRef } from 'react';
import { useStreamStore } from '../lib/websocket';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Radio, Terminal, FileEdit, Zap, AlertCircle, ArrowLeft, FolderOpen } from 'lucide-react';
import { ModelBadge, parseRouteDecision } from './ModelBadge';

function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[PX^_].*?\x1b\\|\x1b.|\r/g;
  return text.replace(ansiRegex, '');
}

function cleanOutput(text: string): string {
  let cleaned = stripAnsiCodes(text);
  cleaned = cleaned.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  return cleaned.trim();
}

const typeIcons: Record<string, typeof Radio> = {
  tool_use: Zap,
  stdout: Terminal,
  stderr: AlertCircle,
  edit: FileEdit,
  session_start: Radio,
  session_end: Radio,
  pty_output: Terminal,
  route_decision: Radio,
};

const typeColors: Record<string, string> = {
  tool_use: '#a78bfa',
  stdout: '#34d399',
  stderr: '#f87171',
  edit: '#60a5fa',
  session_start: '#facc15',
  session_end: '#94a3b8',
  pty_output: '#34d399',
  route_decision: '#94a3b8',
};

interface ActiveEventsProps {
  onBack: () => void;
  onGoToSession: (projectId: string, sessionId: string) => void;
}

export function ActiveEvents({ onBack, onGoToSession }: ActiveEventsProps) {
  const events = useStreamStore((s) => s.events);
  const connected = useStreamStore((s) => s.connected);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch sessions and projects to map session_id → project name
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
    staleTime: 10_000,
  });
  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects.list(),
    staleTime: 30_000,
  });

  const sessionMap = new Map<string, { projectId: string; projectName: string; task: string }>();
  if (sessionsData?.sessions && projectsData?.projects) {
    for (const s of sessionsData.sessions) {
      const project = projectsData.projects.find((p) => p.id === s.project_id);
      sessionMap.set(s.id, {
        projectId: s.project_id || '',
        projectName: project?.name || 'Unknown',
        task: s.task || '',
      });
    }
  }

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b shrink-0"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-1 rounded-md transition-colors hover:bg-white/10"
            style={{ color: 'var(--text-secondary)' }}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4" style={{ color: '#a78bfa' }} />
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Live Events
            </h2>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div
              className="w-2 h-2 rounded-full"
              style={{ background: connected ? '#34d399' : '#f87171' }}
            />
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          >
            {events.length} events
          </span>
        </div>
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center" style={{ color: 'var(--text-secondary)' }}>
              <Radio className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm font-medium">Waiting for events...</p>
              <p className="text-xs mt-1.5 max-w-xs mx-auto">
                Events appear here as Claude Code sessions run. Make sure the on-tool-use hook is installed.
              </p>
            </div>
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {[...events].reverse().map((event) => {
              const Icon = typeIcons[event.type] || Zap;
              const color = typeColors[event.type] || '#a78bfa';
              const session = event.session_id ? sessionMap.get(event.session_id) : null;

              let parsedData: Record<string, unknown> | null = null;
              try {
                if (event.data) parsedData = JSON.parse(event.data);
              } catch { /* ignore */ }

              // Build a short summary line
              let summary = '';
              if (parsedData) {
                const fp = parsedData.file_path as string | undefined;
                const cmd = parsedData.command as string | undefined;
                if (fp) summary = fp.split('/').slice(-2).join('/');
                else if (cmd) summary = cleanOutput(cmd).slice(0, 80);
              }

              const routeDecision = parseRouteDecision(event.type, event.data);

              return (
                <div
                  key={event.id}
                  className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.02]"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <Icon className="w-4 h-4 mt-0.5 shrink-0" style={{ color }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                        style={{ background: `${color}15`, color }}
                      >
                        {event.type}
                      </span>
                      {event.tool_name && (
                        <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                          {event.tool_name}
                        </span>
                      )}
                      {routeDecision && (
                        <ModelBadge data={routeDecision} />
                      )}
                      {session && (
                        <button
                          onClick={() => onGoToSession(session.projectId, event.session_id!)}
                          className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors hover:bg-white/10"
                          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                          title={`Go to ${session.projectName}`}
                        >
                          <FolderOpen className="w-2.5 h-2.5" />
                          {session.projectName}
                        </button>
                      )}
                      <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--text-secondary)' }}>
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    {summary && (
                      <p
                        className="text-xs mt-0.5 truncate font-mono"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {summary}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  );
}
