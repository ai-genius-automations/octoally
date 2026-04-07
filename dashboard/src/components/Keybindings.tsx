import { useState, useEffect, useCallback } from 'react';

export interface Keybinding {
  id: string;
  label: string;
  keys: string;  // e.g., "Ctrl+S", "Ctrl+Shift+P"
  action: string;
  category: string;
  enabled: boolean;
}

const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { id: 'kb-new-session', label: 'New Session', keys: 'Ctrl+N', action: 'new_session', category: 'session', enabled: true },
  { id: 'kb-close-session', label: 'Close Session', keys: 'Ctrl+W', action: 'close_session', category: 'session', enabled: true },
  { id: 'kb-command-palette', label: 'Command Palette', keys: 'Ctrl+Shift+P', action: 'command_palette', category: 'navigation', enabled: true },
  { id: 'kb-toggle-sidebar', label: 'Toggle Sidebar', keys: 'Ctrl+B', action: 'toggle_sidebar', category: 'ui', enabled: true },
  { id: 'kb-focus-input', label: 'Focus Input', keys: 'Ctrl+L', action: 'focus_input', category: 'navigation', enabled: true },
];

interface KeybindingsProps {
  onAction?: (action: string) => void;
  customBindings?: Keybinding[];
}

function parseKeys(keys: string): { ctrl: boolean; shift: boolean; alt: boolean; key: string } {
  const parts = keys.split('+').map(p => p.trim().toLowerCase());
  return {
    ctrl: parts.includes('ctrl') || parts.includes('cmd'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    key: parts.filter(p => !['ctrl', 'cmd', 'shift', 'alt'].includes(p))[0] || '',
  };
}

function matchesEvent(binding: Keybinding, e: KeyboardEvent): boolean {
  const parsed = parseKeys(binding.keys);
  return (
    binding.enabled &&
    e.ctrlKey === parsed.ctrl &&
    e.shiftKey === parsed.shift &&
    e.altKey === parsed.alt &&
    e.key.toLowerCase() === parsed.key
  );
}

function detectConflicts(bindings: Keybinding[]): Map<string, string[]> {
  const conflicts = new Map<string, string[]>();
  const keyMap = new Map<string, string[]>();

  for (const b of bindings) {
    if (!b.enabled) continue;
    const normalized = b.keys.toLowerCase().split('+').sort().join('+');
    const existing = keyMap.get(normalized) || [];
    existing.push(b.label);
    keyMap.set(normalized, existing);
  }

  for (const [keys, labels] of keyMap) {
    if (labels.length > 1) {
      conflicts.set(keys, labels);
    }
  }

  return conflicts;
}

export default function Keybindings({ onAction, customBindings }: KeybindingsProps) {
  const [bindings, setBindings] = useState<Keybinding[]>(customBindings || DEFAULT_KEYBINDINGS);
  const [editing, setEditing] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Map<string, string[]>>(new Map());

  useEffect(() => {
    setConflicts(detectConflicts(bindings));
  }, [bindings]);

  // Global keydown listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      for (const binding of bindings) {
        if (matchesEvent(binding, e)) {
          e.preventDefault();
          onAction?.(binding.action);
          return;
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [bindings, onAction]);

  const toggleBinding = useCallback((id: string) => {
    setBindings(prev => prev.map(b =>
      b.id === id ? { ...b, enabled: !b.enabled } : b
    ));
  }, []);

  const updateKeys = useCallback((id: string, newKeys: string) => {
    setBindings(prev => prev.map(b =>
      b.id === id ? { ...b, keys: newKeys } : b
    ));
    setEditing(null);
  }, []);

  const categories = [...new Set(bindings.map(b => b.category))];

  return (
    <div style={{ padding: 16, fontFamily: 'monospace', color: '#ddd' }}>
      <h3 style={{ margin: '0 0 12px' }}>Keyboard Shortcuts</h3>

      {conflicts.size > 0 && (
        <div style={{ background: '#442200', padding: 8, borderRadius: 4, marginBottom: 12, fontSize: 12 }}>
          Conflicts detected: {[...conflicts.entries()].map(([k, labels]) =>
            `${k} (${labels.join(', ')})`
          ).join('; ')}
        </div>
      )}

      {categories.map(cat => (
        <div key={cat} style={{ marginBottom: 16 }}>
          <h4 style={{ color: '#888', textTransform: 'uppercase', fontSize: 11, margin: '0 0 8px' }}>{cat}</h4>
          {bindings.filter(b => b.category === cat).map(binding => (
            <div
              key={binding.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 8px',
                borderBottom: '1px solid #333',
                opacity: binding.enabled ? 1 : 0.5,
              }}
            >
              <span style={{ flex: 1 }}>{binding.label}</span>
              {editing === binding.id ? (
                <input
                  autoFocus
                  style={{ width: 120, background: '#333', color: '#fff', border: '1px solid #555', padding: '2px 6px' }}
                  defaultValue={binding.keys}
                  onBlur={e => updateKeys(binding.id, e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') updateKeys(binding.id, (e.target as HTMLInputElement).value); }}
                />
              ) : (
                <code
                  onClick={() => setEditing(binding.id)}
                  style={{ cursor: 'pointer', background: '#333', padding: '2px 8px', borderRadius: 3, fontSize: 12 }}
                >
                  {binding.keys}
                </code>
              )}
              <button
                onClick={() => toggleBinding(binding.id)}
                style={{ marginLeft: 8, cursor: 'pointer', background: 'none', border: 'none', color: binding.enabled ? '#4CAF50' : '#666', fontSize: 14 }}
              >
                {binding.enabled ? 'ON' : 'OFF'}
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export { DEFAULT_KEYBINDINGS, detectConflicts, parseKeys };
