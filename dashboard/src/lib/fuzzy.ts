import Fuse from 'fuse.js';
import type { SkillItem } from '../types/skills';

// ── Synonym map ───────────────────────────────────────────────────
// Maps common prompt words → skill-relevant keywords so "fix bug"
// finds /systematic-debugging even though "fix" isn't in the name.
const SYNONYMS: Record<string, string[]> = {
  debug:       ['debugging', 'troubleshoot', 'fix', 'error', 'bug', 'issue', 'trace', 'diagnose'],
  fix:         ['debug', 'repair', 'patch', 'resolve', 'bug', 'error', 'troubleshoot'],
  test:        ['testing', 'spec', 'unit', 'integration', 'e2e', 'assert', 'verify', 'check'],
  commit:      ['git', 'save', 'push', 'stage', 'changes', 'version'],
  review:      ['pr', 'pull-request', 'code-review', 'feedback', 'inspect'],
  deploy:      ['release', 'ship', 'publish', 'launch', 'ci', 'cd', 'pipeline'],
  build:       ['compile', 'bundle', 'package', 'construct', 'assemble'],
  analyze:     ['analysis', 'inspect', 'examine', 'audit', 'evaluate', 'assess', 'scan'],
  refactor:    ['restructure', 'cleanup', 'improve', 'reorganize', 'simplify'],
  document:    ['docs', 'documentation', 'readme', 'explain', 'describe', 'comment'],
  plan:        ['planning', 'design', 'architect', 'strategy', 'roadmap', 'spec'],
  search:      ['find', 'lookup', 'query', 'grep', 'locate', 'discover'],
  create:      ['new', 'add', 'generate', 'scaffold', 'init', 'make', 'start'],
  delete:      ['remove', 'drop', 'clean', 'purge', 'destroy'],
  update:      ['upgrade', 'modify', 'change', 'edit', 'patch', 'bump'],
  security:    ['vulnerability', 'audit', 'secure', 'auth', 'permission', 'access'],
  performance: ['optimize', 'speed', 'fast', 'slow', 'benchmark', 'profile', 'perf'],
  memory:      ['store', 'recall', 'remember', 'save', 'persist', 'cache'],
  git:         ['branch', 'merge', 'rebase', 'commit', 'push', 'pull', 'stash', 'diff'],
  workflow:    ['automate', 'automation', 'pipeline', 'process', 'ci', 'cd'],
  explain:     ['understand', 'what', 'how', 'why', 'describe', 'clarify'],
  error:       ['bug', 'crash', 'fail', 'broken', 'wrong', 'issue', 'exception'],
  brainstorm:  ['idea', 'ideate', 'think', 'explore', 'creative', 'options'],
  implement:   ['code', 'write', 'develop', 'build', 'create', 'program'],
  estimate:    ['time', 'effort', 'complexity', 'scope', 'size', 'cost'],
  hook:        ['hooks', 'event', 'trigger', 'callback', 'lifecycle'],
  session:     ['save', 'restore', 'state', 'context', 'history'],
  index:       ['codebase', 'map', 'structure', 'overview', 'navigate'],
  research:    ['investigate', 'explore', 'study', 'learn', 'survey', 'deep-dive'],
};

/**
 * Build expanded keywords string for a skill by matching its text
 * against the synonym map. This runs once at index time.
 */
function expandKeywords(skill: SkillItem): string {
  const text = [skill.id, skill.name, skill.category, skill.description || '']
    .join(' ')
    .toLowerCase();
  const extra: Set<string> = new Set();

  for (const [trigger, synonyms] of Object.entries(SYNONYMS)) {
    // If the skill text contains a trigger word, add all its synonyms
    if (text.includes(trigger)) {
      for (const s of synonyms) extra.add(s);
    }
    // If a synonym appears in the skill text, add the trigger and siblings
    for (const s of synonyms) {
      if (text.includes(s)) {
        extra.add(trigger);
        for (const sib of synonyms) extra.add(sib);
        break;
      }
    }
  }

  return Array.from(extra).join(' ');
}

// ── Fuse index (lazy singleton) ───────────────────────────────────
interface IndexedSkill extends SkillItem {
  keywords: string;
}

let cachedFuseSlash: Fuse<IndexedSkill> | null = null;
let cachedFuseContext: Fuse<IndexedSkill> | null = null;
let cachedSkillsRef: SkillItem[] | null = null;
let indexedSkills: IndexedSkill[] = [];

