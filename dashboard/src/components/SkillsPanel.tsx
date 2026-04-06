import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Search, X, Star, ChevronRight, ChevronDown, Circle,
  ToggleLeft, ToggleRight, RefreshCw,
} from 'lucide-react';
import { api } from '../lib/api';
import type { SkillItem, SystemFeature, Integration } from '../types/skills';

type Tab = 'skills' | 'system' | 'integrations';

// --- Storage helpers ---

const STORAGE_PREFIX = 'octoally-skills-';

function loadPins(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${projectId}-pins`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function savePins(projectId: string, pins: string[]) {
  localStorage.setItem(`${STORAGE_PREFIX}${projectId}-pins`, JSON.stringify(pins));
}

function loadRecent(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${projectId}-recent`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveRecent(projectId: string, recent: string[]) {
  localStorage.setItem(`${STORAGE_PREFIX}${projectId}-recent`, JSON.stringify(recent.slice(0, 10)));
}

function loadFrequency(projectId: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${projectId}-freq`);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveFrequency(projectId: string, freq: Record<string, number>) {
  localStorage.setItem(`${STORAGE_PREFIX}${projectId}-freq`, JSON.stringify(freq));
}

// --- Category color ---

const CATEGORY_COLORS = [
  '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e',
  '#06b6d4', '#f97316', '#6366f1', '#14b8a6', '#e11d48',
  '#a855f7', '#84cc16',
];

function categoryColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return CATEGORY_COLORS[Math.abs(hash) % CATEGORY_COLORS.length];
}

// --- Fuzzy score ---

function scoreSkill(skill: SkillItem, query: string, freq: Record<string, number>, recent: string[]): number {
  const q = query.toLowerCase();
  const name = skill.id.toLowerCase();
  let score = 0;
  if (name.startsWith(q)) score += 100;
  else if (name.includes(q)) score += 50;
  else if (skill.category.toLowerCase().includes(q)) score += 25;
  else if (skill.description?.toLowerCase().includes(q)) score += 10;
  else return -1; // no match
  score += (freq[skill.id] || 0) * 2;
  if (recent.includes(skill.id)) score += 10;
  return score;
}

// --- Component ---

interface SkillsPanelProps {
  projectId: string;
  projectPath: string;
}

export function SkillsPanel({ projectId, projectPath }: SkillsPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('skills');
  const [searchQuery, setSearchQuery] = useState('');
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [features, setFeatures] = useState<SystemFeature[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const [expandedFeature, setExpandedFeature] = useState<string | null>(null);
  const [pins, setPins] = useState<string[]>(() => loadPins(projectId));
  const [recent, setRecent] = useState<string[]>(() => loadRecent(projectId));
  const [freq, setFreq] = useState<Record<string, number>>(() => loadFrequency(projectId));
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; skillId: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Reload personalization on project switch
  useEffect(() => {
    setPins(loadPins(projectId));
    setRecent(loadRecent(projectId));
    setFreq(loadFrequency(projectId));
  }, [projectId]);

  // Fetch skills
  useEffect(() => {
    setLoading(true);
    api.skills.list(projectPath)
      .then(data => {
        setSkills(data.skills);
        setCategories(data.categories);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [projectPath]);

  // Fetch system status
  useEffect(() => {
    api.skills.systemStatus()
      .then(data => {
        setFeatures(data.features);
        setIntegrations(data.integrations);
      })
      .catch(() => {});
  }, []);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu]);

  // Keyboard: / to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const toggleCategory = useCallback((cat: string) => {
    setExpandedCats(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }, []);

  const invokeSkill = useCallback((skill: SkillItem) => {
    // Send to active terminal via OctoAlly's terminal write mechanism
    // We dispatch a custom event that Terminal.tsx can listen for
    window.dispatchEvent(new CustomEvent('octoally:skill-invoke', {
      detail: { command: skill.command },
    }));

    // Update recent
    setRecent(prev => {
      const next = [skill.id, ...prev.filter(id => id !== skill.id)].slice(0, 10);
      saveRecent(projectId, next);
      return next;
    });

    // Update frequency
    setFreq(prev => {
      const next = { ...prev, [skill.id]: (prev[skill.id] || 0) + 1 };
      saveFrequency(projectId, next);
      return next;
    });
  }, [projectId]);

  const togglePin = useCallback((skillId: string) => {
    setPins(prev => {
      const next = prev.includes(skillId)
        ? prev.filter(id => id !== skillId)
        : [...prev, skillId];
      savePins(projectId, next);
      return next;
    });
    setContextMenu(null);
  }, [projectId]);

  // Filtered/scored skills for search
  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return null;
    return skills
      .map(s => ({ skill: s, score: scoreSkill(s, searchQuery.trim(), freq, recent) }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map(({ skill }) => skill);
  }, [skills, searchQuery, freq, recent]);

  // Grouped skills by category
  const grouped = useMemo(() => {
    const map = new Map<string, SkillItem[]>();
    for (const s of skills) {
      if (!map.has(s.category)) map.set(s.category, []);
      map.get(s.category)!.push(s);
    }
    return map;
  }, [skills]);

  const pinnedSkills = useMemo(
    () => pins.map(id => skills.find(s => s.id === id)).filter(Boolean) as SkillItem[],
    [pins, skills]
  );

  const recentSkills = useMemo(
    () => recent.map(id => skills.find(s => s.id === id)).filter(Boolean).slice(0, 5) as SkillItem[],
    [recent, skills]
  );

  const statusColor = (status: string) => {
    if (status === 'ok') return '#22c55e';
    if (status === 'error') return '#ef4444';
    if (status === 'degraded') return '#f59e0b';
    return 'var(--text-tertiary)';
  };

  const renderSkillRow = (skill: SkillItem, showCategory = false) => (
    <button
      key={skill.id}
      onClick={() => invokeSkill(skill)}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, skillId: skill.id });
      }}
      className="w-full flex items-center gap-2 px-3 py-2.5 text-left rounded-md transition-colors group"
      style={{ minHeight: 44 }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {pins.includes(skill.id) ? (
        <Star className="w-3.5 h-3.5 shrink-0" style={{ color: '#f59e0b', fill: '#f59e0b' }} />
      ) : (
        <Circle className="w-2 h-2 shrink-0" style={{ color: categoryColor(skill.category), fill: categoryColor(skill.category) }} />
      )}
      <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
        {skill.command}
      </span>
      {showCategory && (
        <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--text-tertiary)' }}>
          {skill.category}
        </span>
      )}
      {skill.scope === 'project' && (
        <span
          className="text-[9px] px-1 py-0.5 rounded shrink-0"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
        >
          project
        </span>
      )}
    </button>
  );

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Search */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--text-tertiary)' }} />
          <input
            ref={searchRef}
            type="text"
            placeholder="Search skills... (press /)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search skills"
            className="w-full pl-8 pr-8 py-1.5 rounded-md text-sm focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div role="tablist" className="flex gap-0.5 px-3 pb-2" style={{ borderBottom: '1px solid var(--border)' }}>
        {(['skills', 'system', 'integrations'] as Tab[]).map(tab => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => { setActiveTab(tab); setSearchQuery(''); }}
            className="px-3 py-1 rounded-md text-xs font-medium transition-colors capitalize"
            style={{
              background: activeTab === tab ? 'var(--bg-tertiary)' : 'transparent',
              color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            {tab}
          </button>
        ))}
        <span className="ml-auto text-[10px] self-center" style={{ color: 'var(--text-tertiary)' }}>
          {skills.length} skills
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {loading ? (
          <div className="flex items-center justify-center h-32" style={{ color: 'var(--text-tertiary)' }}>
            <RefreshCw className="w-4 h-4 animate-spin mr-2" />
            <span className="text-sm">Loading skills...</span>
          </div>
        ) : activeTab === 'skills' ? (
          <>
            {/* Search results mode */}
            {filteredSkills ? (
              <div className="py-1">
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-tertiary)' }}>
                  Results ({filteredSkills.length})
                </div>
                {filteredSkills.length === 0 ? (
                  <div className="px-3 py-4 text-sm italic" style={{ color: 'var(--text-tertiary)' }}>
                    No skills match "{searchQuery}"
                  </div>
                ) : (
                  filteredSkills.map(s => renderSkillRow(s, true))
                )}
              </div>
            ) : (
              <>
                {/* Pinned */}
                <div className="py-1">
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-tertiary)' }}>
                    Pinned ({pinnedSkills.length})
                  </div>
                  {pinnedSkills.length === 0 ? (
                    <div className="px-3 py-2 text-xs italic" style={{ color: 'var(--text-tertiary)' }}>
                      Right-click any skill to pin it here
                    </div>
                  ) : (
                    pinnedSkills.map(s => renderSkillRow(s))
                  )}
                </div>

                {/* Recent */}
                {recentSkills.length > 0 && (
                  <div className="py-1">
                    <div className="px-3 py-1 text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-tertiary)' }}>
                      Recent ({recentSkills.length})
                    </div>
                    {recentSkills.map(s => renderSkillRow(s))}
                  </div>
                )}

                {/* Categories */}
                {categories.map(cat => {
                  const items = grouped.get(cat) || [];
                  const isExpanded = expandedCats.has(cat);
                  return (
                    <div key={cat} className="py-0.5" style={{ contentVisibility: 'auto' }}>
                      <button
                        onClick={() => toggleCategory(cat)}
                        aria-expanded={isExpanded}
                        className="w-full flex items-center gap-1.5 px-3 py-2 text-left"
                        style={{ minHeight: 44 }}
                      >
                        {isExpanded
                          ? <ChevronDown className="w-3 h-3 shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                          : <ChevronRight className="w-3 h-3 shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                        }
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: categoryColor(cat) }}
                        />
                        <span className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-tertiary)' }}>
                          {cat}
                        </span>
                        <span className="text-[10px] ml-1" style={{ color: 'var(--text-tertiary)' }}>
                          ({items.length})
                        </span>
                      </button>
                      {isExpanded && items.map(s => renderSkillRow(s))}
                    </div>
                  );
                })}
              </>
            )}
          </>
        ) : activeTab === 'system' ? (
          <div className="py-1 space-y-1">
            {features.length === 0 ? (
              <div className="px-3 py-4 text-sm italic" style={{ color: 'var(--text-tertiary)' }}>
                No system features detected
              </div>
            ) : (
              features.map(feat => (
                <div key={feat.id} className="mx-2 rounded-lg" style={{ border: '1px solid var(--border)' }}>
                  <button
                    onClick={() => setExpandedFeature(expandedFeature === feat.id ? null : feat.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5"
                    style={{
                      borderLeft: `2px solid ${statusColor(feat.status)}`,
                      borderRadius: 'inherit',
                    }}
                  >
                    <Circle
                      className="w-3 h-3 shrink-0"
                      style={{ color: statusColor(feat.status), fill: statusColor(feat.status) }}
                    />
                    <div className="flex-1 text-left">
                      <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{feat.name}</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{feat.description}</div>
                    </div>
                    {feat.enabled ? (
                      <ToggleRight className="w-5 h-5 shrink-0" style={{ color: '#22c55e' }} />
                    ) : (
                      <ToggleLeft className="w-5 h-5 shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                    )}
                  </button>
                  {expandedFeature === feat.id && feat.details && (
                    <div className="px-3 pb-2 pt-1 text-[11px] space-y-0.5" style={{ color: 'var(--text-secondary)', borderTop: '1px solid var(--border)' }}>
                      {Object.entries(feat.details).map(([k, v]) => (
                        <div key={k}><span className="font-medium">{k}:</span> {v}</div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        ) : (
          /* Integrations tab */
          <div className="py-1 space-y-1">
            {integrations.length === 0 ? (
              <div className="px-3 py-4 text-sm italic" style={{ color: 'var(--text-tertiary)' }}>
                No integrations configured
              </div>
            ) : (
              integrations.map(intg => (
                <div
                  key={intg.id}
                  className="mx-2 flex items-center gap-3 px-3 py-2.5 rounded-lg"
                  style={{
                    border: '1px solid var(--border)',
                    borderLeft: `2px solid ${statusColor(intg.status)}`,
                  }}
                >
                  <Circle
                    className="w-3 h-3 shrink-0"
                    style={{ color: statusColor(intg.status), fill: intg.connected ? statusColor(intg.status) : 'transparent' }}
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{intg.name}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                      {intg.connected ? 'Connected' : 'Disconnected'}
                    </div>
                  </div>
                  <span
                    className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                    style={{
                      background: intg.connected ? '#16a34a22' : '#dc262622',
                      color: intg.connected ? '#22c55e' : '#ef4444',
                    }}
                  >
                    {intg.status}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          role="menu"
          className="fixed z-50 rounded-lg shadow-lg py-1 min-w-[160px]"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
          }}
        >
          <button
            role="menuitem"
            onClick={() => togglePin(contextMenu.skillId)}
            className="w-full text-left px-3 py-1.5 text-xs font-medium transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            {pins.includes(contextMenu.skillId) ? 'Unpin' : 'Pin to top'}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const skill = skills.find(s => s.id === contextMenu.skillId);
              if (skill) navigator.clipboard.writeText(skill.command);
              setContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 text-xs font-medium transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            Copy command
          </button>
        </div>
      )}
    </div>
  );
}
