import { Captions, Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import {
  useSpeechStore,
  toggleMic,
  stopMic,
  onTranscription,
  offTranscription,
} from '../lib/speech';

/**
 * Top-bar dictation button. Pure dictation — inserts transcribed text at the
 * cursor of whichever input/textarea/contenteditable is currently focused.
 *
 * Visual states mirror SessionMicButton: calibrating (amber) → listening
 * (green) → speaking (orange) → transcribing (green + spinner).
 */
export function GlobalDictationButton() {
  const micReady = useSpeechStore((s) => s.micReady);
  const speaking = useSpeechStore((s) => s.speaking);
  const transcribing = useSpeechStore((s) => s.transcribing);
  const available = useSpeechStore((s) => s.available);
  const globalDictationActive = useSpeechStore((s) => s.globalDictationActive);
  const setGlobalDictationActive = useSpeechStore((s) => s.setGlobalDictationActive);

  const lastFocusedRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!globalDictationActive) return;

    onTranscription((text) => {
      const target = resolveTargetElement(lastFocusedRef.current);
      if (!target) return;
      // xterm terminals: Terminal.tsx watches dictationMode + lastTranscription
      // and routes text over the WebSocket. Skip DOM insertion so we don't
      // fight it (xterm doesn't pick up synthetic input events anyway).
      if (isInsideXterm(target)) return;
      insertAtCursor(target, text);
    });
    return () => {
      offTranscription();
    };
  }, [globalDictationActive]);

  useEffect(() => {
    if (!globalDictationActive) return;
    const handler = () => {
      const el = document.activeElement;
      if (isEditable(el)) lastFocusedRef.current = el;
    };
    document.addEventListener('focusin', handler);
    const current = document.activeElement;
    if (isEditable(current)) lastFocusedRef.current = current;
    return () => document.removeEventListener('focusin', handler);
  }, [globalDictationActive]);

  useEffect(() => {
    return () => {
      const s = useSpeechStore.getState();
      if (s.globalDictationActive) {
        s.setGlobalDictationActive(false);
        if (s.dictationMode) s.setDictationMode(false);
        stopMic();
        offTranscription();
      }
    };
  }, []);

  if (!available) return null;

  const isActive = globalDictationActive;
  const isCalibrating = isActive && !micReady;
  const isListening = isActive && micReady && !speaking && !transcribing;
  const isSpeaking = isActive && micReady && speaking;
  const isTranscribing = isActive && micReady && !speaking && transcribing;

  const bgColor = isCalibrating
    ? '#d97706'
    : isSpeaking
      ? '#ea580c'
      : isTranscribing
        ? '#16a34a'
        : isListening
          ? '#16a34a'
          : 'var(--bg-tertiary)';

  const textColor = isActive ? 'white' : 'var(--text-secondary)';
  const borderColor = isActive ? bgColor : 'var(--border)';

  const label = isCalibrating
    ? 'Starting...'
    : isSpeaking
      ? 'Recording'
      : isTranscribing
        ? 'Processing'
        : isListening
          ? 'Dictating'
          : '';

  const title = isCalibrating
    ? 'Calibrating microphone...'
    : isSpeaking
      ? 'Recording speech...'
      : isTranscribing
        ? 'Transcribing...'
        : isActive
          ? 'Stop dictation'
          : 'Start dictation (types into focused input)';

  const handleClick = async () => {
    if (isActive) {
      setGlobalDictationActive(false);
      const s = useSpeechStore.getState();
      if (s.dictationMode) s.setDictationMode(false);
      await stopMic();
      // Restore focus to the last editable target (or nearest editable / xterm
      // helper) so the user can resume typing / press Enter. Otherwise focus
      // sticks to this button, and the next click or keypress toggles
      // dictation right back on.
      const remembered = lastFocusedRef.current;
      const restoreTarget: HTMLElement | null =
        remembered instanceof HTMLElement &&
        isEditable(remembered) &&
        document.contains(remembered)
          ? remembered
          : findBestEditable();
      if (restoreTarget) {
        try {
          restoreTarget.focus({ preventScroll: true } as FocusOptions);
        } catch {
          restoreTarget.focus();
        }
      }
      return;
    }
    // Pick a target: keep current focus if it's editable, otherwise auto-focus
    // the most prominent editable on the page (or the visible terminal).
    const current = document.activeElement;
    let target: HTMLElement | null = isEditable(current)
      ? (current as HTMLElement)
      : null;
    if (!target) target = findBestEditable();
    if (target) {
      try {
        target.focus({ preventScroll: true } as FocusOptions);
      } catch {
        target.focus();
      }
      lastFocusedRef.current = target;
    }
    // If the target is an xterm helper, route via the existing dictationMode
    // path — Terminal.tsx sends text over the PTY WebSocket when that flag is
    // set. This matches the TerminalMicButton behavior.
    if (target && isInsideXterm(target)) {
      useSpeechStore.getState().setDictationMode(true);
    }
    setGlobalDictationActive(true);
    await toggleMic('push-to-talk');
  };

  return (
    <button
      onClick={handleClick}
      title={title}
      className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors"
      style={{
        background: bgColor,
        color: textColor,
        border: `1px solid ${borderColor}`,
      }}
    >
      <div className="relative flex items-center justify-center w-3.5 h-3.5">
        {isTranscribing ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <>
            <Captions className="w-3.5 h-3.5" />
            {isSpeaking && (
              <span
                className="absolute inset-0 rounded-full animate-ping"
                style={{ background: 'rgba(255,255,255,0.3)' }}
              />
            )}
          </>
        )}
      </div>
      {label && <span className="hidden sm:inline">{label}</span>}
    </button>
  );
}