function ensureIndex(skills: SkillItem[]) {
  if (cachedSkillsRef === skills) return;
  cachedSkillsRef = skills;

  indexedSkills = skills.map(s => ({
    ...s,
    keywords: expandKeywords(s),
  }));

  // Slash mode: search name and id with tight threshold
  cachedFuseSlash = new Fuse(indexedSkills, {
    keys: [
      { name: 'id', weight: 0.5 },
      { name: 'name', weight: 0.3 },
      { name: 'command', weight: 0.2 },
    ],
    includeScore: true,
    threshold: 0.35,
    ignoreLocation: true,
    minMatchCharLength: 1,
  });

  // Context mode: search wide with synonym keywords
  cachedFuseContext = new Fuse(indexedSkills, {
    keys: [
      { name: 'name', weight: 0.3 },
      { name: 'keywords', weight: 0.3 },
      { name: 'description', weight: 0.25 },
      { name: 'category', weight: 0.15 },
    ],
    includeScore: true,
    threshold: 0.45,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
}

// ── Usage weighting ───────────────────────────────────────────────
const USAGE_KEY = 'octoally:skill-usage';

interface UsageEntry {
  count: number;
  lastUsed: number;
}

function getUsageData(): Record<string, UsageEntry> {
  try {
    return JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
  } catch { return {}; }
}

export function recordSkillUsage(skillId: string) {
  const data = getUsageData();
  const entry = data[skillId] || { count: 0, lastUsed: 0 };
  entry.count++;
  entry.lastUsed = Date.now();
  data[skillId] = entry;
  localStorage.setItem(USAGE_KEY, JSON.stringify(data));
}

function usageBoost(skillId: string): number {
  const data = getUsageData();
  const entry = data[skillId];
  if (!entry) return 1.0;

  const hoursAgo = (Date.now() - entry.lastUsed) / 3_600_000;
  const recency = Math.max(1.0, 1.3 * Math.exp(-0.1 * hoursAgo));
  const frequency = 1.0 + Math.log10(1 + entry.count) * 0.1;

  return recency * frequency;
}

// ── Intent map types ─────────────────────────────────────────────
export interface IntentEntry {
  command: string;
  name: string;
  category: string;
  description: string;
  intents: string[];
  weight: number;
}

// ── Public API ────────────────────────────────────────────────────

export interface ScoredSkill {
  skill: SkillItem;
  score: number;
  reason?: string;
}

/**
 * Search skills in slash mode (input starts with /).
 * Handles partial words and typos via fuse.js.
 */
export function searchSlash(skills: SkillItem[], query: string, limit: number): ScoredSkill[] {
  if (!query.trim()) return [];
  ensureIndex(skills);
  if (!cachedFuseSlash) return [];

  return cachedFuseSlash.search(query, { limit: limit + 5 })
    .map(r => ({
      skill: r.item as SkillItem,
      score: (1 - (r.score ?? 1)) * usageBoost(r.item.id),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Search skills using the server-provided intent map.
 * Scores each skill by how many of its intent phrases match words in the query.
 * This replaces fuse.js for context mode — intent phrases are curated to
 * capture user intent, not just keywords.
 */
export function searchIntent(
  intentMap: IntentEntry[],
  skills: SkillItem[],
  query: string,
  limit: number,
): ScoredSkill[] {
  if (query.length < 3) return [];

  const q = query.toLowerCase().trim();
  const qWords = q.split(/\s+/).filter(w => w.length > 1);
  if (qWords.length === 0) return [];

  const skillMap = new Map(skills.map(s => [s.command, s]));
  const scored: Array<{ entry: IntentEntry; score: number; matchedIntent: string }> = [];

  for (const entry of intentMap) {
    let bestScore = 0;
    let bestIntent = '';

    for (const intent of entry.intents) {
      let matchScore = 0;

      // Exact substring match of full query in intent (strong signal)
      if (intent.includes(q)) {
        matchScore = 10 + q.length;
      } else if (q.includes(intent)) {
        matchScore = 8 + intent.length;
      } else {
        // Word overlap scoring
        const intentWords = intent.split(/\s+/);
        let wordMatches = 0;
        let partialMatches = 0;
        for (const qw of qWords) {
          for (const iw of intentWords) {
            if (qw === iw) { wordMatches += 2; break; }
            if (iw.startsWith(qw) || qw.startsWith(iw)) { partialMatches += 1; break; }
          }
        }
        matchScore = wordMatches + partialMatches * 0.5;
      }

      if (matchScore > bestScore) {
        bestScore = matchScore;
        bestIntent = intent;
      }
    }

    if (bestScore > 0) {
      scored.push({
        entry,
        score: bestScore * entry.weight * usageBoost(entry.name),
        matchedIntent: bestIntent,
      });
    }
  }

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);

  const results: ScoredSkill[] = [];
  for (const { entry, score, matchedIntent } of scored.slice(0, limit)) {
    const skill = skillMap.get(entry.command);
    if (skill) results.push({ skill, score, reason: matchedIntent });
  }
  return results;
}

/**
 * Search skills in context mode (free-text prompt).
 * Uses synonym-expanded keywords, handles partial last word.
 * @deprecated Use searchIntent() when intent map is available
 */
export function searchContext(skills: SkillItem[], query: string, limit: number): ScoredSkill[] {
  if (query.length < 3) return [];
  ensureIndex(skills);
  if (!cachedFuseContext) return [];

  const results = cachedFuseContext.search(query, { limit: limit + 5 });

  // Dynamic threshold: only show results close to the best match
  if (results.length === 0) return [];
  const bestScore = results[0].score ?? 1;
  const cutoff = Math.min(bestScore + 0.15, 0.5);

  return results
    .filter(r => (r.score ?? 1) <= cutoff)
    .map(r => ({
      skill: r.item as SkillItem,
      score: (1 - (r.score ?? 1)) * usageBoost(r.item.id),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── Legacy exports (keep for CommandPalette/SkillsPanel) ──────────

/**
 * fzf-style fuzzy scoring: rewards consecutive matches, prefix matches,
 * and case-sensitive exact hits. Returns -1 for no match.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return 200 + q.length;
  const subIdx = t.indexOf(q);
  if (subIdx >= 0) return 100 + q.length - subIdx;

  let score = 0;
  let qi = 0;
  let consecutive = 0;
  let prevMatch = false;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      consecutive = prevMatch ? consecutive + 1 : 1;
      score += consecutive * 2 + (ti === 0 ? 5 : 0);
      prevMatch = true;
    } else {
      prevMatch = false;
    }
  }
  return qi === q.length ? score : -1;
}
