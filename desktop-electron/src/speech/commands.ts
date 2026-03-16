/**
 * Voice command registry and matching.
 * Commands are matched against Groq/cloud transcriptions in the wake-word active phase.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandActionKind = 'navigate' | 'create-session' | 'close-session' | 'close-project' | 'refresh-tab' | 'refresh-page' | 'delete-words' | 'clear-text' | 'start-transcribe' | 'stop-transcribe' | 'stop-transcribe-enter' | 'press-enter' | 'dismiss-commands' | 'stop-listening' | 'shell';

export interface NavigateAction {
  kind: 'navigate';
  target: 'home' | 'project' | 'terminal' | 'hivemind' | 'sessions' | 'show-all';
}

export interface CreateSessionAction {
  kind: 'create-session';
  sessionType: 'terminal' | 'hivemind';
}

export interface CloseSessionAction {
  kind: 'close-session';
  sessionType: 'terminal' | 'hivemind';
}

export interface StartTranscribeAction {
  kind: 'start-transcribe';
}

export interface StopTranscribeAction {
  kind: 'stop-transcribe';
}

export interface StopTranscribeEnterAction {
  kind: 'stop-transcribe-enter';
}

export interface PressEnterAction {
  kind: 'press-enter';
}

export interface DismissCommandsAction {
  kind: 'dismiss-commands';
}

export interface CloseProjectAction {
  kind: 'close-project';
}

export interface DeleteWordsAction {
  kind: 'delete-words';
}

export interface ClearTextAction {
  kind: 'clear-text';
}

export interface RefreshTabAction {
  kind: 'refresh-tab';
}

export interface RefreshPageAction {
  kind: 'refresh-page';
}

export interface StopListeningAction {
  kind: 'stop-listening';
}

export interface ShellAction {
  kind: 'shell';
  command: string;
  background: boolean;
}

export type VoiceCommandAction =
  | NavigateAction
  | CreateSessionAction
  | CloseSessionAction
  | CloseProjectAction
  | DeleteWordsAction
  | ClearTextAction
  | RefreshTabAction
  | RefreshPageAction
  | StartTranscribeAction
  | StopTranscribeAction
  | StopTranscribeEnterAction
  | PressEnterAction
  | DismissCommandsAction
  | StopListeningAction
  | ShellAction;

export interface VoiceCommand {
  id: string;
  name: string;
  triggerPhrases: string[];
  action: VoiceCommandAction;
  type: 'builtin' | 'custom';
  enabled: boolean;
}

export interface CommandMatch {
  command: VoiceCommand;
  param: string; // extracted trailing text after trigger phrase (e.g. project name, number)
  rawText: string;
}

// ---------------------------------------------------------------------------
// Built-in commands
// ---------------------------------------------------------------------------

const BUILTIN_COMMANDS: VoiceCommand[] = [
  {
    id: 'navigate-home',
    name: 'Go Home',
    triggerPhrases: ['go home', 'show projects', 'projects list', 'go to projects'],
    action: { kind: 'navigate', target: 'home' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'navigate-project',
    name: 'Open Project',
    triggerPhrases: ['open project', 'switch to project', 'go to project'],
    action: { kind: 'navigate', target: 'project' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'navigate-terminal',
    name: 'Open Terminal',
    triggerPhrases: ['open terminal', 'switch to terminal', 'go to terminal'],
    action: { kind: 'navigate', target: 'terminal' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'navigate-hivemind',
    name: 'Open Hivemind',
    triggerPhrases: ['open hivemind', 'switch to hivemind', 'go to hivemind', 'open hive mind'],
    action: { kind: 'navigate', target: 'hivemind' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'new-terminal',
    name: 'New Terminal',
    triggerPhrases: ['new terminal', 'create terminal', 'add terminal', 'open new terminal'],
    action: { kind: 'create-session', sessionType: 'terminal' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'new-hivemind',
    name: 'New Hivemind',
    triggerPhrases: ['new hivemind', 'create hivemind', 'add hivemind', 'new hive mind', 'create hive mind'],
    action: { kind: 'create-session', sessionType: 'hivemind' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'close-terminal',
    name: 'Close Terminal',
    triggerPhrases: ['close terminal', 'kill terminal', 'end terminal'],
    action: { kind: 'close-session', sessionType: 'terminal' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'close-hivemind',
    name: 'Close Hivemind',
    triggerPhrases: ['close hivemind', 'kill hivemind', 'end hivemind', 'close hive mind', 'kill hive mind'],
    action: { kind: 'close-session', sessionType: 'hivemind' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'show-all',
    name: 'Show All',
    triggerPhrases: ['show all', 'show all sessions', 'show all terminals', 'show everything'],
    action: { kind: 'navigate', target: 'show-all' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'navigate-sessions',
    name: 'Show Active Sessions',
    triggerPhrases: ['show active sessions', 'active sessions', 'show sessions'],
    action: { kind: 'navigate', target: 'sessions' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'close-project',
    name: 'Close Project',
    triggerPhrases: ['close project'],
    action: { kind: 'close-project' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'delete-words',
    name: 'Delete Words',
    // Trigger phrases for regex fallback. The number goes in the param.
    // GPT-5 mini handles flexible phrasing like "delete 3 words" / "clear three words".
    // Regex only matches prefix, so "delete words" matches "delete words" with no param,
    // and the App.tsx handler defaults to 1 word.
    triggerPhrases: ['delete words', 'remove words', 'delete word', 'remove word', 'clear words', 'clear word'],
    action: { kind: 'delete-words' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'clear-text',
    name: 'Clear Text',
    triggerPhrases: ['clear text', 'clear line', 'clear input'],
    action: { kind: 'clear-text' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'refresh-tab',
    name: 'Refresh Tab',
    triggerPhrases: ['refresh tab', 'refresh terminal', 'refresh display'],
    action: { kind: 'refresh-tab' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'refresh-page',
    name: 'Refresh Page',
    triggerPhrases: ['refresh now', 'refresh page', 'reload page', 'reload app'],
    action: { kind: 'refresh-page' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'start-transcribe',
    name: 'Start Transcribe',
    triggerPhrases: ['start transcribe', 'start transcribing', 'begin dictation', 'start dictation', 'start'],
    action: { kind: 'start-transcribe' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'stop-transcribe',
    name: 'Stop Transcribe',
    triggerPhrases: ['stop transcribe', 'stop transcribing', 'stop dictation', 'end dictation', 'stop'],
    action: { kind: 'stop-transcribe' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'stop-transcribe-enter',
    name: 'Stop Transcribe + Enter',
    triggerPhrases: ['stop transcribe enter', 'stop transcribing enter', 'stop dictation enter', 'end dictation enter', 'stop transcribe send', 'stop transcribing send', 'stop dictation send', 'end dictation send', 'stop enter', 'stop send'],
    action: { kind: 'stop-transcribe-enter' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'press-enter',
    name: 'Press Enter',
    triggerPhrases: ['press enter', 'hit enter', 'send it', 'send', 'submit'],
    action: { kind: 'press-enter' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'dismiss-commands',
    name: 'Exit Command Mode',
    triggerPhrases: ['stop hivecommand', 'bye hivecommand', 'dismiss', 'exit commands', 'goodbye hivecommand'],
    action: { kind: 'dismiss-commands' },
    type: 'builtin',
    enabled: true,
  },
  {
    id: 'stop-listening',
    name: 'Stop Listening',
    triggerPhrases: ['stop listening', 'stop wake word', 'turn off mic', 'mic off', 'stop mic'],
    action: { kind: 'stop-listening' },
    type: 'builtin',
    enabled: true,
  },
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface BuiltinOverride {
  triggerPhrases?: string[];
  enabled?: boolean;
}

let customCommands: VoiceCommand[] = [];
let builtinOverrides: Record<string, BuiltinOverride> = {};

export function loadCommands(
  customs: VoiceCommand[],
  overrides: Record<string, BuiltinOverride>,
) {
  customCommands = customs;
  builtinOverrides = overrides;
}

export function getAllCommands(): VoiceCommand[] {
  const builtins = BUILTIN_COMMANDS.map((cmd) => {
    const override = builtinOverrides[cmd.id];
    if (!override) return cmd;
    return {
      ...cmd,
      triggerPhrases: override.triggerPhrases ?? cmd.triggerPhrases,
      enabled: override.enabled ?? cmd.enabled,
    };
  });
  return [...builtins, ...customCommands];
}

export function getBuiltinDefaults(): VoiceCommand[] {
  return BUILTIN_COMMANDS;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim();
}

/** Convert number words to digits for "terminal one" → "terminal 1" */
function expandNumberWords(text: string): string {
  const numberMap: Record<string, string> = {
    one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
    first: '1', second: '2', third: '3', fourth: '4', fifth: '5',
  };
  return text.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth)\b/g,
    (m) => numberMap[m] || m);
}

