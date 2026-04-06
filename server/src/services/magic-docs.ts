/**
 * magic-docs.ts — Auto-suggest prompts from file context + tool registry.
 *
 * Analyzes the current file context to suggest relevant prompts,
 * tools, and commands the user might want to use.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface PromptSuggestion {
  text: string;
  description: string;
  source: 'file_context' | 'tool_registry' | 'recent_history' | 'pattern';
  confidence: number; // 0.0 to 1.0
  category: string;
}

interface ToolEntry {
  name: string;
  type: string;
  source: string;
  description: string;
}

// File extension → relevant prompt categories
const EXTENSION_HINTS: Record<string, string[]> = {
  '.py': ['test', 'lint', 'type-check', 'debug', 'refactor'],
  '.ts': ['compile', 'test', 'lint', 'type-check', 'build'],
  '.tsx': ['component', 'test', 'style', 'accessibility'],
  '.rs': ['build', 'test', 'clippy', 'benchmark'],
  '.json': ['validate', 'format', 'schema'],
  '.md': ['proofread', 'format', 'toc'],
  '.sh': ['shellcheck', 'test', 'permissions'],
};

// Common prompt templates per category
const PROMPT_TEMPLATES: Record<string, PromptSuggestion[]> = {
  test: [
    { text: 'Write tests for this file', description: 'Generate unit tests', source: 'pattern', confidence: 0.8, category: 'testing' },
    { text: 'Run existing tests', description: 'Execute test suite', source: 'pattern', confidence: 0.7, category: 'testing' },
  ],
  debug: [
    { text: 'Debug this error', description: 'Analyze and fix errors', source: 'pattern', confidence: 0.7, category: 'debugging' },
    { text: 'Add logging to trace execution', description: 'Instrument with logging', source: 'pattern', confidence: 0.5, category: 'debugging' },
  ],
  refactor: [
    { text: 'Refactor for readability', description: 'Improve code clarity', source: 'pattern', confidence: 0.6, category: 'refactoring' },
    { text: 'Extract function', description: 'Pull out reusable logic', source: 'pattern', confidence: 0.5, category: 'refactoring' },
  ],
  build: [
    { text: 'Build and check for errors', description: 'Compile the project', source: 'pattern', confidence: 0.8, category: 'build' },
  ],
  lint: [
    { text: 'Lint and fix issues', description: 'Run linter with auto-fix', source: 'pattern', confidence: 0.7, category: 'quality' },
  ],
  component: [
    { text: 'Add props interface', description: 'Define TypeScript props', source: 'pattern', confidence: 0.6, category: 'react' },
    { text: 'Add error boundary', description: 'Wrap in error handling', source: 'pattern', confidence: 0.4, category: 'react' },
  ],
};

let toolRegistryCache: ToolEntry[] | null = null;

function loadToolRegistry(): ToolEntry[] {
  if (toolRegistryCache) return toolRegistryCache;

  const nexusRoot = process.env.ALETHEIA_NEXUS_PATH || join(homedir(), 'ALETHEIA-NEXUS');
  const registryPath = join(nexusRoot, 'config', 'tool_registry.json');
  try {
    if (existsSync(registryPath)) {
      const data = JSON.parse(readFileSync(registryPath, 'utf-8'));
      toolRegistryCache = data.tools || [];
      return toolRegistryCache!;
    }
  } catch {
    // Silently fail — registry is optional
  }
  return [];
}

/**
 * Get prompt suggestions based on file context.
 */
export function getSuggestions(options: {
  filePath?: string;
  fileContent?: string;
  recentPrompts?: string[];
  maxSuggestions?: number;
}): PromptSuggestion[] {
  const suggestions: PromptSuggestion[] = [];
  const max = options.maxSuggestions || 5;

  // File extension hints
  if (options.filePath) {
    const ext = '.' + options.filePath.split('.').pop();
    const categories = EXTENSION_HINTS[ext] || [];
    for (const cat of categories) {
      const templates = PROMPT_TEMPLATES[cat] || [];
      suggestions.push(...templates);
    }
  }

  // Content-based hints
  if (options.fileContent) {
    const content = options.fileContent.toLowerCase();
    if (content.includes('todo') || content.includes('fixme')) {
      suggestions.push({
        text: 'Fix all TODOs in this file',
        description: 'Address TODO/FIXME comments',
        source: 'file_context',
        confidence: 0.9,
        category: 'maintenance',
      });
    }
    if (content.includes('error') || content.includes('exception')) {
      suggestions.push({
        text: 'Improve error handling',
        description: 'Add proper error handling',
        source: 'file_context',
        confidence: 0.7,
        category: 'reliability',
      });
    }
    if (content.includes('import') && content.length > 5000) {
      suggestions.push({
        text: 'Split this file into smaller modules',
        description: 'File is large — consider decomposition',
        source: 'file_context',
        confidence: 0.6,
        category: 'refactoring',
      });
    }
  }

  // Tool registry suggestions
  const tools = loadToolRegistry();
  if (options.fileContent && tools.length > 0) {
    const contentWords = new Set(options.fileContent.toLowerCase().split(/\s+/));
    for (const tool of tools.slice(0, 50)) {
      const nameWords = tool.name.toLowerCase().replace(/[_-]/g, ' ').split(' ');
      const overlap = nameWords.filter(w => contentWords.has(w)).length;
      if (overlap > 0) {
        suggestions.push({
          text: `Use ${tool.name}`,
          description: tool.description,
          source: 'tool_registry',
          confidence: Math.min(overlap * 0.3, 0.9),
          category: tool.type,
        });
      }
    }
  }

  // Sort by confidence and deduplicate
  suggestions.sort((a, b) => b.confidence - a.confidence);
  const seen = new Set<string>();
  return suggestions.filter(s => {
    if (seen.has(s.text)) return false;
    seen.add(s.text);
    return true;
  }).slice(0, max);
}

/**
 * Get quick action suggestions for the current context.
 */
export function getQuickActions(filePath: string): string[] {
  const ext = '.' + filePath.split('.').pop();
  const actions: string[] = [];

  switch (ext) {
    case '.py':
      actions.push('pytest', 'mypy', 'black', 'ruff');
      break;
    case '.ts':
    case '.tsx':
      actions.push('tsc --noEmit', 'npm test', 'eslint');
      break;
    case '.rs':
      actions.push('cargo test', 'cargo clippy', 'cargo build');
      break;
    case '.json':
      actions.push('validate JSON', 'format');
      break;
  }

  return actions;
}
