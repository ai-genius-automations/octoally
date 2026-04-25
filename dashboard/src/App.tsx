import { useEffect, useState, useCallback, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc, createTRPCClient } from './lib/trpc';
import { connectStream, useStreamStore, setQueryClient } from './lib/websocket';
import { api } from './lib/api';
import { ProjectDashboard } from './components/ProjectDashboard';
import { ProjectView, cleanupProjectStorage } from './components/ProjectView';
import { X, LayoutGrid, FolderOpen, Monitor, Settings, ArrowUpCircle } from 'lucide-react';
import { isDesktop, isElectron, getDesktopVersion } from './lib/tauri';
import { AgentGuideButton } from './components/AgentGuide';
import { CloseTabModal } from './components/CloseTabModal';
import { CloseAppModal } from './components/CloseAppModal';
import { SettingsModal } from './components/SettingsModal';
import { ActiveTerminals } from './components/ActiveTerminals';
import { GlobalMicButton } from './components/GlobalMicButton';
import { GlobalDictationButton } from './components/GlobalDictationButton';
import { ModelDownloadModal } from './components/ModelDownloadModal';
import { initSpeechListeners } from './lib/speech';
import { onVoiceCommand } from './lib/voice-commands';
import type { VoiceCommandPayload } from './lib/voice-commands';
import { installShortcutDispatcher, useShortcut, useShortcutStore, markKeyboardNav } from './lib/shortcuts';
import { InstallPWA } from './components/InstallPWA';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Disable refetch-on-focus: the burst of simultaneous API calls when
      // returning from another browser tab blocks the main thread and makes
      // the terminal unresponsive for several seconds.  We already use
      // refetchInterval and WebSocket-driven invalidation for freshness.
      refetchOnWindowFocus: false,
    },
  },
});
const trpcClient = createTRPCClient();

interface ProjectTab {
  projectId: string;
  projectName: string;
}

const APP_STATE_KEY = 'octoally-app-state-v2';

function loadAppState(): { activeTab: string; projectTabs: ProjectTab[] } | null {
  try {
    const raw = localStorage.getItem(APP_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.activeTab === 'string' && Array.isArray(parsed.projectTabs)) {
      return parsed;
    }
  } catch {}
  return null;
}

function saveAppState(activeTab: string, projectTabs: ProjectTab[]) {
  try {
    localStorage.setItem(APP_STATE_KEY, JSON.stringify({ activeTab, projectTabs }));
  } catch {}
}

