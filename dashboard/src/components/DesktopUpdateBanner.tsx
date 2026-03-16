import { useState, useEffect } from 'react';
import { Download, X } from 'lucide-react';
import { api } from '../lib/api';
import { isDesktop, getDesktopVersion } from '../lib/tauri';

/** Compare two semver strings. Returns >0 if a>b, <0 if a<b, 0 if equal. */
function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

interface DesktopUpdateBannerProps {
  active?: boolean;
}

export function DesktopUpdateBanner({ active = true }: DesktopUpdateBannerProps) {
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    url: string;
    currentVersion: string | null;
  } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!active || dismissed) return;
    if (!isDesktop) return;

    const sessionKey = 'hivecommand-desktop-update-checked';
    if (sessionStorage.getItem(sessionKey)) return;

    let cancelled = false;

    async function check() {
      try {
        let currentVersion: string | undefined;
        try {
          currentVersion = (await getDesktopVersion()) || undefined;
        } catch {}

        const data = await api.versionCheck();
        sessionStorage.setItem(sessionKey, '1');

        if (cancelled) return;
        if (!data.updateAvailable) return;

        if (currentVersion && data.latest) {
          if (compareSemver(data.latest, currentVersion) <= 0) return;
        } else if (!currentVersion) {
          return;
        }

        setUpdateInfo({
          version: data.latest,
          url: data.url,
          currentVersion: currentVersion || null,
        });
      } catch {
        // Silently fail — update check is non-critical
      }
    }

    check();
    return () => { cancelled = true; };
  }, [active, dismissed]);

  if (!updateInfo || dismissed) return null;

  return (
    <div style={{
      background: 'linear-gradient(135deg, #3b82f615, #8b5cf615)',
      border: '1px solid #3b82f633',
      borderRadius: 8,
      padding: '10px 14px',
      margin: '0 0 8px 0',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      fontSize: 13,
    }}>
      <Download className="w-4 h-4 flex-shrink-0" style={{ color: '#60a5fa' }} />
      <div style={{ flex: 1 }}>
        <span style={{ color: 'var(--text-primary)' }}>
          Desktop app <strong>v{updateInfo.version}</strong> available
          {updateInfo.currentVersion && <span style={{ color: 'var(--text-secondary)' }}> (current: v{updateInfo.currentVersion})</span>}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {updateInfo.url && (
          <a
            href={updateInfo.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors"
            style={{ background: '#3b82f622', color: '#60a5fa', border: '1px solid #3b82f644' }}
          >
            <Download className="w-3 h-3" /> View Release
          </a>
        )}
        <button
          onClick={() => setDismissed(true)}
          className="p-1 rounded transition-colors hover:bg-white/10"
          style={{ color: 'var(--text-secondary)' }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