function phraseMatches(input: string, trigger: string): { matches: boolean; remainder: string } {
  const inputWords = input.split(/\s+/);
  const triggerWords = trigger.split(/\s+/);

  // Direct prefix match — trigger must be at the START of the utterance
  if (input.startsWith(trigger)) {
    const remainder = input.slice(trigger.length).trim();
    return { matches: true, remainder };
  }

  // Word-level prefix match — trigger words must appear at the BEGINNING in order
  // (no longer matches trigger words scattered anywhere in the sentence)
  if (inputWords.length >= triggerWords.length) {
    let prefixMatch = true;
    for (let i = 0; i < triggerWords.length; i++) {
      if (inputWords[i] !== triggerWords[i]) {
        prefixMatch = false;
        break;
      }
    }
    if (prefixMatch) {
      const remainder = inputWords.slice(triggerWords.length).join(' ').trim();
      return { matches: true, remainder };
    }
  }

  // Try with joined words (e.g. "openproject" contains "open project")
  const joinedInput = inputWords.join('');
  const joinedTrigger = triggerWords.join('');
  if (joinedInput.startsWith(joinedTrigger)) {
    return { matches: true, remainder: '' };
  }

  return { matches: false, remainder: '' };
}

/**
 * Match transcribed text against all enabled commands.
 * Returns the best match (longest trigger phrase wins).
 *
 * Single-word triggers (e.g. "stop", "start", "send") only match short utterances
 * (trigger + at most 2 extra words for a param like "delete three words").
 * This prevents natural speech like "go ahead and stop the server" from triggering
 * the "stop" command.
 */
