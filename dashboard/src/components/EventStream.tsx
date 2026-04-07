import { useState, useEffect, useRef } from 'react';
import { useStreamStore } from '../lib/websocket';
import { api } from '../lib/api';
import type { Event } from '../lib/api';
import { Radio, Terminal, FileEdit, Zap, AlertCircle } from 'lucide-react';
import { ModelBadge, parseRouteDecision } from './ModelBadge';

function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[PX^_].*?\x1b\\|\x1b.|\r/g;
  return text.replace(ansiRegex, '');
}

function cleanTerminalOutput(text: string): string {
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
  session_reconnect: Radio,
  session_resume: Radio,
  session_adopt: Radio,
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
  session_reconnect: '#f59e0b',
  session_resume: '#22d3ee',
  session_adopt: '#c084fc',
  pty_output: '#34d399',
  route_decision: '#94a3b8',
};

interface EventStreamProps {
  sessionId?: string;
  sessionIds?: string[];
}

export function EventStream({ sessionId, sessionIds }: EventStreamProps = {}) {
  const liveEvents = useStreamStore((s) => s.events);
  const connected = useStreamStore((s) => s.connected);
  const [historicalEvents, setHistoricalEvents] = useState<Event[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const filterIds = sessionIds || (sessionId ? [sessionId] : null);

  // Fetch historical events from REST API on mount
  useEffect(() => {
    if (!filterIds || filterIds.length === 0) return;

    let cancelled = false;
    async function fetchHistory() {
      try {
        const allEvents: Event[] = [];
        for (const sid of filterIds!) {
          const data = await api.events.list({ session_id: sid, limit: 100 });
          if (!cancelled) allEvents.push(...data.events);
        }
        if (!cancelled) {
          const map = new Map<number, Event>();
          for (const e of allEvents) map.set(e.id, e);
          setHistoricalEvents(Array.from(map.values()).sort((a, b) => b.id - a.id));
        }
      } catch {
        // Non-critical
      }
    }

    fetchHistory();
    return () => { cancelled = true; };
  }, [filterIds?.join(',')]);

  // Merge historical + live events, deduplicate by id
  const filteredLive = filterIds
    ? liveEvents.filter((e) => e.session_id && filterIds.includes(e.session_id))
    : liveEvents;

  const merged = new Map<number, Event>();
  for (const e of historicalEvents) merged.set(e.id, e);
  for (const e of filteredLive) if (e.id) merged.set(e.id, e);
  const events = Array.from(merged.values()).sort((a, b) => a.id - b.id);

  // Auto-scroll on new events
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  return (
    <div className="h-full flex flex-col">
      <div
        className="flex items-center justify-between px-4 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Event Stream
        </h2>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div
              className="w-2 h-2 rounded-full"
              style={{ background: connected ? '#34d399' : '#f87171' }}
            />
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {connected ? 'Live' : 'Offline'}
            </span>
          </div>
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {events.length} events
          </span>
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto"
        style={{ background: 'var(--bg-primary)' }}
      >
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center" style={{ color: 'var(--text-secondary)' }}>
              <Radio className="w-6 h-6 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No events yet</p>
              <p className="text-xs mt-1">Session lifecycle events will appear here</p>
            </div>
          </div>
        ) : (
          <div>
            {events.map((event) => {
              const Icon = typeIcons[event.type] || Zap;
              const color = typeColors[event.type] || '#a78bfa';
              let parsedData: Record<string, unknown> | null = null;
              try {
                if (event.data) parsedData = JSON.parse(event.data);
              } catch { /* ignore */ }

              let summary = '';
              if (parsedData) {
                const fp = parsedData.file_path as string | undefined;
                const cmd = parsedData.command as string | undefined;
                const task = parsedData.task as string | undefined;
                if (fp) summary = fp.split('/').slice(-2).join('/');
                else if (cmd) summary = cleanTerminalOutput(cmd).slice(0, 80);
                else if (task) summary = task;
              }

              const routeDecision = parseRouteDecision(event.type, event.data);

              return (
                <div
                  key={event.id}
                  className="flex items-start gap-3 px-4 py-2 border-b"
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
                      <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--text-secondary)' }}>
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    {summary && (
                      <p className="text-xs mt-0.5 truncate font-mono" style={{ color: 'var(--text-secondary)' }}>
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
