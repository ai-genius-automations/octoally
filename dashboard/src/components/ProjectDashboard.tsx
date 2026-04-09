import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Project } from '../lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Plus,
  FolderOpen,
  ChevronRight,
  ArrowUp,

  Trash2,
  X,
  Pencil,
  Save,
  Loader2,
  Folder,
  ChevronLeft,
  Eye,
  RefreshCw,
  GitBranch,
  ChevronDown,
  Lock,
  Globe,
  Github,
  Terminal,
  Zap,
  Bot,
  TerminalSquare,
  Search,
  AlertTriangle,
} from 'lucide-react';
import { ClaudeIcon, CodexIcon } from './CliIcons';
import { ConfirmModal } from './ConfirmModal';
import { RufloDeprecationModal } from './RufloDeprecationModal';
import { StatuslinePromptModal } from './StatuslinePromptModal';

interface ProjectDashboardProps {
  onOpenProject: (projectId: string, projectName: string, quickLaunch?: 'session' | 'agent' | 'terminal', cliType?: 'claude' | 'codex') => void;
}

type ViewState = { mode: 'list' } | { mode: 'add' } | { mode: 'edit'; project: Project };

function FolderBrowser({ onSelect }: { onSelect: (path: string, folderName: string) => void }) {
  const [browsePath, setBrowsePath] = useState<string | undefined>(undefined);

  const { data, isLoading } = useQuery({
    queryKey: ['browse', browsePath],
    queryFn: () => api.projects.browse(browsePath),
  });

  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-primary)' }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 text-xs border-b"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
      >
        {data?.parent && (
          <button
            onClick={() => setBrowsePath(data.parent!)}
            className="p-0.5 rounded hover:bg-white/10"
            title="Go up"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
        )}
        <span className="truncate font-mono">{data?.path || '~'}</span>
        <button
          onClick={() => {
            if (data?.path) onSelect(data.path, data.folderName);
          }}
          className="ml-auto px-2 py-1 rounded text-xs font-medium shrink-0"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          Select This Folder
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--accent)' }} />
          </div>
        ) : data?.dirs.length === 0 ? (
          <div className="py-4 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>
            No subdirectories
          </div>
        ) : (
          data?.dirs.map((dir) => (
            <button
              key={dir.path}
              onClick={() => setBrowsePath(dir.path)}
              onDoubleClick={() => onSelect(dir.path, dir.name)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-white/5 text-left"
              style={{ color: 'var(--text-primary)' }}
            >
              <FolderOpen className="w-4 h-4 shrink-0" style={{ color: 'var(--accent)' }} />
              <span className="truncate">{dir.name}</span>
              {dir.hasChildren && (
                <ChevronRight className="w-3 h-3 ml-auto shrink-0" style={{ color: 'var(--text-secondary)' }} />
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function prevFolderName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '';
}

const inputStyle = {
  background: 'var(--bg-tertiary)',
  borderColor: 'var(--border)',
  color: 'var(--text-primary)',
};

const inputClass = 'w-full px-4 py-2.5 rounded-lg border text-sm outline-none';

function ProjectForm({
  mode,
  project,
  onSubmit,
  onCancel,
}: {
  mode: 'add' | 'edit';
  project?: Project;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();

  const [name, setName] = useState(project?.name || '');
  const [path, setPath] = useState(project?.path || '');
  const [description, setDescription] = useState(project?.description || '');
  const [projectColor, setProjectColor] = useState(project?.color || '');
  const [defaultWebUrl, setDefaultWebUrl] = useState(project?.default_web_url || '');
  const [sessionPrompt, setSessionPrompt] = useState(project?.session_prompt || '');
  const [openclawPrompt, setOpenclawPrompt] = useState(project?.openclaw_prompt || '');
  const [claudeMd, setClaudeMd] = useState('');
  const [agentsMd, setAgentsMd] = useState('');
  const [settingsJson, setSettingsJson] = useState('');
  const [showBrowser, setShowBrowser] = useState(false);
  const [claudeMdPreview, setClaudeMdPreview] = useState(false);
  const [agentsMdPreview, setAgentsMdPreview] = useState(false);
  const [error, setError] = useState('');

  // Track initial loaded values to detect changes
  const [initialClaudeMd, setInitialClaudeMd] = useState('');
  const [initialAgentsMd, setInitialAgentsMd] = useState('');
  const [initialSettingsJson, setInitialSettingsJson] = useState('');

  const projectPath = mode === 'edit' ? project!.path : path;

  // Load CLAUDE.md (edit mode only)
  const claudeMdQuery = useQuery({
    queryKey: ['file-read', projectPath, 'CLAUDE.md'],
    queryFn: () => api.files.read(`${projectPath}/CLAUDE.md`),
    enabled: !!projectPath && mode === 'edit',
    retry: false,
  });

  // Load AGENTS.md (edit mode only — Codex config)
  const agentsMdQuery = useQuery({
    queryKey: ['file-read', projectPath, 'AGENTS.md'],
    queryFn: () => api.files.read(`${projectPath}/AGENTS.md`),
    enabled: !!projectPath && mode === 'edit',
    retry: false,
  });

  // Load .claude/settings.json (edit mode only)
  const settingsQuery = useQuery({
    queryKey: ['file-read', projectPath, '.claude/settings.json'],
    queryFn: () => api.files.read(`${projectPath}/.claude/settings.json`),
    enabled: !!projectPath && mode === 'edit',
    retry: false,
  });

  // Sync loaded file contents into state
  useEffect(() => {
    if (claudeMdQuery.isSuccess) {
      setClaudeMd(claudeMdQuery.data.content);
      setInitialClaudeMd(claudeMdQuery.data.content);
    } else if (claudeMdQuery.isError) {
      setClaudeMd('');
      setInitialClaudeMd('');
    }
  }, [claudeMdQuery.isSuccess, claudeMdQuery.isError, claudeMdQuery.data?.content]);

  useEffect(() => {
    if (agentsMdQuery.isSuccess) {
      setAgentsMd(agentsMdQuery.data.content);
      setInitialAgentsMd(agentsMdQuery.data.content);
    } else if (agentsMdQuery.isError) {
      setAgentsMd('');
      setInitialAgentsMd('');
    }
  }, [agentsMdQuery.isSuccess, agentsMdQuery.isError, agentsMdQuery.data?.content]);

  useEffect(() => {
    if (settingsQuery.isSuccess) {
      setSettingsJson(settingsQuery.data.content);
      setInitialSettingsJson(settingsQuery.data.content);
    } else if (settingsQuery.isError) {
      setSettingsJson('');
      setInitialSettingsJson('');
    }
  }, [settingsQuery.isSuccess, settingsQuery.isError, settingsQuery.data?.content]);

  const createMutation = useMutation({
    mutationFn: () =>
      api.projects.create({ name, path, description, default_web_url: defaultWebUrl || undefined, color: projectColor || undefined }),
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onSubmit();
      if (data.project?.id) {
        setTimeout(() => {
          const openEvent = new CustomEvent('octoally:open-project', {
            detail: { id: data.project.id, name: data.project.name },
          });
          window.dispatchEvent(openEvent);
        }, 0);
      }
    },
    onError: (err: Error) => setError(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      const fields: Record<string, string | number | null | undefined> = {};
      if (name !== project!.name) fields.name = name;
      if (description !== (project!.description || '')) fields.description = description;
      if (defaultWebUrl !== (project!.default_web_url || '')) fields.default_web_url = defaultWebUrl || null;
      if (sessionPrompt !== (project!.session_prompt || ''))
        fields.session_prompt = sessionPrompt || null;
      if (openclawPrompt !== (project!.openclaw_prompt || ''))
        fields.openclaw_prompt = openclawPrompt || null;
      // Always send color to ensure save works even if only color changed
      fields.color = projectColor || '';
      return api.projects.update(project!.id, fields as any);
    },
    onSuccess: async () => {
      const savePath = project!.path;
      try {
        if (claudeMd !== initialClaudeMd) await api.files.write(`${savePath}/CLAUDE.md`, claudeMd);
        if (agentsMd !== initialAgentsMd) await api.files.write(`${savePath}/AGENTS.md`, agentsMd);
        if (settingsJson !== initialSettingsJson)
          await api.files.write(`${savePath}/.claude/settings.json`, settingsJson);
      } catch {
        // best-effort file writes
      }
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onSubmit();
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSave = async () => {
    setError('');
    if (mode === 'edit') { updateMutation.mutate(); return; }
    createMutation.mutate();
  };

  const handleFolderSelect = (selectedPath: string, folderName: string) => {
    setPath(selectedPath);
    if (!name || name === prevFolderName(path)) setName(folderName);
    setShowBrowser(false);
  };

  const filesLoading = mode === 'edit' && (!!projectPath) && (claudeMdQuery.isLoading || agentsMdQuery.isLoading || settingsQuery.isLoading);

  const isPending = createMutation.isPending || updateMutation.isPending;

  const [createRepo, setCreateRepo] = useState(false);
  const [repoName, setRepoName] = useState('');
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [repoBranch, setRepoBranch] = useState('main');
  const [repoOwner, setRepoOwner] = useState('');
  const [repoCreating, setRepoCreating] = useState(false);
  const [repoResult, setRepoResult] = useState<{ ok: boolean; message: string } | null>(null);

  const { data: accountsData } = useQuery({
    queryKey: ['gh-accounts'],
    queryFn: () => api.git.ghAccounts(),
  });
  const ghAccounts = accountsData?.accounts || [];

  // Auto-set repo name and owner when path changes
  useEffect(() => {
    if (projectPath) {
      const folder = projectPath.split('/').pop() || '';
      if (!repoName) setRepoName(folder);
    }
  }, [projectPath, repoName]);

  useEffect(() => {
    if (ghAccounts.length > 0 && !repoOwner) setRepoOwner(ghAccounts[0]);
  }, [ghAccounts, repoOwner]);

  // Check git status for the project path
  const { data: gitStatusData } = useQuery({
    queryKey: ['git-status', projectPath],
    queryFn: () => api.git.status(projectPath).catch(() => null),
    enabled: !!projectPath,
    retry: false,
  });

  const hasGitRepo = gitStatusData !== null && gitStatusData !== undefined;
  const hasRemote = hasGitRepo && !!gitStatusData?.remoteUrl;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto" style={{ maxWidth: '1100px' }}>
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg hover:bg-white/10"
            style={{ color: 'var(--text-secondary)' }}
            title="Back to projects"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            {mode === 'add' ? 'Add Project' : `Edit — ${project!.name}`}
          </h2>
        </div>

        <div
          className="rounded-xl border p-6"
          style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
        >
          <div className="flex flex-col gap-4">
            {/* Folder Path — add mode only */}
            {mode === 'add' && (
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Folder Path</label>
                <div className="flex gap-2">
                  <input
                    value={path}
                    onChange={(e) => {
                      const val = e.target.value;
                      const folderName = prevFolderName(val);
                      setPath(val);
                      if (!name || name === prevFolderName(path)) setName(folderName);
                    }}
                    placeholder="/home/user/projects/myapp"
                    className="flex-1 px-4 py-2.5 rounded-lg border text-sm outline-none font-mono"
                    style={inputStyle}
                  />
                  <button
                    onClick={() => setShowBrowser(!showBrowser)}
                    className="px-3 py-2.5 rounded-lg border text-sm flex items-center gap-1.5"
                    style={{
                      background: showBrowser ? 'var(--accent)' : 'var(--bg-tertiary)',
                      borderColor: 'var(--border)',
                      color: showBrowser ? 'white' : 'var(--text-secondary)',
                    }}
                  >
                    <FolderOpen className="w-4 h-4" />
                    Browse
                  </button>
                </div>
              </div>
            )}

            {/* Folder Browser */}
            {mode === 'add' && showBrowser && (
              <div>
                <FolderBrowser onSelect={handleFolderSelect} />
              </div>
            )}

            {/* Edit mode: show path as read-only */}
            {mode === 'edit' && (
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Path</label>
                <div
                  className="px-4 py-2.5 rounded-lg border text-sm font-mono"
                  style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                >
                  {project!.path}
                </div>
              </div>
            )}

            {/* Row: Name + Description side by side */}
            <div className="grid grid-cols-2 gap-x-6">
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Project Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Project"
                  className={inputClass}
                  style={inputStyle}
                />
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Description</label>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description of this project"
                  className={inputClass}
                  style={inputStyle}
                />
              </div>
            </div>

            {/* Card Color */}
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Card Color</label>
              <div className="flex items-center gap-2">
                {['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1'].map((c) => {
                  const defaultColors = ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1'];
                  const hash = name.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0);
                  const isActive = projectColor ? projectColor === c : c === defaultColors[hash % defaultColors.length];
                  return (
                    <button
                      key={c}
                      onClick={() => setProjectColor(c)}
                      className="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110"
                      style={{
                        background: c,
                        borderColor: isActive ? 'white' : 'transparent',
                        boxShadow: isActive ? `0 0 0 2px ${c}` : 'none',
                      }}
                    />
                  );
                })}
              </div>
            </div>

            {/* Default Web URL */}
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Default Web Page URL</label>
              <input
                value={defaultWebUrl}
                onChange={(e) => setDefaultWebUrl(e.target.value)}
                placeholder="http://localhost:3000 (default for Vite projects)"
                className={inputClass}
                style={inputStyle}
              />
            </div>

            {/* GitHub Repository */}
            <div
              className="rounded-lg border p-4 flex flex-col gap-3"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
                <div className="flex items-center gap-2">
                  <Github className="w-4 h-4" style={{ color: 'var(--text-primary)' }} />
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>GitHub Repository</span>
                </div>

                {!projectPath ? (
                  <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                    Select a folder path first.
                  </p>
                ) : hasRemote ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5 text-[10px]" style={{ color: '#22c55e' }}>
                      <GitBranch className="w-3 h-3" />
                      <span className="font-medium">{gitStatusData!.branch}</span>
                    </div>
                    <p className="text-[10px] font-mono truncate" style={{ color: 'var(--text-secondary)' }}>
                      {gitStatusData!.remoteUrl}
                    </p>
                  </div>
                ) : hasGitRepo ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5 text-[10px]" style={{ color: '#f59e0b' }}>
                      <GitBranch className="w-3 h-3" />
                      <span className="font-medium">{gitStatusData!.branch}</span>
                      <span style={{ color: 'var(--text-secondary)' }}>(local only)</span>
                    </div>
                    {!createRepo && (
                      <button
                        onClick={() => setCreateRepo(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium"
                        style={{ background: '#3b82f622', color: '#3b82f6', border: '1px solid #3b82f644' }}
                      >
                        <Github className="w-3 h-3" /> Create GitHub Remote
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                      No git repository found. Create one with a GitHub remote.
                    </p>
                    {!createRepo && (
                      <button
                        onClick={() => setCreateRepo(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium"
                        style={{ background: '#3b82f622', color: '#3b82f6', border: '1px solid #3b82f644' }}
                      >
                        <Github className="w-3 h-3" /> Create Repository
                      </button>
                    )}
                  </>
                )}

                {createRepo && (
                  <div className="flex flex-col gap-2.5 pt-1" style={{ borderTop: '1px solid var(--border)' }}>
                    <div>
                      <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Account</label>
                      {ghAccounts.length === 0 ? (
                        <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                          No accounts. Run <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', fontSize: '9px' }}>gh auth login</code>
                        </p>
                      ) : (
                        <select
                          value={repoOwner}
                          onChange={(e) => setRepoOwner(e.target.value)}
                          className="w-full px-2 py-1.5 rounded text-xs"
                          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                        >
                          {ghAccounts.map(a => <option key={a} value={a}>{a}</option>)}
                        </select>
                      )}
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Repository Name</label>
                      <input
                        value={repoName}
                        onChange={(e) => setRepoName(e.target.value)}
                        className="w-full px-2 py-1.5 rounded text-xs"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Default Branch</label>
                      <input
                        value={repoBranch}
                        onChange={(e) => setRepoBranch(e.target.value)}
                        className="w-full px-2 py-1.5 rounded text-xs"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Visibility</label>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setRepoPrivate(true)}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[10px] font-medium flex-1 justify-center"
                          style={{
                            background: repoPrivate ? '#f59e0b22' : 'var(--bg-tertiary)',
                            color: repoPrivate ? '#f59e0b' : 'var(--text-secondary)',
                            border: `1px solid ${repoPrivate ? '#f59e0b44' : 'var(--border)'}`,
                          }}
                        >
                          <Lock className="w-3 h-3" /> Private
                        </button>
                        <button
                          onClick={() => setRepoPrivate(false)}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[10px] font-medium flex-1 justify-center"
                          style={{
                            background: !repoPrivate ? '#22c55e22' : 'var(--bg-tertiary)',
                            color: !repoPrivate ? '#22c55e' : 'var(--text-secondary)',
                            border: `1px solid ${!repoPrivate ? '#22c55e44' : 'var(--border)'}`,
                          }}
                        >
                          <Globe className="w-3 h-3" /> Public
                        </button>
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        if (!projectPath || repoCreating || !repoName.trim()) return;
                        setRepoCreating(true);
                        setRepoResult(null);
                        try {
                          await api.git.createRepo({
                            path: projectPath,
                            name: repoName.trim(),
                            owner: repoOwner || undefined,
                            private: repoPrivate,
                            defaultBranch: repoBranch.trim() || 'main',
                          });
                          setRepoResult({ ok: true, message: 'Repository created successfully!' });
                          queryClient.invalidateQueries({ queryKey: ['git-status', projectPath] });
                          setCreateRepo(false);
                        } catch (err: any) {
                          setRepoResult({ ok: false, message: err.message || 'Failed to create repository' });
                        } finally {
                          setRepoCreating(false);
                        }
                      }}
                      disabled={repoCreating || !repoName.trim() || ghAccounts.length === 0}
                      className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium w-full"
                      style={{
                        background: repoCreating ? '#3b82f680' : '#3b82f6',
                        color: '#fff',
                        opacity: (!repoName.trim() || ghAccounts.length === 0) ? 0.5 : 1,
                      }}
                    >
                      {repoCreating ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating...</>
                      ) : (
                        <><Github className="w-3.5 h-3.5" /> Create Repository</>
                      )}
                    </button>
                    <button
                      onClick={() => setCreateRepo(false)}
                      className="text-[10px] text-center"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {repoResult && (
                  <div
                    className="text-[10px] px-2 py-1.5 rounded"
                    style={{
                      background: repoResult.ok ? '#22c55e15' : '#ef444415',
                      color: repoResult.ok ? '#22c55e' : '#ef4444',
                      border: `1px solid ${repoResult.ok ? '#22c55e33' : '#ef444433'}`,
                    }}
                  >
                    {repoResult.message}
                  </div>
                )}
            </div>

            {/* ===== Edit mode: Prompts + Files section ===== */}
            {mode === 'edit' && (
              <div className="flex flex-col gap-4 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                {/* Row 1: Session prompts — 2 columns */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col">
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Session Prompt</label>
                    <textarea
                      value={sessionPrompt}
                      onChange={(e) => setSessionPrompt(e.target.value)}
                      placeholder="System instructions prepended to every task for this project..."
                      className={`${inputClass} resize-y flex-1`}
                      style={{ ...inputStyle, minHeight: '80px' }}
                    />
                  </div>
                  <div className="flex flex-col">
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>OpenClaw Session Prompt</label>
                    <textarea
                      value={openclawPrompt}
                      onChange={(e) => setOpenclawPrompt(e.target.value)}
                      placeholder="Additional instructions included when running via OpenClaw..."
                      className={`${inputClass} resize-y flex-1`}
                      style={{ ...inputStyle, minHeight: '80px' }}
                    />
                  </div>
                </div>

                {/* Row 2: CLAUDE.md + AGENTS.md — side by side */}
                <div className="grid grid-cols-2 gap-4">
                  {/* CLAUDE.md */}
                  <div className="flex flex-col">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                        <ClaudeIcon className="w-3 h-3" style={{ color: '#D97757' }} />
                        CLAUDE.md <span className="font-normal opacity-60">(Claude instructions)</span>
                        {filesLoading && <Loader2 className="w-3 h-3 inline ml-1 animate-spin" />}
                      </label>
                      {projectPath && claudeMd && (
                        <button
                          type="button"
                          onClick={() => setClaudeMdPreview(true)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-xs hover:bg-white/10"
                          style={{ color: 'var(--text-secondary)' }}
                          title="Preview rendered markdown"
                        >
                          <Eye className="w-3 h-3" />
                          Preview
                        </button>
                      )}
                    </div>
                    <textarea
                      value={claudeMd}
                      onChange={(e) => setClaudeMd(e.target.value)}
                      placeholder="Claude Code project instructions — file will be created on save"
                      className={`${inputClass} resize-y font-mono text-xs flex-1`}
                      style={{ ...inputStyle, minHeight: '220px' }}
                    />
                    {claudeMdPreview && (
                      <div
                        className="fixed inset-0 z-50 flex items-center justify-center p-8"
                        style={{ background: 'rgba(0,0,0,0.6)' }}
                        onClick={() => setClaudeMdPreview(false)}
                      >
                        <div
                          className="w-full rounded-xl border flex flex-col"
                          style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', maxWidth: '900px', height: 'calc(100vh - 80px)' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
                            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>CLAUDE.md Preview</span>
                            <button onClick={() => setClaudeMdPreview(false)} className="p-1 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}>
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="flex-1 overflow-y-auto px-8 py-6">
                            <div className="markdown-preview" style={{ color: 'var(--text-primary)' }}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{claudeMd || '*No content*'}</ReactMarkdown>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* AGENTS.md */}
                  <div className="flex flex-col">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                        <CodexIcon className="w-3 h-3" style={{ color: '#7A9DFF' }} />
                        AGENTS.md <span className="font-normal opacity-60">(Codex instructions)</span>
                        {filesLoading && <Loader2 className="w-3 h-3 inline ml-1 animate-spin" />}
                      </label>
                      {projectPath && agentsMd && (
                        <button
                          type="button"
                          onClick={() => setAgentsMdPreview(true)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-xs hover:bg-white/10"
                          style={{ color: 'var(--text-secondary)' }}
                          title="Preview rendered markdown"
                        >
                          <Eye className="w-3 h-3" />
                          Preview
                        </button>
                      )}
                    </div>
                    <textarea
                      value={agentsMd}
                      onChange={(e) => setAgentsMd(e.target.value)}
                      placeholder="Codex project instructions — file will be created on save"
                      className={`${inputClass} resize-y font-mono text-xs flex-1`}
                      style={{ ...inputStyle, minHeight: '220px' }}
                    />
                    {agentsMdPreview && (
                      <div
                        className="fixed inset-0 z-50 flex items-center justify-center p-8"
                        style={{ background: 'rgba(0,0,0,0.6)' }}
                        onClick={() => setAgentsMdPreview(false)}
                      >
                        <div
                          className="w-full rounded-xl border flex flex-col"
                          style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', maxWidth: '900px', height: 'calc(100vh - 80px)' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
                            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>AGENTS.md Preview</span>
                            <button onClick={() => setAgentsMdPreview(false)} className="p-1 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}>
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="flex-1 overflow-y-auto px-8 py-6">
                            <div className="markdown-preview" style={{ color: 'var(--text-primary)' }}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{agentsMd || '*No content*'}</ReactMarkdown>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Row 3: .claude/settings.json — full width */}
                <div className="flex flex-col">
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    .claude/settings.json
                    {filesLoading && <Loader2 className="w-3 h-3 inline ml-1 animate-spin" />}
                  </label>
                  <textarea
                    value={settingsJson}
                    onChange={(e) => setSettingsJson(e.target.value)}
                    placeholder="File will be created on save"
                    className={`${inputClass} resize-y font-mono text-xs`}
                    style={{ ...inputStyle, minHeight: '180px' }}
                  />
                </div>
              </div>
            )}

            {/* Reset Project — always available in edit mode */}
            {mode === 'edit' && (() => {
              const [resetting, setResetting] = useState(false);
              const [resetResult, setResetResult] = useState<string | null>(null);
              return (
                <div
                  className="flex items-center justify-between px-4 py-3 rounded-lg border"
                  style={{ borderColor: '#f59e0b40', background: '#f59e0b10' }}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium" style={{ color: '#f59e0b' }}>Reset Project</p>
                    <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                      Removes .claude/, .codex/, CLAUDE.md, AGENTS.md, and all config files. Claude/Codex will re-initialize with default settings on next use.
                    </p>
                    {resetResult && (
                      <p className="text-[10px] mt-1" style={{ color: resetResult.startsWith('Error') ? '#ef4444' : '#22c55e' }}>
                        {resetResult}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={async (e) => {
                      e.preventDefault();
                      if (!confirm(
                        'This will delete ALL Claude and Codex settings for this project (.claude/, .codex/, CLAUDE.md, AGENTS.md).\n\n' +
                        'Claude/Codex will ask you to trust the folder again on next use.\n\nContinue?'
                      )) return;
                      setResetting(true);
                      setResetResult(null);
                      try {
                        const result = await api.projects.rufloUninstall(project!.id);
                        // Reset color to blue and clear prompts
                        await api.projects.update(project!.id, {
                          session_prompt: null,
                          openclaw_prompt: null,
                          color: '#3b82f6',
                        });
                        queryClient.invalidateQueries({ queryKey: ['projects'] });
                        queryClient.invalidateQueries({ queryKey: ['ruflo-status'] });
                        queryClient.invalidateQueries({ queryKey: ['ruflo-disposition'] });
                        const pp = project!.path;
                        await Promise.all([
                          queryClient.invalidateQueries({ queryKey: ['file-read', pp, 'CLAUDE.md'] }),
                          queryClient.invalidateQueries({ queryKey: ['file-read', pp, 'AGENTS.md'] }),
                          queryClient.invalidateQueries({ queryKey: ['file-read', pp, '.claude/settings.json'] }),
                        ]);
                        setClaudeMd('');
                        setInitialClaudeMd('');
                        setSettingsJson('');
                        setInitialSettingsJson('');
                        setAgentsMd('');
                        setInitialAgentsMd('');
                        setSessionPrompt('');
                        setOpenclawPrompt('');
                        setProjectColor('#3b82f6');
                        setResetResult(result.cleaned.length > 0
                          ? `Reset complete — removed ${result.cleaned.length} item(s).`
                          : 'Reset complete — project was already clean.');
                      } catch (err: any) {
                        setResetResult(`Error: ${err.message || 'Reset failed'}`);
                      } finally {
                        setResetting(false);
                      }
                    }}
                    disabled={resetting}
                    className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium"
                    style={{ background: '#f59e0b', color: '#000', border: 'none', opacity: resetting ? 0.6 : 1 }}
                  >
                    {resetting ? 'Resetting...' : 'Reset'}
                  </button>
                </div>
              );
            })()}

            {/* Error */}
            {error && (
              <p className="text-xs" style={{ color: 'var(--error)' }}>{error}</p>
            )}

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={handleSave}
                disabled={isPending || !name || (mode === 'add' && !path)}
                className="flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                <Save className="w-4 h-4" />
                {isPending ? 'Saving...' : mode === 'add' ? 'Add Project' : 'Save Changes'}
              </button>
              <button
                onClick={onCancel}
                className="px-6 py-2.5 rounded-lg border text-sm font-medium"
                style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
              >
                Cancel
              </button>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

function GitInfoBadge({ projectPath }: { projectPath: string }) {
  const queryClient = useQueryClient();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<{ name: string; isRemote: boolean } | null>(null);
  const [switching, setSwitching] = useState(false);
  const [createRepoOpen, setCreateRepoOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });

  // Position the portal dropdown under the button
  const updatePos = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    updatePos();
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      document.removeEventListener('mousedown', handler);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [dropdownOpen, updatePos]);

  const { data: gitStatus } = useQuery({
    queryKey: ['git-status', projectPath],
    queryFn: () => api.git.status(projectPath).catch(() => null),
    retry: false,
  });

  const { data: branchData } = useQuery({
    queryKey: ['git-branches', projectPath],
    queryFn: () => api.git.branches(projectPath),
    enabled: dropdownOpen && gitStatus !== null,
    staleTime: 10_000,
  });

  // gitStatus is null = not a git repo, undefined = still loading
  if (gitStatus === undefined) return null;

  if (gitStatus === null) {
    return (
      <>
        <button
          onClick={() => setCreateRepoOpen(true)}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] w-full"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
        >
          <Github className="w-3 h-3 shrink-0" style={{ opacity: 0.5 }} />
          <span className="truncate">No git repo</span>
          <Plus className="w-3 h-3 ml-auto shrink-0" style={{ opacity: 0.7 }} />
        </button>
        {createRepoOpen && (
          <CreateRepoModal
            projectPath={projectPath}
            onClose={() => setCreateRepoOpen(false)}
            onCreated={() => {
              setCreateRepoOpen(false);
              queryClient.invalidateQueries({ queryKey: ['git-status', projectPath] });
            }}
          />
        )}
      </>
    );
  }

  const remoteUrl = gitStatus.remoteUrl;
  const repoParts = remoteUrl
    ? remoteUrl.replace(/.*[:/]([^/]+\/[^/]+?)(?:\.git)?$/, '$1').split('/')
    : null;
  const owner = repoParts?.[0] || null;
  const repo = repoParts?.[1] || null;

  const localBranches = (branchData?.branches || []).filter(b => !b.remote && b.name !== gitStatus.branch);
  const remoteBranches = (branchData?.branches || []).filter(b => b.remote && b.name !== `origin/${gitStatus.branch}`);

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="flex flex-col gap-0.5 px-2 py-1.5 rounded text-[10px] w-full text-left"
        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
      >
        {/* Line 1: Owner / account */}
        <div className="flex items-center gap-1 w-full">
          <Github className="w-3 h-3 shrink-0" style={{ color: 'var(--text-secondary)', opacity: 0.6 }} />
          <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
            {owner || (remoteUrl ? 'unknown' : 'local only')}
          </span>
          <ChevronDown className="w-3 h-3 ml-auto shrink-0" style={{ color: 'var(--text-secondary)', opacity: 0.5 }} />
        </div>
        {/* Line 2: Repo - Branch */}
        <div className="flex items-center gap-1 w-full">
          <GitBranch className="w-3 h-3 shrink-0" style={{ color: '#22c55e' }} />
          {repo ? (
            <span className="truncate">
              <span style={{ color: 'var(--text-secondary)' }}>{repo}</span>
              <span style={{ color: 'var(--text-secondary)', opacity: 0.4 }}> / </span>
              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{gitStatus.branch}</span>
            </span>
          ) : (
            <span className="truncate font-medium" style={{ color: 'var(--text-primary)' }}>{gitStatus.branch}</span>
          )}
        </div>
      </button>

      {/* Portal dropdown for branch switching */}
      {dropdownOpen && createPortal(
        <div
          ref={dropdownRef}
          className="fixed rounded-lg border shadow-xl overflow-hidden"
          style={{
            background: 'var(--bg-primary)',
            borderColor: 'var(--border)',
            maxHeight: '280px',
            overflowY: 'auto',
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: Math.max(dropdownPos.width, 220),
            zIndex: 9999,
          }}
        >
          {/* Current branch */}
          <div className="px-3 py-1.5 text-[10px] font-semibold" style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
            Current: {gitStatus.branch}
          </div>

          {!branchData ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 className="w-3 h-3 animate-spin" style={{ color: 'var(--text-secondary)' }} />
            </div>
          ) : (
            <>
              {localBranches.length > 0 && (
                <>
                  <div className="px-3 py-1 text-[9px] font-semibold uppercase" style={{ color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }}>
                    Local
                  </div>
                  {localBranches.map(b => (
                    <button
                      key={b.name}
                      onClick={() => { setSwitchTarget({ name: b.name, isRemote: false }); setDropdownOpen(false); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] w-full text-left hover:bg-white/5"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      <GitBranch className="w-3 h-3 shrink-0" style={{ color: 'var(--text-secondary)' }} />
                      <span className="truncate">{b.name}</span>
                    </button>
                  ))}
                </>
              )}
              {remoteBranches.length > 0 && (
                <>
                  <div className="px-3 py-1 text-[9px] font-semibold uppercase" style={{ color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }}>
                    Remote
                  </div>
                  {remoteBranches.map(b => (
                    <button
                      key={b.name}
                      onClick={() => { setSwitchTarget({ name: b.name, isRemote: true }); setDropdownOpen(false); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] w-full text-left hover:bg-white/5"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      <GitBranch className="w-3 h-3 shrink-0" style={{ color: 'var(--text-secondary)' }} />
                      <span className="truncate">{b.name}</span>
                    </button>
                  ))}
                </>
              )}
              {localBranches.length === 0 && remoteBranches.length === 0 && (
                <div className="px-3 py-2 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                  No other branches
                </div>
              )}
            </>
          )}

          {!remoteUrl && (
            <>
              <div style={{ borderTop: '1px solid var(--border)' }} />
              <button
                onClick={() => { setCreateRepoOpen(true); setDropdownOpen(false); }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] w-full text-left hover:bg-white/5"
                style={{ color: 'var(--accent)' }}
              >
                <Github className="w-3 h-3 shrink-0" />
                <span>Create GitHub repo</span>
              </button>
            </>
          )}
        </div>,
        document.body
      )}

      {/* Branch switch confirmation */}
      {switchTarget && (
        <ConfirmModal
          title="Switch Branch"
          message={`Switch to branch "${switchTarget.name}"? Make sure you have no uncommitted changes that could be lost.`}
          confirmLabel={switching ? 'Switching...' : 'Switch'}
          variant="warning"
          onConfirm={async () => {
            setSwitching(true);
            try {
              await api.git.checkout(projectPath, switchTarget.name, switchTarget.isRemote);
              queryClient.invalidateQueries({ queryKey: ['git-status', projectPath] });
              queryClient.invalidateQueries({ queryKey: ['git-branches', projectPath] });
            } catch (err: any) {
              alert('Branch switch failed: ' + (err.message || 'Unknown error'));
            } finally {
              setSwitching(false);
              setSwitchTarget(null);
            }
          }}
          onCancel={() => setSwitchTarget(null)}
        />
      )}

      {/* Create repo modal (for local-only repos) */}
      {createRepoOpen && (
        <CreateRepoModal
          projectPath={projectPath}
          onClose={() => setCreateRepoOpen(false)}
          onCreated={() => {
            setCreateRepoOpen(false);
            queryClient.invalidateQueries({ queryKey: ['git-status', projectPath] });
          }}
        />
      )}
    </>
  );
}

function CreateRepoModal({ projectPath, onClose, onCreated }: {
  projectPath: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [repoName, setRepoName] = useState(projectPath.split('/').pop() || '');
  const [isPrivate, setIsPrivate] = useState(true);
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [selectedOwner, setSelectedOwner] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: accountsData } = useQuery({
    queryKey: ['gh-accounts'],
    queryFn: () => api.git.ghAccounts(),
  });

  const accounts = accountsData?.accounts || [];

  // Auto-select first account
  useEffect(() => {
    if (accounts.length > 0 && !selectedOwner) setSelectedOwner(accounts[0]);
  }, [accounts, selectedOwner]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleCreate = async () => {
    if (!repoName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await api.git.createRepo({
        path: projectPath,
        name: repoName.trim(),
        owner: selectedOwner || undefined,
        private: isPrivate,
        defaultBranch: defaultBranch.trim() || 'main',
      });
      onCreated();
    } catch (err: any) {
      setError(err.message || 'Failed to create repository');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="flex flex-col rounded-lg shadow-2xl overflow-hidden"
        style={{ width: '100%', maxWidth: '420px', background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-2">
          <div className="flex items-center justify-center w-9 h-9 rounded-full shrink-0" style={{ background: '#3b82f620' }}>
            <Github className="w-5 h-5" style={{ color: '#3b82f6' }} />
          </div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Create GitHub Repository</h3>
        </div>

        <div className="px-5 py-3 flex flex-col gap-3">
          {/* Owner */}
          <div>
            <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Account</label>
            {accounts.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                No GitHub accounts found. Run <code className="px-1 py-0.5 rounded text-[10px]" style={{ background: 'var(--bg-tertiary)' }}>gh auth login</code> first.
              </p>
            ) : (
              <select
                value={selectedOwner}
                onChange={(e) => setSelectedOwner(e.target.value)}
                className="w-full px-2 py-1.5 rounded text-xs"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              >
                {accounts.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            )}
          </div>

          {/* Repo name */}
          <div>
            <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Repository Name</label>
            <input
              type="text"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              className="w-full px-2 py-1.5 rounded text-xs"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
          </div>

          {/* Branch name */}
          <div>
            <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Default Branch</label>
            <input
              type="text"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              className="w-full px-2 py-1.5 rounded text-xs"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
          </div>

          {/* Visibility */}
          <div>
            <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Visibility</label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsPrivate(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium flex-1 justify-center"
                style={{
                  background: isPrivate ? '#f59e0b22' : 'var(--bg-tertiary)',
                  color: isPrivate ? '#f59e0b' : 'var(--text-secondary)',
                  border: `1px solid ${isPrivate ? '#f59e0b44' : 'var(--border)'}`,
                }}
              >
                <Lock className="w-3 h-3" /> Private
              </button>
              <button
                onClick={() => setIsPrivate(false)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium flex-1 justify-center"
                style={{
                  background: !isPrivate ? '#22c55e22' : 'var(--bg-tertiary)',
                  color: !isPrivate ? '#22c55e' : 'var(--text-secondary)',
                  border: `1px solid ${!isPrivate ? '#22c55e44' : 'var(--border)'}`,
                }}
              >
                <Globe className="w-3 h-3" /> Public
              </button>
            </div>
          </div>

          {error && (
            <p className="text-xs px-2 py-1.5 rounded" style={{ background: '#ef444422', color: '#ef4444', border: '1px solid #ef444444' }}>
              {error}
            </p>
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 px-5 py-3"
          style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
        >
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs font-medium"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !repoName.trim() || accounts.length === 0}
            className="px-3 py-1.5 rounded-md text-xs font-medium"
            style={{ background: creating ? '#3b82f680' : '#3b82f6', color: '#fff', border: 'none', opacity: (!repoName.trim() || accounts.length === 0) ? 0.5 : 1 }}
          >
            {creating ? 'Creating...' : 'Create Repository'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProjectDashboard({ onOpenProject }: ProjectDashboardProps) {
  const [view, setView] = useState<ViewState>({ mode: 'list' });
  const queryClient = useQueryClient();

  // Listen for open-project events from the form's create success handler
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id && detail?.name) onOpenProject(detail.id, detail.name);
    };
    window.addEventListener('octoally:open-project', handler);
    return () => window.removeEventListener('octoally:open-project', handler);
  }, [onOpenProject]);

  const { data: projectsData, isLoading: loadingProjects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects.list(),
  });

  const allProjects = projectsData?.projects || [];
  const [searchQuery, setSearchQuery] = useState('');

  const projects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allProjects;
    return allProjects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q))
    );
  }, [allProjects, searchQuery]);

  // Claude-flow status — rufloStatus route removed; use empty data
  const cfStatusData = undefined as { statuses: Record<string, any> } | undefined;

  // Ruflo deprecation — disposition query
  const { data: dispositionData } = useQuery({
    queryKey: ['ruflo-disposition'],
    queryFn: () => api.projects.rufloDisposition(),
    staleTime: 60_000,
  });
  const [showDeprecationModal, setShowDeprecationModal] = useState(false);

  // Show deprecation modal once when ruflo detected and user hasn't decided
  useEffect(() => {
    if (dispositionData?.disposition === 'undecided' && dispositionData?.rufloDetected) {
      setShowDeprecationModal(true);
    }
  }, [dispositionData]);

  // Statusline prompt — ask once if user wants to install custom status bar
  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
    staleTime: 60_000,
  });
  const [showStatuslinePrompt, setShowStatuslinePrompt] = useState(false);

  useEffect(() => {
    if (settingsData?.settings?.statusline_prompted === 'false' && !showDeprecationModal) {
      setShowStatuslinePrompt(true);
    }
  }, [settingsData, showDeprecationModal]);

  // Uninstall ruflo from a single project
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const uninstallMutation = useMutation({
    mutationFn: (id: string) => api.projects.rufloUninstall(id),
    onMutate: (id) => setUninstallingId(id),
    onSettled: () => {
      setUninstallingId(null);
      queryClient.invalidateQueries({ queryKey: ['ruflo-status'] });
      queryClient.invalidateQueries({ queryKey: ['devcortex-status'] });
      queryClient.invalidateQueries({ queryKey: ['ruflo-disposition'] });
    },
  });

  // Sessions — driven by WebSocket invalidation, no polling needed
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
  });

  const activeSessionsByProject = useMemo(() => {
    const map: Record<string, { session: number; terminal: number; agent: number; total: number }> = {};
    for (const s of sessionsData?.sessions || []) {
      if (s.project_id && (s.status === 'running' || s.status === 'detached' || s.status === 'pending')) {
        if (!map[s.project_id]) map[s.project_id] = { session: 0, terminal: 0, agent: 0, total: 0 };
        const entry = map[s.project_id];
        entry.total++;
        if (s.task === 'Terminal') entry.terminal++;
        else if (s.task.startsWith('Agent (')) entry.agent++;
        else entry.session++;
      }
    }
    return map;
  }, [sessionsData]);

  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [splashDone, setSplashDone] = useState(false);
  const [splashFading, setSplashFading] = useState(false);
  const [showAbout, setShowAbout] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setSplashFading(true), 2500);
    const t2 = setTimeout(() => setSplashDone(true), 3200);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);
  const deleteProjectMutation = useMutation({
    mutationFn: (id: string) => api.projects.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err: Error) => {
      console.error('Failed to delete project:', err.message);
      alert(`Failed to remove project: ${err.message}`);
    },
  });

  // Show ProjectForm for add/edit views
  if (view.mode === 'add') {
    return (
      <ProjectForm
        mode="add"
        onSubmit={() => setView({ mode: 'list' })}
        onCancel={() => setView({ mode: 'list' })}
      />
    );
  }

  if (view.mode === 'edit') {
    return (
      <ProjectForm
        mode="edit"
        project={view.project}
        onSubmit={() => setView({ mode: 'list' })}
        onCancel={() => setView({ mode: 'list' })}
      />
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Splash screen */}
      {!splashDone && (
        <div
          className="absolute inset-0 z-50 flex flex-col items-center justify-center transition-opacity duration-600"
          style={{
            background: 'var(--bg-primary)',
            opacity: splashFading ? 0 : 1,
            pointerEvents: splashFading ? 'none' : 'auto',
          }}
        >
          <img src="/octoally-logo-lg.png" alt="" className="mb-4" style={{ width: '28rem', height: 'auto' }} />
          <p className="text-2xl font-semibold" style={{ color: 'var(--text-secondary)' }}>Loading...</p>
        </div>
      )}

      {/* About modal */}
      {showAbout && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => setShowAbout(false)}
        >
          <div
            className="rounded-2xl border p-10 flex flex-col items-center"
            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <img src="/octoally-logo-lg.png" alt="OctoAlly" className="mb-6" style={{ width: '32rem', height: 'auto' }} />
            <a
              href="https://octoally.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm mb-2 hover:underline"
              style={{ color: 'var(--accent)' }}
            >
              https://octoally.com
            </a>
            <a
              href="https://github.com/ai-genius-automations/octoally"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm mb-6 hover:underline"
              style={{ color: 'var(--accent)' }}
            >
              GitHub
            </a>
            <div className="text-center mb-4">
              <p className="text-[10px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Credits</p>
              <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                Default agents by{' '}
                <a href="https://github.com/lst97/claude-code-sub-agents" target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: 'var(--accent)' }}>
                  lst97/claude-code-sub-agents
                </a>
                {' '}(MIT)
              </p>
            </div>
            <button
              onClick={() => setShowAbout(false)}
              className="px-4 py-2 rounded-lg text-sm mb-4"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              Close
            </button>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              &copy; {new Date().getFullYear()}{' '}
              <a href="https://aigeniusautomations.com" target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: 'var(--accent)' }}>
                AIGeniusAutomations
              </a>
            </p>
          </div>
        </div>
      )}

      <div className="w-full flex-1 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}>
        {/* Sticky Header */}
        <div className="sticky top-0 z-10 px-6 pt-6 pb-4 mx-auto w-full" style={{ background: 'var(--bg-primary)', maxWidth: '82rem' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img
                src="/octoally-icon.png"
                alt=""
                className="w-9 h-9 object-contain cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => setShowAbout(true)}
                title="About OctoAlly"
              />
              <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                Projects
              </h2>
              <button
                onClick={() => {
                  setRefreshing(true);
                  Promise.all([
                    queryClient.invalidateQueries({ queryKey: ['projects'] }),
                    queryClient.invalidateQueries({ queryKey: ['sessions'] }),
                    queryClient.invalidateQueries({ queryKey: ['git-status'] }),
                    queryClient.invalidateQueries({ queryKey: ['ruflo-status'] }),
                    queryClient.invalidateQueries({ queryKey: ['ruflo-disposition'] }),
                  ]).finally(() => {
                    setLastRefreshed(new Date());
                    setRefreshing(false);
                  });
                }}
                title="Refresh project data"
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors"
                style={{ color: 'var(--text-secondary)', background: 'transparent' }}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </button>
            </div>
            <button
              onClick={() => setView({ mode: 'add' })}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              <Plus className="w-4 h-4" />
              Add Project
            </button>
          </div>
          {/* Search / filter bar */}
          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter projects..."
              className="w-full pl-9 pr-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
              }}
              onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
              onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-white/10"
                style={{ color: 'var(--text-secondary)' }}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Project cards grid */}
        <div className="pb-6">
        <div className="mx-auto px-6" style={{ maxWidth: '82rem' }}>
          {/* Skip permissions all toggle */}
          {projects.length > 0 && (
            <div className="flex items-center justify-end gap-3 mb-3">
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={projects.length > 0 && projects.every(p => !!p.skip_permissions)}
                  onChange={async (e) => {
                    try {
                      await api.projects.setSkipPermissionsAll(e.target.checked);
                      queryClient.invalidateQueries({ queryKey: ['projects'] });
                    } catch { /* ignore */ }
                  }}
                  className="w-3 h-3 rounded accent-orange-500"
                />
                <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                  Skip permissions (all projects)
                </span>
              </label>
            </div>
          )}
        </div>
        <div className="mx-auto px-6" style={{ maxWidth: '82rem' }}>
        {loadingProjects ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--accent)' }} />
          </div>
        ) : projects.length === 0 ? (
          <div
            className="rounded-xl border p-12 text-center"
            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
          >
            <Folder className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--text-secondary)', opacity: 0.5 }} />
            <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
              No projects registered yet. Add a project folder to get started.
            </p>
            <button
              onClick={() => setView({ mode: 'add' })}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm mx-auto"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              <Plus className="w-4 h-4" />
              Add Project
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {(() => {
              const cfStatuses = cfStatusData?.statuses || {};
              const disposition = dispositionData?.disposition || 'undecided';

              return (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Folder className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Projects</h3>
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>({projects.length})</span>
                    <div className="flex-1 h-px ml-2" style={{ background: 'var(--border)' }} />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {projects.map((project) => {
              const cfStatus = cfStatuses[project.id];
              const isUninstalling = uninstallingId === project.id;

              return (
                <div
                  key={project.id}
                  className="rounded-xl border flex flex-col group hover:border-[var(--accent)] transition-colors overflow-hidden cursor-pointer"
                  style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
                  onClick={() => onOpenProject(project.id, project.name)}
                >
                  {/* Ruflo deprecation notice — only shown before user has decided (undecided disposition) */}
                  {cfStatus?.installed && disposition === 'undecided' && (
                    <div
                      className="flex items-center gap-1.5 px-4 py-2"
                      style={{ background: '#f59e0b15', borderBottom: '1px solid #f59e0b40' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <AlertTriangle className="w-3 h-3 shrink-0" style={{ color: '#f59e0b' }} />
                      <span className="text-xs font-semibold truncate" style={{ color: '#f59e0b' }}>
                        RuFlo detected
                      </span>
                      <button
                        className="shrink-0 ml-auto px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap"
                        style={{ background: '#ef444420', color: '#ef4444', border: '1px solid #ef444440' }}
                        title="Remove RuFlo artifacts from this project"
                        disabled={isUninstalling}
                        onClick={() => uninstallMutation.mutate(project.id)}
                      >
                        {isUninstalling ? 'Removing...' : 'Uninstall'}
                      </button>
                    </div>
                  )}

                  {/* Title bar */}
                  {(() => {
                    const defaultColors = ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1'];
                    const hash = project.name.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
                    const color = project.color || defaultColors[hash % defaultColors.length];
                    const counts = activeSessionsByProject[project.id];
                    return (
                      <div
                        className="flex items-center justify-between px-4 py-2.5"
                        style={{ background: `${color}15`, borderBottom: `1px solid ${color}30` }}
                      >
                        <div className="min-w-0 flex-1">
                          <h3 className="text-sm font-semibold truncate" style={{ color }}>
                            {project.name}
                          </h3>
                          <p className="text-[10px] font-mono truncate mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                            {project.path}
                          </p>
                        </div>
                        {counts && counts.total > 0 && (
                          <span
                            className="shrink-0 ml-2 px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap"
                            style={{ background: `${color}20`, color }}
                          >
                            {counts.total} active
                          </span>
                        )}
                      </div>
                    );
                  })()}

                  <div className="p-5 pt-3 flex flex-col gap-3 flex-1">

                    {project.description && (
                      <p className="text-xs line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                        {project.description}
                      </p>
                    )}

                    {/* Git repo / branch info */}
                    <div onClick={(e) => e.stopPropagation()}>
                      <GitInfoBadge projectPath={project.path} />
                    </div>

                    {/* Skip permissions toggle */}
                    <label
                      className="flex items-center gap-1.5 cursor-pointer select-none"
                      onClick={(e) => e.stopPropagation()}
                      title="Launch Claude sessions with --dangerously-skip-permissions (auto-approve all tool calls)"
                    >
                      <input
                        type="checkbox"
                        checked={!!project.skip_permissions}
                        onChange={async (e) => {
                          try {
                            await api.projects.update(project.id, { skip_permissions: e.target.checked ? 1 : 0 });
                            queryClient.invalidateQueries({ queryKey: ['projects'] });
                          } catch { /* ignore */ }
                        }}
                        className="w-3 h-3 rounded accent-orange-500"
                      />
                      <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                        Skip permissions
                      </span>
                    </label>

                    {/* Row 1: Launch buttons — dual icons, type-colored, stretched */}
                    <div className="grid grid-cols-5 gap-1 mt-auto pt-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => onOpenProject(project.id, project.name, 'session', 'claude')}
                        className="flex items-center justify-center gap-0.5 p-1.5 rounded-lg border text-xs"
                        style={{ background: '#3b82f610', borderColor: '#3b82f630', color: '#60a5fa' }}
                        title="Claude Session"
                      >
                        <ClaudeIcon className="w-3 h-3" />
                        <Zap className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => onOpenProject(project.id, project.name, 'agent', 'claude')}
                        className="flex items-center justify-center gap-0.5 p-1.5 rounded-lg border text-xs"
                        style={{ background: '#ef444410', borderColor: '#ef444430', color: '#ef4444' }}
                        title="Claude Agent"
                      >
                        <ClaudeIcon className="w-3 h-3" />
                        <Bot className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => onOpenProject(project.id, project.name, 'session', 'codex')}
                        className="flex items-center justify-center gap-0.5 p-1.5 rounded-lg border text-xs"
                        style={{ background: '#3b82f610', borderColor: '#3b82f630', color: '#60a5fa' }}
                        title="Codex Session"
                      >
                        <CodexIcon className="w-3 h-3" />
                        <Zap className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => onOpenProject(project.id, project.name, 'agent', 'codex')}
                        className="flex items-center justify-center gap-0.5 p-1.5 rounded-lg border text-xs"
                        style={{ background: '#ef444410', borderColor: '#ef444430', color: '#ef4444' }}
                        title="Codex Agent"
                      >
                        <CodexIcon className="w-3 h-3" />
                        <Bot className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => onOpenProject(project.id, project.name, 'terminal')}
                        className="flex items-center justify-center p-1.5 rounded-lg border text-xs"
                        style={{ background: '#f59e0b10', borderColor: '#f59e0b30', color: '#f59e0b' }}
                        title="Terminal"
                      >
                        <TerminalSquare className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {/* Row 2: Utility buttons */}
                    <div className="grid grid-cols-4 gap-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => api.openFolder(project.path)}
                        className="flex items-center justify-center p-1.5 rounded-lg border text-xs"
                        style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                        title="Open in file manager"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => api.openTerminal(project.path)}
                        className="flex items-center justify-center p-1.5 rounded-lg border text-xs"
                        style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                        title="Open in terminal"
                      >
                        <Terminal className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setView({ mode: 'edit', project })}
                        className="flex items-center justify-center p-1.5 rounded-lg border text-xs"
                        style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                        title="Edit project"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(project.id)}
                        className="flex items-center justify-center p-1.5 rounded-lg border text-xs"
                        style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                        title="Remove project"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        )}
        </div>
        </div>
      </div>

      {confirmDeleteId && (
        <ConfirmModal
          title="Remove Project"
          message="This will remove the project from the dashboard. Project files on disk will not be deleted."
          confirmLabel="Remove"
          variant="danger"
          onConfirm={() => {
            deleteProjectMutation.mutate(confirmDeleteId);
            setConfirmDeleteId(null);
          }}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}

      {showDeprecationModal && (
        <RufloDeprecationModal
          onClose={() => setShowDeprecationModal(false)}
        />
      )}

      {showStatuslinePrompt && !showDeprecationModal && (
        <StatuslinePromptModal
          onClose={() => setShowStatuslinePrompt(false)}
        />
      )}

    </div>
  );
}
