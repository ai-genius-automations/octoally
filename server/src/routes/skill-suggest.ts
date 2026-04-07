import type { FastifyPluginAsync } from 'fastify';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { existsSync, statSync } from 'fs';
import { scanSkillsDir, type SkillItem } from './skills.js';

// ── Intent map ───────────────────────────────────────────────────
// Pre-computed mapping from user intent phrases to skill commands.
// This gives AI-quality suggestions without per-request LLM calls.
// The map is built from skill metadata + curated intent keywords.

interface IntentEntry {
  command: string;
  name: string;
  category: string;
  description: string;
  // Intent keywords: things a user might type when they need this skill
  intents: string[];
  // Weight for ranking (higher = more likely to suggest)
  weight: number;
}

/**
 * Build a rich intent map from skills. Each skill gets intent keywords
 * derived from its metadata plus curated semantic expansions.
 */
function buildIntentMap(skills: SkillItem[]): IntentEntry[] {
  // Curated intent expansions per skill ID pattern
  const INTENT_EXPANSIONS: Record<string, string[]> = {
    // General skills
    'commit': ['save changes', 'git commit', 'push code', 'stage', 'done coding', 'finished', 'save work'],
    'create-pr': ['pull request', 'open pr', 'submit changes', 'merge request', 'code review ready'],
    'pr-review': ['review code', 'check pr', 'review pull request', 'code feedback', 'approve changes'],
    'deep-analyze': ['analyze', 'investigate', 'multiple angles', 'board meeting', 'multi perspective', 'evaluate options'],
    'fix-github-issue': ['github issue', 'fix issue', 'close issue', 'bug report', 'issue tracker'],
    'index': ['codebase overview', 'project structure', 'file map', 'what files', 'navigate code'],
    'codebase-map': ['architecture', 'dependencies', 'data flow', 'how does it work', 'system diagram'],
    'reflect': ['what went well', 'session review', 'retrospective', 'what did we do'],
    'save-session': ['save progress', 'handoff', 'continue later', 'session notes', 'bookmark'],
    'release': ['version bump', 'changelog', 'ship release', 'new version', 'publish'],
    'create-hook': ['lifecycle hook', 'event handler', 'automation trigger', 'on save', 'on commit'],
    'todo': ['task list', 'what to do', 'remaining work', 'checklist', 'plan tasks'],
    'act': ['tdd', 'red green refactor', 'test driven', 'write tests first'],
    'ruflo-search': ['search memory', 'find in memory', 'recall', 'what did we decide', 'previous work'],
    'evaluate-repository': ['audit repo', 'security scan', 'code quality', 'repo health'],

    // SC skills
    'sc:troubleshoot': ['fix bug', 'debug', 'broken', 'not working', 'error', 'crash', 'fails', 'wrong output',
      'investigate issue', 'diagnose', 'trace error', 'stack trace', 'exception', 'unexpected behavior'],
    'sc:implement': ['build feature', 'write code', 'implement', 'create function', 'add functionality',
      'coding task', 'develop', 'program', 'new feature', 'add support for'],
    'sc:analyze': ['code review', 'quality check', 'audit code', 'assess', 'evaluate code',
      'technical debt', 'code smell', 'complexity', 'maintainability'],
    'sc:test': ['run tests', 'write tests', 'test coverage', 'unit test', 'integration test',
      'verify works', 'check tests', 'testing', 'spec', 'assertion'],
    'sc:build': ['compile', 'build project', 'package', 'bundle', 'webpack', 'vite build',
      'npm build', 'build error', 'compilation'],
    'sc:design': ['architecture design', 'system design', 'api design', 'component design',
      'plan architecture', 'database schema', 'interface design', 'data model'],
    'sc:explain': ['explain code', 'what does this do', 'how does this work', 'understand',
      'walk through', 'clarify', 'documentation', 'teach me'],
    'sc:research': ['look up', 'find information', 'research topic', 'best practices',
      'how to', 'learn about', 'explore options', 'compare approaches', 'state of the art'],
    'sc:brainstorm': ['brainstorm', 'ideate', 'explore ideas', 'creative solutions',
      'what should we', 'options', 'approach', 'strategy', 'think through'],
    'sc:improve': ['refactor', 'clean up', 'optimize', 'make better', 'improve performance',
      'simplify', 'reduce complexity', 'modernize', 'upgrade code'],
    'sc:cleanup': ['remove dead code', 'clean project', 'organize files', 'delete unused',
      'reduce bloat', 'tidy up', 'housekeeping'],
    'sc:document': ['write docs', 'add documentation', 'api docs', 'jsdoc', 'readme',
      'explain api', 'document function', 'add comments'],
    'sc:git': ['git status', 'branch', 'merge', 'rebase', 'stash', 'diff', 'git log',
      'undo commit', 'cherry pick', 'resolve conflict'],
    'sc:estimate': ['how long', 'estimate effort', 'complexity estimate', 'time estimate',
      'story points', 'scope assessment', 'feasibility'],
    'sc:workflow': ['prd', 'product spec', 'feature spec', 'implementation plan',
      'workflow from spec', 'requirements to code'],
    'sc:recommend': ['which command', 'what skill', 'suggest tool', 'help me choose',
      'best approach', 'which one should i use'],
    'sc:spawn': ['multi agent', 'parallel tasks', 'delegate', 'break down task',
      'complex task', 'orchestrate', 'coordinate agents'],
    'sc:task': ['complex task', 'multi step', 'workflow execution', 'end to end'],

    // Seed skills
    'seed:seed': ['new project', 'start project', 'create app', 'build something new',
      'idea', 'from scratch', 'greenfield'],
    'seed:tasks:ideate': ['brainstorm project', 'explore idea', 'project concept'],
    'seed:tasks:graduate': ['graduate project', 'make standalone', 'separate repo'],
    'seed:tasks:launch': ['launch project', 'deploy', 'go live', 'ship it'],
  };

  const EXCLUDE_PREFIXES = ['seed:data:', 'seed:templates:', 'seed:checklists:'];

  return skills
    .filter(s => !EXCLUDE_PREFIXES.some(p => s.id.startsWith(p)))
    .map(s => {
      // Base intents from skill metadata
      const baseIntents = [
        s.name,
        s.id,
        s.category,
        ...(s.description || '').toLowerCase().split(/\s+/).filter(w => w.length > 3),
      ];

      // Curated expansions
      const curated = INTENT_EXPANSIONS[s.id] || INTENT_EXPANSIONS[s.name] || [];

      return {
        command: s.command,
        name: s.name,
        category: s.category,
        description: (s.description || s.name).slice(0, 80),
        intents: [...new Set([...baseIntents, ...curated])].map(i => i.toLowerCase()),
        weight: curated.length > 0 ? 1.2 : 1.0, // Boost curated skills
      };
    });
}