export function matchCommand(text: string): CommandMatch | null {
  const normalized = normalize(text);
  const expanded = expandNumberWords(normalized);
  const wordCount = normalized.split(/\s+/).length;

  // Special case: "delete/remove/clear N words" where N is between the verb and "words"
  // e.g. "delete three words", "remove 5 words", "clear two words"
  const deleteWordsMatch = expanded.match(/^(delete|remove|clear)\s+(\d+)\s+words?$/);
  if (deleteWordsMatch) {
    const deleteCmd = getAllCommands().find((c) => c.id === 'delete-words' && c.enabled);
    if (deleteCmd) {
      return { command: deleteCmd, param: deleteWordsMatch[2], rawText: text };
    }
  }

  let bestMatch: CommandMatch | null = null;
  let bestTriggerLen = 0;

  for (const cmd of getAllCommands()) {
    if (!cmd.enabled) continue;

    for (const trigger of cmd.triggerPhrases) {
      const normTrigger = normalize(trigger);
      if (normTrigger.length <= bestTriggerLen) continue; // only try longer triggers

      const triggerWordCount = normTrigger.split(/\s+/).length;

      // Single-word triggers must be standalone or have at most 2 param words
      // e.g. "stop" matches "stop", "stop transcribe", but NOT "go ahead and stop"
      if (triggerWordCount === 1 && wordCount > triggerWordCount + 2) continue;

      // Two-word triggers allow up to 3 param words (e.g. "open project my cool app")
      if (triggerWordCount === 2 && wordCount > triggerWordCount + 3) continue;

      // Try both original and number-expanded versions
      for (const input of [normalized, expanded]) {
        const result = phraseMatches(input, normTrigger);
        if (result.matches) {
          bestMatch = {
            command: cmd,
            param: result.remainder,
            rawText: text,
          };
          bestTriggerLen = normTrigger.length;
          break;
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Quick check if text matches stop-transcribe command.
 * Used in global/dictation mode to detect "stop transcribe" without full command matching.
 */
export function isStopTranscribeCommand(text: string): boolean {
  const match = matchCommand(text);
  return match !== null && (match.command.action.kind === 'stop-transcribe' || match.command.action.kind === 'stop-transcribe-enter');
}
