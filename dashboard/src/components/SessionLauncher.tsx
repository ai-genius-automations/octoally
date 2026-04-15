import { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Project, type RufloAgent } from '../lib/api';
import { Play, Loader2, Bot, TerminalSquare, Globe, Users, X, FolderOpen, GitBranch, Cpu, Activity, FileText, Zap } from 'lucide-react';
import { ClaudeIcon, CodexIcon } from './CliIcons';
import { SessionMicButton } from './SessionMicButton';

interface SessionLauncherProps {
  project: Project;
  onSessionCreated: (sessionId: string, projectName?: string, mode?: 'session' | 'terminal') => void;
  onWebPageCreated?: (url: string) => void;
}

type LaunchMode = 'session' | 'agent' | null;

function TaskModal({
  mode,
  project,
  agents,
  codexReady,
  initialCliType,
  onClose,
  onLaunch,
}: {
  mode: LaunchMode;
  project: Project;
  agents: RufloAgent[];
  codexReady: boolean;
  initialCliType?: 'claude' | 'codex';
  onClose: () => void;
  onLaunch: (task: string, agentType?: string, cliType?: 'claude' | 'codex') => void;
}) {
  const [task, setTask] = useState('');
  const [agentType, setAgentType] = useState(agents[0]?.name || 'coder');
  const [cliType, setCliType] = useState<'claude' | 'codex'>(initialCliType || 'claude');
  const [sessionPrompt, setSessionPrompt] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const sessionPromptVal = (sessionPrompt ?? project.session_prompt ?? '').trim();
  const effectiveTask = task.trim() || 'Start up and ask me what I want you to do and NOTHING ELSE';
  const finalTask = sessionPromptVal
    ? `${effectiveTask}\n\n---\nAdditional Instructions:\n${sessionPromptVal}`
    : effectiveTask;

  const handleLaunch = () => {
    onLaunch(finalTask, mode === 'agent' ? agentType : undefined, cliType);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative rounded-xl border shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 border-b shrink-0"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2">
            {mode === 'agent' ? (
              <Bot className="w-5 h-5" style={{ color: '#ef4444' }} />
            ) : (
              <Zap className="w-5 h-5" style={{ color: '#60a5fa' }} />
            )}
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {mode === 'agent' ? 'Launch Agent' : 'Launch Session'}
            </h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* CLI type selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>CLI:</span>
            <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border)' }}>
              <button
                onClick={() => setCliType('claude')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors"
                style={{
                  background: cliType === 'claude' ? 'var(--accent-bg, rgba(59,130,246,0.15))' : 'var(--bg-primary)',
                  color: cliType === 'claude' ? 'var(--accent)' : 'var(--text-secondary)',
                  borderRight: '1px solid var(--border)',
                }}
              >
                <ClaudeIcon className="w-3.5 h-3.5" />
                Claude
              </button>
              <button
                onClick={() => setCliType('codex')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors"
                style={{
                  background: cliType === 'codex' ? 'var(--accent-bg, rgba(59,130,246,0.15))' : 'var(--bg-primary)',
                  color: cliType === 'codex' ? 'var(--accent)' : 'var(--text-secondary)',
                }}
              >
                <CodexIcon className="w-3.5 h-3.5" />
                Codex
              </button>
            </div>
          </div>

          {/* Info box */}
          <div
            className="rounded-lg border p-4 space-y-2"
            style={{ background: 'var(--bg-primary)', borderColor: mode === 'agent' ? '#ef4444' : '#60a5fa', borderWidth: '1px' }}
          >
            {mode === 'session' ? (
              <>
                <div className="flex items-center gap-2 text-sm font-medium" style={{ color: '#60a5fa' }}>
                  <Zap className="w-4 h-4" />
                  Interactive Session
                </div>
                <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Launches an interactive Claude or Codex session for your project. Best for general development, debugging, and tasks you want to guide directly.
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm font-medium" style={{ color: '#ef4444' }}>
                  <Bot className="w-4 h-4" />
                  Single Specialist Agent
                </div>
                <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Spawns one focused agent with a specific skill set. Best for targeted tasks like code review, testing, security auditing, or documentation where you want deep expertise in a single area.
                </div>
              </>
            )}
          </div>

          {/* Agent type selector */}
          {mode === 'agent' && (
            <div>
              <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Agent Type</h3>
              <select
                value={agentType}
                onChange={(e) => setAgentType(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border text-sm outline-none"
                style={{
                  background: 'var(--bg-primary)',
                  borderColor: 'var(--border)',
                  color: 'var(--text-primary)',
                }}
              >
                {agents.map((a) => (
                  <option key={a.name} value={a.name} title={a.description}>
                    {a.name} — {a.description.slice(0, 60)}{a.description.length > 60 ? '...' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Task input */}
          <div>
            <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Task / Objective</h3>
            <textarea
              ref={textareaRef}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder={`Describe what you want ${mode === 'agent' ? `the ${agentType} agent` : 'Claude'} to do...\n\nLeave empty to use default: "Start up and ask me what I want you to do"`}
              rows={5}
              className="w-full px-4 py-3 rounded-lg border text-sm outline-none resize-y"
              style={{
                background: 'var(--bg-primary)',
                borderColor: 'var(--border)',
                color: 'var(--text-primary)',
                minHeight: '120px',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (cliType === 'codex' && !codexReady) return;
                  handleLaunch();
                }
              }}
            />
            <div className="flex items-center justify-between mt-1.5">
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Cmd+Enter to launch
              </p>
              <SessionMicButton
                small
                onText={(text) => setTask((prev) => prev ? `${prev} ${text}` : text)}
              />
            </div>
          </div>

          {/* Prompt override — switches between CLAUDE.md and AGENTS.md based on CLI toggle */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {cliType === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'} Prompt Override
              </h3>
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Prepended to task as additional instructions
              </span>
            </div>
            <textarea
              value={sessionPrompt ?? project.session_prompt ?? ''}
              onChange={(e) => setSessionPrompt(e.target.value)}
              placeholder={`Additional instructions prepended to the task (supplements your project's ${cliType === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'})...`}
              rows={2}
              className="w-full px-4 py-3 rounded-lg border text-sm outline-none resize-y"
              style={{
                background: 'var(--bg-primary)',
                borderColor: 'var(--border)',
                color: 'var(--text-primary)',
              }}
            />
            {sessionPrompt !== null && (
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                Modified for this session only.
              </p>
            )}
          </div>

          {/* Launch button — inline like OpenClaw's action area */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleLaunch}
              disabled={cliType === 'codex' && !codexReady}
              className="flex items-center gap-2 px-6 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--accent)', color: 'white' }}
              title={cliType === 'codex' && !codexReady ? 'Codex not initialized — re-init RuFlo first' : undefined}
            >
              {mode === 'agent' ? (
                <Users className="w-4 h-4" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              Launch
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SessionLauncher({ project, onSessionCreated, onWebPageCreated }: SessionLauncherProps) {
  const [webUrl, setWebUrl] = useState('');
  const [launchMode, setLaunchMode] = useState<LaunchMode>(null);
  const queryClient = useQueryClient();

  // Fetch available agent types for this project (reads .claude/agents/ — standard Claude Code feature)
  const { data: agentsData } = useQuery({
    queryKey: ['project-agents', project.id],
    queryFn: () => api.projects.rufloAgents(project.id),
    staleTime: 120_000,
  });
  const agents = agentsData?.agents ?? [];

  const createMutation = useMutation({
    mutationFn: (opts: { task: string; mode: 'session' | 'agent'; agentType?: string; cliType?: 'claude' | 'codex' }) => {
      return api.sessions.create({
        project_path: project.path,
        task: opts.task,
        mode: opts.mode,
        agent_type: opts.agentType,
        project_id: project.id,
        cli_type: opts.cliType,
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setLaunchMode(null);
      if (data.session?.id) {
        onSessionCreated(data.session.id, undefined, 'session');
      }
    },
  });

  const terminalMutation = useMutation({
    mutationFn: () => {
      return api.sessions.create({ project_path: project.path, mode: 'terminal', project_id: project.id });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (data.session?.id) {
        onSessionCreated(data.session.id, undefined, 'terminal');
      }
    },
  });

  const handleLaunch = (task: string, agentType?: string, cliType?: 'claude' | 'codex') => {
    const mode = agentType ? 'agent' : 'session';
    createMutation.mutate({ task, mode, agentType, cliType });
  };

  // Fetch git status for project info (may fail if not a git repo)
  const { data: gitData, isError: gitError } = useQuery({
    queryKey: ['git-status', project.path],
    queryFn: () => api.git.status(project.path),
    staleTime: 30_000,
    retry: false,
  });

  // Fetch active sessions count
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
  });
  const activeSessions = (sessionsData?.sessions || []).filter(
    (s) => s.project_id === project.id && (s.status === 'running' || s.status === 'detached')
  );

  const btnBase = "flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 border whitespace-nowrap min-w-0";

  return (
    <div className="h-full overflow-y-auto p-6 pt-8">
      <div className="w-full max-w-4xl mx-auto space-y-6">
        {/* Logo */}
        <div className="flex justify-center">
          <img src="/octoally-icon.png" alt="" className="w-20 h-20 object-contain" />
        </div>
        {/* Project info card */}
        <div
          className="rounded-xl border p-5"
          style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
        >
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                {project.name}
              </h3>
              {project.description && (
                <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  {project.description}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--success)' }}
              >
                <Cpu className="w-3 h-3" />
                Ready
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <FolderOpen className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Path</span>
              </div>
              <p className="text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }} title={project.path}>
                {project.path.replace(/^\/home\/[^/]+/, '~')}
              </p>
            </div>
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <GitBranch className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Branch</span>
              </div>
              {gitError ? (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>No git repo</p>
              ) : (
                <p className="text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                  {gitData?.branch || '...'}
                  {gitData && (gitData.ahead > 0 || gitData.behind > 0) && (
                    <span style={{ color: 'var(--warning)' }}>
                      {gitData.ahead > 0 ? ` +${gitData.ahead}` : ''}
                      {gitData.behind > 0 ? ` -${gitData.behind}` : ''}
                    </span>
                  )}
                </p>
              )}
            </div>
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Activity className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Sessions</span>
              </div>
              <p className="text-xs" style={{ color: activeSessions.length > 0 ? 'var(--success)' : 'var(--text-primary)' }}>
                {activeSessions.length} active
              </p>
              {gitData?.files && gitData.files.length > 0 && (
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--warning)' }}>{gitData.files.length} file{gitData.files.length !== 1 ? 's' : ''} changed</p>
              )}
            </div>
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <FileText className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Agents</span>
              </div>
              <p className="text-xs" style={{ color: agents.length > 0 ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                {agents.length > 0 ? `${agents.length} available` : 'None'}
              </p>
            </div>
          </div>
        </div>

        {/* Launch buttons */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setLaunchMode('session')}
            disabled={createMutation.isPending}
            className={btnBase}
            style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
          >
            {createMutation.isPending && launchMode === 'session' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Zap className="w-4 h-4" style={{ color: '#60a5fa' }} />
            )}
            Launch Session
          </button>
          <button
            onClick={() => setLaunchMode('agent')}
            disabled={createMutation.isPending}
            className={btnBase}
            style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
          >
            {createMutation.isPending && launchMode === 'agent' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Bot className="w-4 h-4" style={{ color: '#ef4444' }} />
            )}
            Launch Agent
          </button>
          <button
            onClick={() => terminalMutation.mutate()}
            disabled={terminalMutation.isPending}
            className={btnBase}
            style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
            title="Open a plain terminal in the project directory"
          >
            {terminalMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <TerminalSquare className="w-4 h-4" style={{ color: '#f59e0b' }} />
            )}
            Launch Terminal
          </button>
        </div>

        {/* Web page section */}
        {onWebPageCreated && (() => {
          const defaultUrl = project.default_web_url || 'http://localhost:3000';
          const resolvedUrl = webUrl.trim() || defaultUrl;
          return (
            <div
              className="rounded-xl border p-4 space-y-3"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--bg-secondary)',
              }}
            >
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Open Web Page
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={webUrl}
                  onChange={(e) => setWebUrl(e.target.value)}
                  placeholder={defaultUrl}
                  className="flex-1 px-3 py-2 rounded-lg border text-sm outline-none"
                  style={{
                    background: 'var(--bg-primary)',
                    borderColor: 'var(--border)',
                    color: 'var(--text-primary)',
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onWebPageCreated(resolvedUrl);
                      setWebUrl('');
                    }
                  }}
                />
                <button
                  onClick={() => {
                    onWebPageCreated(resolvedUrl);
                    setWebUrl('');
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  <Globe className="w-4 h-4" />
                  Open
                </button>
              </div>
            </div>
          );
        })()}

        {(createMutation.isError || terminalMutation.isError) && (
          <p className="text-sm" style={{ color: 'var(--error)' }}>
            {((createMutation.error || terminalMutation.error) as Error).message}
          </p>
        )}

        {/* Task modal */}
        {launchMode && (
          <TaskModal
            mode={launchMode}
            project={project}
            agents={agents}
            codexReady={true}
            onClose={() => setLaunchMode(null)}
            onLaunch={handleLaunch}
          />
        )}

      </div>
    </div>
  );
}
