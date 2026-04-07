import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import type { SkillItem } from '../types/skills';

interface CommandPaletteProps {
  projectPath: string;
}

export function CommandPalette({ projectPath }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global Ctrl+K listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
        setQuery('');
        setSelectedIndex(0);
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const [loaded, setLoaded] = useState(false);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      // Fetch skills if not loaded yet
      if (!loaded) {
        fetch(`/api/skills?project_path=${encodeURIComponent(projectPath)}`)
          .then(r => r.json())
          .then(data => {
            setSkills(data.skills || []);
            setLoaded(true);
          })
          .catch(() => {});
      }
    }
  }, [open, projectPath, loaded]);

  // Reset loaded state when project changes
  useEffect(() => { setLoaded(false); }, [projectPath]);

  const filtered = useMemo(() => {
    if (!query.trim()) return skills.slice(0, 20);
    const q = query.toLowerCase();
    return skills
      .filter(s => s.id.toLowerCase().includes(q) || s.category.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q))
      .sort((a, b) => {
        const aPrefix = a.id.toLowerCase().startsWith(q) ? 100 : 0;
        const bPrefix = b.id.toLowerCase().startsWith(q) ? 100 : 0;
        return bPrefix - aPrefix;
      })
      .slice(0, 30);
  }, [skills, query]);

  // Reset selection on filter change
  useEffect(() => setSelectedIndex(0), [filtered]);

  const invoke = useCallback((skill: SkillItem) => {
    window.dispatchEvent(new CustomEvent('octoally:skill-invoke', {
      detail: { command: skill.command },
    }));
    setOpen(false);
  }, []);

  const paletteRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && filtered[selectedIndex]) {
      e.preventDefault();
      invoke(filtered[selectedIndex]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const focusable = paletteRef.current?.querySelectorAll<HTMLElement>(
        'input, button:not([disabled])'
      );
      if (focusable && focusable.length > 0) {
        const currentIdx = Array.from(focusable).indexOf(
          document.activeElement as HTMLElement
        );
        const nextIdx = e.shiftKey
          ? (currentIdx - 1 + focusable.length) % focusable.length
          : (currentIdx + 1) % focusable.length;
        focusable[nextIdx].focus();
      }
    }
  }, [filtered, selectedIndex, invoke]);

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-label="Command palette"
      className="fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      {/* Backdrop */}
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.5)' }} />

      {/* Palette */}
      <div
        ref={paletteRef}
        className="relative w-full max-w-lg rounded-xl shadow-2xl overflow-hidden"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <Search className="w-4 h-4 shrink-0" style={{ color: 'var(--text-tertiary)' }} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search skills..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Search skills"
            className="flex-1 text-sm bg-transparent outline-none"
            style={{ color: 'var(--text-primary)' }}
          />
          <kbd
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', border: '1px solid var(--border)' }}
          >
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div role="listbox" className="max-h-[320px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
              No skills found
            </div>
          ) : (
            filtered.map((skill, i) => (
              <button
                key={skill.id}
                role="option"
                aria-selected={i === selectedIndex}
                onClick={() => invoke(skill)}
                className="w-full flex items-center gap-3 px-4 py-2 text-left transition-colors"
                style={{
                  background: i === selectedIndex ? 'var(--bg-tertiary)' : 'transparent',
                }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  {skill.command}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  {skill.category}
                </span>
                {skill.description && (
                  <span className="text-[11px] ml-auto truncate max-w-[200px]" style={{ color: 'var(--text-tertiary)' }}>
                    {skill.description}
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center gap-4 px-4 py-2 text-[10px]"
          style={{ borderTop: '1px solid var(--border)', color: 'var(--text-tertiary)' }}
        >
          <span><kbd className="font-mono">Enter</kbd> to run</span>
          <span><kbd className="font-mono">&uarr;&darr;</kbd> to navigate</span>
          <span><kbd className="font-mono">Esc</kbd> to close</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