function Dashboard() {
  const connected = useStreamStore((s) => s.connected);
  const [savedState] = useState(loadAppState);
  const [activeTab, setActiveTab] = useState<string>(savedState?.activeTab ?? 'home');
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  const [projectTabs, setProjectTabs] = useState<ProjectTab[]>(() => {
    const tabs = savedState?.projectTabs ?? [];
    // Deduplicate by projectId
    const seen = new Set<string>();
    return tabs.filter((t) => {
      if (seen.has(t.projectId)) return false;
      seen.add(t.projectId);
      return true;
    });
  });

  // Apply saved app font size on load
  const { data: appSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
    staleTime: 30_000,
  });
  useEffect(() => {
    const size = appSettings?.settings?.app_font_size;
    if (size) {
      document.documentElement.style.setProperty('--app-font-size', `${size}px`);
    }
    // Hydrate shortcut bindings as soon as settings arrive
    const bindingsRaw = appSettings?.settings?.shortcut_bindings;
    if (bindingsRaw !== undefined) {
      useShortcutStore.getState().hydrate(bindingsRaw);
    }
  }, [appSettings]);

  // Install the global keydown dispatcher once
  useEffect(() => {
    const uninstall = installShortcutDispatcher();
    return () => uninstall();
  }, []);

  // Track hidden session IDs reported by each ProjectView
  const hiddenSessionIdsRef = useRef<Map<string, string[]>>(new Map());
  const [hiddenSessionIds, setHiddenSessionIds] = useState<string[]>([]);
  const handleHiddenSessionsChange = useCallback((projectId: string, sessionIds: string[]) => {
    hiddenSessionIdsRef.current.set(projectId, sessionIds);
    const all: string[] = [];
    for (const ids of hiddenSessionIdsRef.current.values()) all.push(...ids);
    setHiddenSessionIds(all);
  }, []);
  // Stable per-project callbacks to avoid inline arrow re-creation on every render
  const hiddenSessionsCallbacksRef = useRef<Map<string, (ids: string[]) => void>>(new Map());
  const getHiddenSessionsCallback = useCallback((projectId: string) => {
    let cb = hiddenSessionsCallbacksRef.current.get(projectId);
    if (!cb) {
      cb = (ids: string[]) => handleHiddenSessionsChange(projectId, ids);
      hiddenSessionsCallbacksRef.current.set(projectId, cb);
    }
    return cb;
  }, [handleHiddenSessionsChange]);

  const queryClient = useQueryClient();

  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects.list(),
  });

  // Sessions — driven by WebSocket invalidation (websocket.ts invalidates on session.* events).
  // Long fallback interval for stale-data recovery only.
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
    refetchInterval: 60_000,
  });

  // Server version from health endpoint
  const { data: healthData } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const serverVersion = healthData?.version || null;

  // Version check — poll every 30 minutes
  const { data: versionData } = useQuery({
    queryKey: ['version-check'],
    queryFn: () => api.versionCheck(),
    staleTime: 30 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [updateDismissed, setUpdateDismissed] = useState(false);

  // Desktop app version (Tauri only)
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!isDesktop) return;
    (async () => {
      const v = await getDesktopVersion();
      if (v) setDesktopVersion(v);
    })();
  }, []);

  const projects = projectsData?.projects || [];
  const sessions = sessionsData?.sessions || [];

  // Copy update command to clipboard and show brief confirmation.
  const [updateCopied, setUpdateCopied] = useState(false);
  const triggerUpdate = useCallback(async () => {
    const cmd = 'npx -y octoally@latest';
    try {
      await navigator.clipboard.writeText(cmd);
      setUpdateCopied(true);
      setTimeout(() => setUpdateCopied(false), 4000);
    } catch {
      // Fallback: select from prompt
      window.prompt('Copy this command and run it in your terminal:', cmd);
    }
  }, []);

  const activeSessionCount = sessions.filter(
    (s) => s.status === 'running' || s.status === 'detached'
  ).length;
  const [showActiveTerminals, setShowActiveTerminals] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCloseApp, setShowCloseApp] = useState(false);

  // Listen for close dialog request from Electron main process
  useEffect(() => {
    if (!isElectron) return;
    const unlisten = (window as any).electronAPI.on('show-close-dialog', () => {
      setShowCloseApp(true);
    });
    return () => unlisten?.();
  }, []);

  const dismissActiveTerminals = useCallback(() => {
    setShowActiveTerminals(false);
    // Fire a resize event so terminals re-fit to their restored container size
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }, []);

  useEffect(() => {
    setQueryClient(queryClient);
    connectStream();
    initSpeechListeners();
  }, []);

  // Voice command handler
  useEffect(() => {
    return onVoiceCommand((payload: VoiceCommandPayload) => {
      if (payload.action.kind === 'navigate') {
        const target = payload.action.target;
        if (target === 'home') {
          setActiveTab('home');
          dismissActiveTerminals();
        } else if (target === 'sessions') {
          setShowActiveTerminals(true);
        } else if (target === 'show-all') {
          if (activeTab.startsWith('project-')) {
            setFocusSessionId('__voice_show_all');
          }
        } else if (target === 'project' && payload.param) {
          const normalized = payload.param.toLowerCase().replace(/\s+/g, '');
          const match = projects.find((p) => {
            const pn = p.name.toLowerCase().replace(/\s+/g, '');
            return pn.includes(normalized) || normalized.includes(pn);
          });
          if (match) {
            handleOpenProject(match.id, match.name);
            dismissActiveTerminals();
          } else {
            console.warn(`[STT] No project matched: "${payload.param}"`);
          }
        } else if (target === 'terminal' || target === 'session') {
          if (activeTab.startsWith('project-')) {
            const numberWords: Record<string, number> = {
              one: 1, two: 2, three: 3, four: 4, five: 5,
              six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
              first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
            };
            let numStr = payload.param;
            if (!numStr && payload.rawText) {
              const words = payload.rawText.toLowerCase().replace(/[^\w\s]/g, '').trim().split(/\s+/);
              const lastWord = words[words.length - 1];
              if (numberWords[lastWord] || /^\d+$/.test(lastWord)) {
                numStr = lastWord;
              }
            }
            const paramLower = (numStr || '').toLowerCase().trim();
            const num = numberWords[paramLower] ?? parseInt(paramLower, 10);
            console.log(`[STT] Navigate ${target} #${num} (param: "${payload.param}", rawText: "${payload.rawText}", extracted: "${numStr}")`);
            if (!isNaN(num)) {
              setFocusSessionId(`__voice_${target}_${num}`);
            }
          }
        }
      } else if (payload.action.kind === 'create-session') {
        if (activeTab.startsWith('project-')) {
          setFocusSessionId(`__voice_create_${payload.action.sessionType}`);
        }
      } else if (payload.action.kind === 'close-session') {
        if (activeTab.startsWith('project-')) {
          setFocusSessionId(`__voice_close_${payload.action.sessionType}`);
        }
      } else if (payload.action.kind === 'close-project') {
        // Dispatch a custom event — handled after closeProjectTab is defined
        window.dispatchEvent(new CustomEvent('octoally:voice-close-project', {
          detail: { param: payload.param },
        }));
      } else if (payload.action.kind === 'refresh-tab') {
        if (activeTab.startsWith('project-')) {
          setFocusSessionId('__voice_refresh_tab');
        }
      } else if (payload.action.kind === 'refresh-page') {
        window.location.reload();
      } else if (payload.action.kind === 'delete-words') {
        const numberWords: Record<string, number> = {
          one: 1, two: 2, three: 3, four: 4, five: 5,
          six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
        };
        const cleaned = payload.param.toLowerCase().replace(/\bwords?\b/g, '').trim();
        const count = numberWords[cleaned] ?? (parseInt(cleaned, 10) || 1);
        console.log(`[STT] Delete ${count} words (param: "${payload.param}", cleaned: "${cleaned}")`);
        // Send Ctrl+W one at a time with small delays so the shell processes each
        for (let i = 0; i < count; i++) {
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('octoally:terminal-input', {
              detail: { data: '\x17' },
            }));
          }, i * 50);
        }
      } else if (payload.action.kind === 'clear-text') {
        // Ctrl+U = kill line in bash/zsh
        window.dispatchEvent(new CustomEvent('octoally:terminal-input', {
          detail: { data: '\x15' },
        }));
      }
    });
  }, [projects, activeTab]);

  // Persist app state
  useEffect(() => {
    saveAppState(activeTab, projectTabs);
  }, [activeTab, projectTabs]);

  // Tab navigation shortcuts — cycle across 'home' + open project tabs.
  // markKeyboardNav() raises a short-lived flag so the newly visible
  // terminal doesn't auto-focus (which would trap the user). Click-to-switch
  // doesn't set the flag, so clicks keep the current focus-terminal behavior.
  const cycleTab = useCallback((delta: number) => {
    const order: string[] = ['home', ...projectTabs.map((t) => `project-${t.projectId}`)];
    if (order.length <= 1) return;
    const idx = order.indexOf(activeTab);
    const next = order[((idx === -1 ? 0 : idx) + delta + order.length) % order.length];
    markKeyboardNav();
    // Blur whatever has focus (usually the terminal helper textarea) so focus
    // doesn't stay "inside" the previous tab after we switch.
    (document.activeElement as HTMLElement | null)?.blur?.();
    setActiveTab(next);
  }, [activeTab, projectTabs]);

  useShortcut('nav.nextTab', () => cycleTab(1));
  useShortcut('nav.prevTab', () => cycleTab(-1));
  useShortcut('nav.goHome', () => setActiveTab('home'));

  // Launch shortcuts — resolve "current project" as (a) the active project
  // tab, or (b) the selected card on the home page. ProjectDashboard reports
  // its current selection via onSelectedProjectChange into the ref.
  const homeSelectedProjectIdRef = useRef<string | null>(null);
  const resolveCurrentProjectId = useCallback((): string | null => {
    if (activeTab.startsWith('project-')) return activeTab.slice('project-'.length);
    if (activeTab === 'home') return homeSelectedProjectIdRef.current;
    return null;
  }, [activeTab]);
  const launchForCurrent = useCallback((quickLaunch: 'session' | 'terminal', cliType?: 'claude' | 'codex') => {
    const pid = resolveCurrentProjectId();
    if (!pid) return;
    const project = projects.find((p) => p.id === pid);
    if (!project) return;
    handleOpenProject(pid, project.name, quickLaunch, cliType);
  }, [projects, resolveCurrentProjectId]);
  useShortcut('session.launchClaude', () => launchForCurrent('session', 'claude'));
  useShortcut('session.launchCodex', () => launchForCurrent('session', 'codex'));
  useShortcut('session.launchTerminal', () => launchForCurrent('terminal'));

  // Release focus from any input/terminal — gives users a way to "escape" the
  // terminal input back to a no-focus state. Unbound by default.
  useShortcut('nav.blurInput', () => {
    const el = document.activeElement as HTMLElement | null;
    if (el && typeof el.blur === 'function') el.blur();
  });

  function handleOpenProject(projectId: string, projectName: string, quickLaunch?: 'session' | 'agent' | 'terminal', cliType?: 'claude' | 'codex') {
    setProjectTabs((prev) => {
      if (prev.find((t) => t.projectId === projectId)) return prev;
      return [...prev, { projectId, projectName }];
    });
    setActiveTab(`project-${projectId}`);
    if (quickLaunch) {
      const suffix = cliType && cliType !== 'claude' ? `_${cliType}` : '';
      setFocusSessionId(`__voice_create_${quickLaunch}${suffix}`);
    }
  }

  const [confirmClose, setConfirmClose] = useState<{ projectId: string; count: number } | null>(null);

  const closeProjectTab = useCallback(async (projectId: string) => {
    // Fetch fresh session list — cached data may be stale (e.g. right after quick-launch)
    let runningSessions = sessions.filter(
      (s) => s.project_id === projectId && (s.status === 'running' || s.status === 'detached')
    );
    if (runningSessions.length === 0) {
      try {
        const fresh = await api.sessions.list();
        runningSessions = (fresh.sessions || []).filter(
          (s: any) => s.project_id === projectId && (s.status === 'running' || s.status === 'detached')
        );
      } catch {}
    }

    if (runningSessions.length > 0) {
      setConfirmClose({ projectId, count: runningSessions.length });
      return;
    }

    cleanupProjectStorage(projectId);
    setProjectTabs((prev) => prev.filter((t) => t.projectId !== projectId));
    if (activeTab === `project-${projectId}`) {
      setActiveTab('home');
    }
  }, [sessions, activeTab]);

  // Voice command: close project
  useEffect(() => {
    const handler = (e: Event) => {
      const { param } = (e as CustomEvent).detail;
      if (param) {
        const normalized = param.toLowerCase().replace(/\s+/g, '');
        const match = projects.find((p) => {
          const pn = p.name.toLowerCase().replace(/\s+/g, '');
          return pn.includes(normalized) || normalized.includes(pn);
        });
        if (match) {
          closeProjectTab(match.id);
        } else {
          console.warn(`[STT] No project matched for close: "${param}"`);
        }
      } else {
        if (activeTab.startsWith('project-')) {
          const projectId = activeTab.replace('project-', '');
          closeProjectTab(projectId);
        }
      }
    };
    window.addEventListener('octoally:voice-close-project', handler);
    return () => window.removeEventListener('octoally:voice-close-project', handler);
  }, [projects, activeTab, closeProjectTab]);

  async function confirmCloseProject() {
    if (!confirmClose) return;
    const { projectId } = confirmClose;

    // Close tab immediately
    cleanupProjectStorage(projectId);
    setProjectTabs((prev) => prev.filter((t) => t.projectId !== projectId));
    if (activeTab === `project-${projectId}`) {
      setActiveTab('home');
    }
    setConfirmClose(null);

    // Kill sessions in the background — fetch fresh list to catch recently created ones
    let runningSessions = sessions.filter(
      (s) => s.project_id === projectId && (s.status === 'running' || s.status === 'detached')
    );
    try {
      const fresh = await api.sessions.list();
      const freshRunning = (fresh.sessions || []).filter(
        (s: any) => s.project_id === projectId && (s.status === 'running' || s.status === 'detached')
      );
      if (freshRunning.length > runningSessions.length) {
        runningSessions = freshRunning;
      }
    } catch {}

    Promise.all(runningSessions.map((s) => api.sessions.kill(s.id).catch(() => {})))
      .then(() => queryClient.invalidateQueries({ queryKey: ['sessions'] }));
  }

  return (
    <div className="h-screen flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <header
        className="flex items-center justify-between px-4 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        <div className="flex items-center gap-2">
          <h1 className="text-base font-bold">
            <span style={{ color: '#ef4444' }}>Octo</span><span style={{ color: 'var(--text-primary)' }}>Ally</span>
          </h1>
          <div className="flex items-center gap-1">
            {desktopVersion && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                title={`Desktop app v${desktopVersion}`}
              >
                app v{desktopVersion}
              </span>
            )}
            {serverVersion && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                title={`Server v${serverVersion}`}
              >
                server v{serverVersion}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowActiveTerminals(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            <Monitor className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Active Sessions</span>
            {activeSessionCount > 0 && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {activeSessionCount}
              </span>
            )}
          </button>
          <GlobalMicButton />
          <GlobalDictationButton />
          <AgentGuideButton />
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 rounded-md transition-colors hover:opacity-80"
            style={{ color: 'var(--text-secondary)', background: 'transparent' }}
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full"
              style={{ background: connected ? 'var(--success)' : 'var(--error)' }}
            />
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
      </header>

      {/* Update available banner */}
      {versionData?.updateAvailable && !updateDismissed && (
        <div
          className="flex items-center justify-between px-4 py-1.5 text-xs shrink-0"
          style={{ background: 'rgba(96, 165, 250, 0.1)', borderBottom: '1px solid rgba(96, 165, 250, 0.2)' }}
        >
          <div className="flex items-center gap-2">
            <ArrowUpCircle className="w-3.5 h-3.5 shrink-0" style={{ color: '#60a5fa' }} />
            <span style={{ color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>OctoAlly v{versionData.latest}</strong>
              {versionData.prerelease && <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: 'rgba(250, 204, 21, 0.15)', color: '#facc15' }}>pre-release</span>}
              {' '}is available
              {versionData.name && <span> &mdash; {versionData.name}</span>}
            </span>
            <button
              onClick={() => triggerUpdate()}
              className="px-2 py-0.5 rounded text-[10px] font-medium transition-colors hover:brightness-110"
              style={{ background: 'rgba(96, 165, 250, 0.2)', color: '#60a5fa' }}
            >
              {updateCopied ? 'Copied — paste in terminal!' : 'Copy Update Command'}
            </button>
            {versionData.url && (
              <a
                href={versionData.url}
                target="_blank"
                rel="noopener noreferrer"
                className="px-2 py-0.5 rounded text-[10px] font-medium"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}
              >
                Release Notes
              </a>
            )}
          </div>
          <button
            onClick={() => setUpdateDismissed(true)}
            className="p-0.5 rounded hover:opacity-80"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* PWA install prompt — only shown in browser (not Electron/Tauri) */}
      <InstallPWA />

      {/* Tab bar */}
      <nav
        className="flex items-center gap-0.5 px-2 py-1 border-b shrink-0 overflow-x-auto"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        {/* Home tab */}
        <button
          onClick={() => { setActiveTab('home'); dismissActiveTerminals(); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors shrink-0"
          style={{
            background: activeTab === 'home' ? 'var(--bg-tertiary)' : 'transparent',
            color: activeTab === 'home' ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          Projects
        </button>

        {/* Divider */}
        {projectTabs.length > 0 && (
          <div
            className="w-px h-5 mx-1 shrink-0"
            style={{ background: 'var(--border)' }}
          />
        )}

        {/* Project tabs */}
        {projectTabs.map((tab) => {
          const tabId = `project-${tab.projectId}`;
          const isActive = activeTab === tabId;

          return (
            <div
              key={tab.projectId}
              className="flex items-center gap-1 rounded-md shrink-0 group"
              style={{ background: isActive ? 'var(--bg-tertiary)' : 'transparent' }}
            >
              <button
                onClick={() => { setActiveTab(tabId); dismissActiveTerminals(); }}
                className="flex items-center gap-1.5 pl-3 pr-1 py-1.5 text-xs font-medium transition-colors max-w-[180px]"
                style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
              >
                <FolderOpen className="w-3 h-3 shrink-0" style={{ color: 'var(--accent)' }} />
                <span className="truncate">{tab.projectName}</span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeProjectTab(tab.projectId);
                }}
                className="p-1 rounded hover:opacity-100 opacity-0 group-hover:opacity-60 transition-opacity mr-1"
                style={{ color: 'var(--text-secondary)' }}
                title="Close tab"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </nav>

      {/* Content — all project tabs stay mounted to preserve terminal state */}
      <main className="flex-1 min-h-0 overflow-hidden relative">
        {showActiveTerminals && (
          <div className="absolute inset-0 z-20">
            <ActiveTerminals
              onBack={dismissActiveTerminals}
              openProjectIds={projectTabs.map((t) => t.projectId)}
              hiddenSessionIds={hiddenSessionIds}
              onGoToSession={(projectId, sessionId) => {
                const tab = projectTabs.find((t) => t.projectId === projectId);
                if (tab) {
                  setActiveTab(`project-${projectId}`);
                } else {
                  const project = projects.find((p) => p.id === projectId);
                  if (project) handleOpenProject(projectId, project.name);
                }
                if (sessionId) setFocusSessionId(sessionId);
                dismissActiveTerminals();
              }}
            />
          </div>
        )}
        <div
          className="h-full"
          style={{ display: activeTab === 'home' ? 'block' : 'none' }}
        >
          <ProjectDashboard
            onOpenProject={handleOpenProject}
            active={activeTab === 'home'}
            onSelectedProjectChange={(id) => { homeSelectedProjectIdRef.current = id; }}
          />
        </div>
        {projectTabs.map((tab) => {
          const tabId = `project-${tab.projectId}`;
          const isActive = activeTab === tabId;
          const project = projects.find((p) => p.id === tab.projectId);
          const projectPath = project?.path || '';
          const projectName = tab?.projectName || project?.name || 'Project';

          return (
            <div
              key={tab.projectId}
              className="h-full"
              style={{ display: isActive ? 'block' : 'none' }}
            >
              {!projectPath ? (
                <div className="h-full flex items-center justify-center">
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    Loading project...
                  </p>
                </div>
              ) : (
                <ProjectView
                  projectId={tab.projectId}
                  projectPath={projectPath}
                  projectName={projectName}
                  active={isActive && !showActiveTerminals}
                  terminalsSuspended={showActiveTerminals}
                  focusSessionId={isActive ? focusSessionId : null}
                  onFocusSessionHandled={() => setFocusSessionId(null)}
                  onHiddenSessionsChange={getHiddenSessionsCallback(tab.projectId)}
                />
              )}
            </div>
          );
        })}
      </main>

      {confirmClose && (
        <CloseTabModal
          label={projectTabs.find((t) => t.projectId === confirmClose.projectId)?.projectName || 'Project'}
          type="project"
          sessionCount={confirmClose.count}
          onHide={() => {
            // Hide the project tab but keep sessions running
            const { projectId } = confirmClose;
            cleanupProjectStorage(projectId);
            setProjectTabs((prev) => prev.filter((t) => t.projectId !== projectId));
            if (activeTab === `project-${projectId}`) {
              setActiveTab('home');
            }
            setConfirmClose(null);
          }}
          onKill={() => confirmCloseProject()}
          onCancel={() => setConfirmClose(null)}
        />
      )}

      <ModelDownloadModal />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showCloseApp && (
        <CloseAppModal
          onChoice={(choice, remember) => {
            setShowCloseApp(false);
            if (choice !== 'cancel') {
              (window as any).electronAPI.invoke('close-dialog-response', choice, remember);
            }
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Dashboard />
      </QueryClientProvider>
    </trpc.Provider>
  );
}
