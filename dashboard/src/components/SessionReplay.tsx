import { useState, useEffect, useCallback } from 'react';

interface TranscriptEntry {
  seq: number;
  role: string;
  content: string | null;
  tool_name: string | null;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  timestamp: string;
}

interface SessionReplayProps {
  sessionId: string;
  apiBase?: string;
}

const ROLE_COLORS: Record<string, string> = {
  user: '#4CAF50',
  assistant: '#2196F3',
  system: '#9E9E9E',
  tool_use: '#FF9800',
  tool_result: '#FF5722',
};

export default function SessionReplay({ sessionId, apiBase = '' }: SessionReplayProps) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playSpeed, setPlaySpeed] = useState(1000); // ms between steps

  useEffect(() => {
    setLoading(true);
    fetch(`${apiBase}/api/sessions/${sessionId}/replay`)
      .then(res => res.json())
      .then(data => {
        if (data.ok) {
          setEntries(data.entries || []);
        } else {
          setError(data.error || 'Failed to load transcript');
        }
        setLoading(false);
      })
      .catch(err => {
        setError(String(err));
        setLoading(false);
      });
  }, [sessionId, apiBase]);

  // Auto-play timer
  useEffect(() => {
    if (!isPlaying || currentIndex >= entries.length - 1) {
      setIsPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      setCurrentIndex(i => Math.min(i + 1, entries.length - 1));
    }, playSpeed);
    return () => clearTimeout(timer);
  }, [isPlaying, currentIndex, entries.length, playSpeed]);

  const togglePlay = useCallback(() => {
    if (currentIndex >= entries.length - 1) {
      setCurrentIndex(0);
    }
    setIsPlaying(p => !p);
  }, [currentIndex, entries.length]);

  if (loading) return <div style={{ padding: 16 }}>Loading transcript...</div>;
  if (error) return <div style={{ padding: 16, color: '#f44336' }}>Error: {error}</div>;
  if (entries.length === 0) return <div style={{ padding: 16 }}>No transcript entries found.</div>;

  const visibleEntries = entries.slice(0, currentIndex + 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'monospace' }}>
      {/* Controls */}
      <div style={{
        padding: '8px 16px',
        borderBottom: '1px solid #333',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        background: '#1a1a1a',
      }}>
        <button onClick={togglePlay} style={{ padding: '4px 12px', cursor: 'pointer' }}>
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <button
          onClick={() => setCurrentIndex(i => Math.max(0, i - 1))}
          disabled={currentIndex === 0}
          style={{ padding: '4px 8px', cursor: 'pointer' }}
        >
          Prev
        </button>
        <button
          onClick={() => setCurrentIndex(i => Math.min(entries.length - 1, i + 1))}
          disabled={currentIndex >= entries.length - 1}
          style={{ padding: '4px 8px', cursor: 'pointer' }}
        >
          Next
        </button>
        <span style={{ color: '#aaa', fontSize: 12 }}>
          Step {currentIndex + 1} / {entries.length}
        </span>
        <input
          type="range"
          min={0}
          max={entries.length - 1}
          value={currentIndex}
          onChange={e => { setCurrentIndex(Number(e.target.value)); setIsPlaying(false); }}
          style={{ flex: 1 }}
        />
        <select
          value={playSpeed}
          onChange={e => setPlaySpeed(Number(e.target.value))}
          style={{ padding: '2px 4px' }}
        >
          <option value={2000}>0.5x</option>
          <option value={1000}>1x</option>
          <option value={500}>2x</option>
          <option value={200}>5x</option>
        </select>
      </div>

      {/* Transcript */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {visibleEntries.map((entry, i) => (
          <div
            key={entry.seq || i}
            style={{
              marginBottom: 8,
              padding: '8px 12px',
              borderLeft: `3px solid ${ROLE_COLORS[entry.role] || '#666'}`,
              background: i === currentIndex ? '#2a2a2a' : 'transparent',
              borderRadius: 4,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{
                color: ROLE_COLORS[entry.role] || '#666',
                fontWeight: 'bold',
                fontSize: 12,
                textTransform: 'uppercase',
              }}>
                {entry.role}
                {entry.tool_name && ` (${entry.tool_name})`}
              </span>
              <span style={{ color: '#666', fontSize: 11 }}>
                {entry.timestamp}
                {entry.tokens_in || entry.tokens_out ?
                  ` | ${entry.tokens_in || 0} in / ${entry.tokens_out || 0} out` : ''}
                {entry.cost_usd ? ` | $${entry.cost_usd.toFixed(4)}` : ''}
              </span>
            </div>
            <pre style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 13,
              color: '#ddd',
              maxHeight: 300,
              overflow: 'auto',
            }}>
              {typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
