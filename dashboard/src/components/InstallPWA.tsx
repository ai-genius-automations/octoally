import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { isElectron, isDesktop } from '../lib/tauri';

/**
 * InstallPWA — shows a subtle "Install app" banner when the browser
 * fires the beforeinstallprompt event (Chrome/Edge/Android).
 *
 * Hidden automatically when:
 *  - Running inside Electron (desktop app already installed)
 *  - Running inside Tauri (desktop app already installed)
 *  - App is already installed as a PWA (display-mode: standalone)
 *  - Browser doesn't support installation prompts (Firefox, Safari < 17)
 *
 * Safari 17+ on iOS/macOS shows a manual "Add to Home Screen" tip instead,
 * since it doesn't fire beforeinstallprompt.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isRunningAsStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari sets this when launched from home screen
    ('standalone' in window.navigator && (window.navigator as any).standalone === true)
  );
}

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
}

export function InstallPWA() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIOSTip, setShowIOSTip] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem('pwa-install-dismissed') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    // Never show inside desktop apps or when already installed as PWA
    if (isElectron || isDesktop || isRunningAsStandalone()) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handler);

    // iOS Safari: show a manual tip if not already dismissed
    if (isIOS() && !dismissed) {
      setShowIOSTip(true);
    }

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [dismissed]);

  function dismiss() {
    try {
      localStorage.setItem('pwa-install-dismissed', '1');
    } catch {}
    setDismissed(true);
    setPrompt(null);
    setShowIOSTip(false);
  }

  async function install() {
    if (!prompt) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') {
      setPrompt(null);
    }
  }

  // Nothing to render
  if (dismissed || (!prompt && !showIOSTip)) return null;

  return (
    <div
      className="flex items-center justify-between px-4 py-1.5 text-xs shrink-0"
      style={{
        background: 'rgba(239, 68, 68, 0.08)',
        borderBottom: '1px solid rgba(239, 68, 68, 0.18)',
      }}
    >
      <div className="flex items-center gap-2">
        <Download className="w-3.5 h-3.5 shrink-0" style={{ color: '#ef4444' }} />
        {showIOSTip && !prompt ? (
          <span style={{ color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Install OctoAlly</strong>
            {' '}— tap the share icon then{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Add to Home Screen</strong>
          </span>
        ) : (
          <>
            <span style={{ color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>Install OctoAlly</strong>
              {' '}as an app for faster access
            </span>
            <button
              onClick={install}
              className="px-2 py-0.5 rounded text-[10px] font-medium transition-colors hover:brightness-110"
              style={{ background: 'rgba(239, 68, 68, 0.18)', color: '#ef4444' }}
            >
              Install
            </button>
          </>
        )}
      </div>
      <button
        onClick={dismiss}
        className="p-0.5 rounded hover:opacity-80"
        style={{ color: 'var(--text-secondary)' }}
        title="Dismiss"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