function isInsideXterm(el: Element | null): boolean {
  if (!el) return false;
  if (!(el instanceof HTMLElement)) return false;
  return !!el.closest('.xterm, .xterm-helper-textarea');
}

/**
 * Pick the best editable element to auto-focus when dictation starts with
 * nothing focused. Prefers large visible inputs/textareas/contenteditables
 * that are currently in the viewport. Falls back to the active terminal's
 * hidden textarea if no other input is visible.
 */
function findBestEditable(): HTMLElement | null {
  const editableSelector =
    'textarea, input, [contenteditable="true"], [contenteditable=""]';
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(editableSelector),
  );

  type Candidate = { el: HTMLElement; area: number; inView: boolean };
  const candidates: Candidate[] = [];
  for (const el of nodes) {
    if (!isEditable(el)) continue;
    if (isInsideXterm(el)) continue; // handled separately below
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const inView =
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth;
    candidates.push({ el, area: rect.width * rect.height, inView });
  }

  if (candidates.length) {
    candidates.sort((a, b) => {
      if (a.inView !== b.inView) return a.inView ? -1 : 1;
      return b.area - a.area;
    });
    return candidates[0].el;
  }

  // Terminal fallback — xterm hides its helper textarea, so
  // getBoundingClientRect can be 0. If a terminal is on screen, focus its
  // helper so Terminal.tsx's dictation routing takes over.
  const xtermWrapper = Array.from(document.querySelectorAll<HTMLElement>('.xterm'))
    .find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  if (xtermWrapper) {
    const helper = xtermWrapper.querySelector<HTMLElement>('.xterm-helper-textarea');
    if (helper) return helper;
  }

  return null;
}

function isEditable(el: Element | null): el is HTMLElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    const textLike = ['text', 'search', 'url', 'email', 'tel', 'password', ''].includes(type);
    return textLike && !el.disabled && !el.readOnly;
  }
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return false;
}

function resolveTargetElement(remembered: Element | null): HTMLElement | null {
  const active = document.activeElement;
  if (isEditable(active)) return active;
  if (remembered && isEditable(remembered) && document.contains(remembered)) {
    return remembered;
  }
  return null;
}

function insertAtCursor(el: HTMLElement, text: string) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const needsSpace = before.length > 0 && !/\s$/.test(before) && !/^\s/.test(text);
    const insert = (needsSpace ? ' ' : '') + text;
    const newValue = before + insert + after;

    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, newValue);
    else el.value = newValue;

    const caret = start + insert.length;
    try {
      el.setSelectionRange(caret, caret);
    } catch {
      // Some input types don't support selection range; ignore.
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  if (el.isContentEditable) {
    el.focus();
    const sel = window.getSelection();
    const toInsert =
      sel && sel.rangeCount && sel.focusNode && sel.focusOffset > 0 ? ' ' + text : text;
    const ok = document.execCommand('insertText', false, toInsert);
    if (!ok && sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(toInsert));
      range.collapse(false);
    }
  }
}