// ── Skill scanning helper ────────────────────────────────────────
function getAllSkills(projectPath?: string): SkillItem[] {
  const userDir = join(homedir(), '.claude', 'commands');
  const skills = scanSkillsDir(userDir, 'global');

  if (projectPath) {
    const resolved = resolve(projectPath);
    if (projectPath === resolved && existsSync(resolved) && statSync(resolved).isDirectory()) {
      const projectDir = join(resolved, '.claude', 'commands');
      skills.push(...scanSkillsDir(projectDir, 'project'));
    }
  }

  return skills;
}

// ── Cache ────────────────────────────────────────────────────────
let cachedIntentMap: IntentEntry[] | null = null;
let cachedHash = '';

function ensureIntentMap(projectPath?: string): IntentEntry[] {
  const skills = getAllSkills(projectPath);
  const hash = skills.map(s => s.id).sort().join(',');

  if (hash !== cachedHash || !cachedIntentMap) {
    cachedIntentMap = buildIntentMap(skills);
    cachedHash = hash;
  }

  return cachedIntentMap;
}

// ── Route ────────────────────────────────────────────────────────
export const skillSuggestRoutes: FastifyPluginAsync = async (app) => {
  // GET /skills/intents — returns the full intent map for client-side matching
  app.get('/skills/intents', async (req) => {
    const projectPath = (req.query as Record<string, string>).project_path;
    const intentMap = ensureIntentMap(projectPath);
    return { intents: intentMap, total: intentMap.length };
  });
};
