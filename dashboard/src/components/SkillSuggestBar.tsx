import { useState, useEffect, useCallback, useMemo } from 'react';
import { Zap, ChevronUp, X } from 'lucide-react';
import { api } from '../lib/api';
import { searchSlash, searchIntent, recordSkillUsage } from '../lib/fuzzy';
import type { IntentEntry } from '../lib/fuzzy';
import type { SkillItem } from '../types/skills';

interface SkillSuggestBarProps {
  projectPath: string;
  projectId?: string;
}

export function SkillSuggestBar({ projectPath }: SkillSuggestBarProps) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [intentMap, setIntentMap] = useState<IntentEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [inputBuffer, setInputBuffer] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Track recently clicked skills to boost related suggestions
  const [clickedSkillIds, setClickedSkillIds] = useState<string[]>([]);

  // Load skills + intent map once
  useEffect(() => {
    if (loaded) return;
    Promise.all([
      api.skills.list(projectPath),
      api.skills.intents(projectPath),
    ])
      .then(([skillsData, intentsData]) => {
        setSkills(skillsData.skills);
        setIntentMap(intentsData.intents);
        setLoaded(true);
      })
      .catch(() => {});
  }, [projectPath, loaded]);

  useEffect(() => { setLoaded(false); }, [projectPath]);

  // Listen for terminal input buffer events
  useEffect(() => {
    const handler = (e: Event) => {
      const buf = (e as CustomEvent).detail?.buffer;
      if (typeof buf === 'string') {
        setInputBuffer(buf);
        setSelectedIndex(0);
        if (buf.length <= 1) {
          setDismissed(false);
          setClickedSkillIds([]);
        }
      }
    };
    window.addEventListener('octoally:input-buffer', handler);
    return () => window.removeEventListener('octoally:input-buffer', handler);
  }, []);

  const isSlashMode = inputBuffer.startsWith('/');
  const slashQuery = isSlashMode ? inputBuffer.slice(1) : '';
  // Always show more when skills have been clicked (user is exploring)
  const limit = expanded ? 20 : clickedSkillIds.length > 0 ? 8 : 5;

  // Build a set of categories/intents from clicked skills to boost related ones
  const clickBoostContext = useMemo(() => {
    if (clickedSkillIds.length === 0) return null;
    const categories = new Set<string>();
    const intentWords = new Set<string>();
    for (const id of clickedSkillIds) {
      const entry = intentMap.find(e => e.command === `/${id}` || e.name === id);
      if (entry) {
        categories.add(entry.category);
        for (const intent of entry.intents) {
          for (const w of intent.split(/\s+/)) {
            if (w.length > 2) intentWords.add(w);
          }
        }
      }
    }
    return { categories, intentWords };
  }, [clickedSkillIds, intentMap]);

  // Intent map results (instant, client-side)
  const suggestions = useMemo(() => {
    if (dismissed || skills.length === 0) return [];

    if (isSlashMode && slashQuery.length > 0) {
      return searchSlash(skills, slashQuery, limit).map(r => ({
        skill: r.skill,
        reason: r.skill.description || '',
        clicked: clickedSkillIds.includes(r.skill.id),
      }));
    }

    if (!isSlashMode && inputBuffer.length >= 3 && intentMap.length > 0) {
      let results = searchIntent(intentMap, skills, inputBuffer, limit + 5);

      // Boost related skills when user has clicked some
      if (clickBoostContext && results.length > 0) {
        results = results.map(r => {
          const entry = intentMap.find(e => e.command === r.skill.command);
          if (!entry) return r;

          let boost = 1.0;
          // Same category as clicked skill → boost
          if (clickBoostContext.categories.has(entry.category)) boost += 0.5;
          // Shared intent words → boost
          let sharedWords = 0;
          for (const intent of entry.intents) {
            for (const w of intent.split(/\s+/)) {
              if (clickBoostContext.intentWords.has(w)) sharedWords++;
            }
          }
          boost += Math.min(sharedWords * 0.1, 0.8);

          return { ...r, score: r.score * boost };
        });
        results.sort((a, b) => b.score - a.score);
      }

      // Filter out already-clicked skills (they're already in the prompt)
      const alreadyClicked = new Set(clickedSkillIds);
      return results
        .filter(r => !alreadyClicked.has(r.skill.id))
        .slice(0, limit)
        .map(r => ({
          skill: r.skill,
          reason: r.reason || r.skill.description || '',
          clicked: false,
        }));
    }

    return [];
  }, [skills, intentMap, isSlashMode, slashQuery, inputBuffer, limit, dismissed, clickedSkillIds, clickBoostContext]);

  useEffect(() => { setSelectedIndex(0); }, [suggestions.length]);

  const invoke = useCallback((skill: SkillItem) => {
    recordSkillUsage(skill.id);
    const prefix = inputBuffer.length > 0 && !inputBuffer.endsWith(' ') ? ' ' : '';
    window.dispatchEvent(new CustomEvent('octoally:skill-invoke', {
      detail: { command: prefix + skill.command + ' ', execute: false },
    }));
    // Don't dismiss — keep suggestions visible, track what was clicked
    setClickedSkillIds(prev => prev.includes(skill.id) ? prev : [...prev, skill.id]);
    setSelectedIndex(0);
  }, [inputBuffer]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (suggestions.length === 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && suggestions[selectedIndex]) {
      e.preventDefault();
      invoke(suggestions[selectedIndex].skill);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setExpanded(false);
      setDismissed(true);
      setClickedSkillIds([]);
    }
  }, [suggestions, selectedIndex, invoke]);

  const showSuggestions = suggestions.length > 0;
  const sourceLabel = isSlashMode ? 'command' : clickedSkillIds.length > 0 ? 'related' : 'intent';

  return (
    <div
      className="shrink-0"
      style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
      onKeyDown={handleKeyDown}
    >
      {/* Expanded popover */}
      {expanded && showSuggestions && (
        <div
          className="px-2 py-1 space-y-0 max-h-[180px] overflow-y-auto"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          {suggestions.slice(5).map(({ skill, reason }, i) => (
            <button
              key={skill.id}
              onClick={() => invoke(skill)}
              className="w-full flex items-center gap-1.5 px-1.5 py-0.5 rounded text-left transition-colors"
              style={{
                minHeight: 24,
                background: (i + 5) === selectedIndex ? 'var(--bg-tertiary)' : 'transparent',
              }}
              onMouseEnter={() => setSelectedIndex(i + 5)}
            >
              <span className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {skill.command}
              </span>
              <span className="text-[9px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                {reason}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Main bar */}
      <div className="flex items-center gap-1 px-2" style={{ height: 28 }}>
        <Zap
          className="w-3 h-3 shrink-0"
          style={{ color: showSuggestions ? 'var(--accent)' : 'var(--text-tertiary)' }}
        />

        {showSuggestions ? (
          <>
            <span
              className="shrink-0 text-[8px] px-1 py-0 rounded font-medium uppercase leading-none"
              style={{
                background: sourceLabel === 'related' ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: sourceLabel === 'related' ? 'white' : 'var(--text-secondary)',
                border: sourceLabel === 'related' ? 'none' : '1px solid var(--border)',
              }}
            >
              {sourceLabel}
            </span>

            <div className="flex items-center gap-1 flex-1 overflow-x-auto" role="listbox">
              {suggestions.slice(0, 5).map(({ skill, reason }, i) => (
                <button
                  key={skill.id}
                  role="option"
                  aria-selected={i === selectedIndex}
                  onClick={() => invoke(skill)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className="shrink-0 flex items-center gap-1 px-2 py-0 rounded-full text-[11px] font-medium transition-colors whitespace-nowrap"
                  style={{
                    minHeight: 20,
                    lineHeight: '20px',
                    background: i === selectedIndex ? 'var(--accent)' : 'var(--bg-tertiary)',
                    color: i === selectedIndex ? 'white' : 'var(--text-primary)',
                    border: `1px solid ${i === selectedIndex ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                  title={reason || skill.description || skill.id}
                >
                  {skill.command}
                </button>
              ))}
            </div>

            {suggestions.length > 5 && (
              <button
                onClick={() => setExpanded(prev => !prev)}
                className="shrink-0 p-0.5 rounded transition-colors"
                style={{ color: 'var(--text-tertiary)' }}
                title={`${suggestions.length - 5} more`}
              >
                <ChevronUp
                  className="w-3 h-3 transition-transform"
                  style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                />
              </button>
            )}

            <button
              onClick={() => { setDismissed(true); setExpanded(false); setClickedSkillIds([]); }}
              className="shrink-0 p-0.5 rounded transition-colors"
              style={{ color: 'var(--text-tertiary)' }}
              aria-label="Dismiss suggestions"
            >
              <X className="w-3 h-3" />
            </button>
          </>
        ) : (
          <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            {dismissed
              ? 'Suggestions dismissed'
              : isSlashMode && slashQuery.length > 0
                ? `No skills match "/${slashQuery}"`
                : 'Skills suggested as you type'}
          </span>
        )}

        {showSuggestions && (
          <span className="shrink-0 text-[9px] ml-0.5" style={{ color: 'var(--text-tertiary)' }}>
            {clickedSkillIds.length > 0 ? `${clickedSkillIds.length} added` : 'click to add'}
          </span>
        )}
      </div>
    </div>
  );
}
