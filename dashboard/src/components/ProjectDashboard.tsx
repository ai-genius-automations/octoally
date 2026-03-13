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
  Download,
} from 'lucide-react';
import { ConfirmModal } from './ConfirmModal';

interface ProjectDashboardProps {
  onOpenProject: (projectId: string, projectName: string) => void;
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
  const [defaultWebUrl, setDefaultWebUrl] = useState(project?.default_web_url || '');
  const [rufloPrompt, setClaudeFlowPrompt] = useState(project?.ruflo_prompt || '');
  const [openclawPrompt, setOpenclawPrompt] = useState(project?.openclaw_prompt || '');
  const [claudeMd, setClaudeMd] = useState('');
  const [settingsJson, setSettingsJson] = useState('');
  const [showBrowser, setShowBrowser] = useState(false);
  const [claudeMdPreview, setClaudeMdPreview] = useState(false);
  const [error, setError] = useState('');

  // Track initial loaded values to detect changes
  const [initialClaudeMd, setInitialClaudeMd] = useState('');
  const [initialSettingsJson, setInitialSettingsJson] = useState('');

  const projectPath = mode === 'edit' ? project!.path : path;

  // Load CLAUDE.md (edit mode only)
  const claudeMdQuery = useQuery({
    queryKey: ['file-read', projectPath, 'CLAUDE.md'],
    queryFn: () => api.files.read(`${projectPath}/CLAUDE.md`),
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
      api.projects.create({ name, path, description, default_web_url: defaultWebUrl || undefined }),
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['ruflo-status'] });
      if (installRuflo && data.project?.id) {
        // Keep dialog open, show installing status
        setRufloSetupStatus('installing');
        try {
          await api.projects.rufloInstall(data.project.id);
          setRufloSetupStatus('done');
        } catch {
          setRufloSetupStatus('error');
        }
        queryClient.invalidateQueries({ queryKey: ['ruflo-status'] });
        // Brief pause so user sees "done" state
        await new Promise(r => setTimeout(r, 800));
      }
      onSubmit();
      if (data.project?.id) {
        setTimeout(() => {
          const openEvent = new CustomEvent('openflow:open-project', {
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
      const fields: Record<string, string | null | undefined> = {};
      if (name !== project!.name) fields.name = name;
      if (description !== (project!.description || '')) fields.description = description;
      if (defaultWebUrl !== (project!.default_web_url || '')) fields.default_web_url = defaultWebUrl || null;
      if (rufloPrompt !== (project!.ruflo_prompt || ''))
        fields.ruflo_prompt = rufloPrompt || null;
      if (openclawPrompt !== (project!.openclaw_prompt || ''))
        fields.openclaw_prompt = openclawPrompt || null;
      return api.projects.update(project!.id, fields);
    },
    onSuccess: async () => {
      const savePath = project!.path;
      try {
        if (claudeMd !== initialClaudeMd) await api.files.write(`${savePath}/CLAUDE.md`, claudeMd);
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

    // Add mode — check for ruflo conflicts if toggle is on
    if (installRuflo && path) {
      try {
        // Use a lightweight check: see if .claude/settings.json or CLAUDE.md exist at the path
        const conflicts = { settingsJson: false, claudeMd: false };
        try { await api.files.read(`${path}/CLAUDE.md`); conflicts.claudeMd = true; } catch {}
        try { await api.files.read(`${path}/.claude/settings.json`); conflicts.settingsJson = true; } catch {}

        if (conflicts.settingsJson || conflicts.claudeMd) {
          setRufloConflicts(conflicts);
          setRufloConfirmPending(true);
          return;
        }
      } catch {}
    }
    createMutation.mutate();
  };

  const handleFolderSelect = (selectedPath: string, folderName: string) => {
    setPath(selectedPath);
    if (!name || name === prevFolderName(path)) setName(folderName);
    setShowBrowser(false);
  };

  const filesLoading = mode === 'edit' && (!!projectPath) && (claudeMdQuery.isLoading || settingsQuery.isLoading);

  const [installRuflo, setInstallRuflo] = useState(true);
  const [rufloConflicts, setRufloConflicts] = useState<{ settingsJson: boolean; claudeMd: boolean } | null>(null);
  const [rufloConfirmPending, setRufloConfirmPending] = useState(false);
  const [rufloSetupStatus, setRufloSetupStatus] = useState<'idle' | 'installing' | 'done' | 'error'>('idle');

  const isPending = createMutation.isPending || updateMutation.isPending || rufloSetupStatus === 'installing';

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
      <div className="mx-auto" style={{ maxWidth: '720px' }}>
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
              <div className="grid grid-cols-3 gap-x-6 gap-y-4 items-stretch pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                {/* Prompts */}
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col flex-1">
                    <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>RuFlo Session Prompt</label>
                    <textarea
                      value={rufloPrompt}
                      onChange={(e) => setClaudeFlowPrompt(e.target.value)}
                      placeholder="System instructions prepended to every task for this project..."
                      className={`${inputClass} resize-y flex-1`}
                      style={{ ...inputStyle, minHeight: '120px' }}
                    />
                  </div>
                  <div className="flex flex-col flex-1">
                    <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>OpenClaw Session Prompt</label>
                    <textarea
                      value={openclawPrompt}
                      onChange={(e) => setOpenclawPrompt(e.target.value)}
                      placeholder="Additional instructions included when running via OpenClaw..."
                      className={`${inputClass} resize-y flex-1`}
                      style={{ ...inputStyle, minHeight: '120px' }}
                    />
                  </div>
                </div>

                {/* CLAUDE.md */}
                <div className="flex flex-col">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      CLAUDE.md
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
                    placeholder="File will be created on save"
                    className={`${inputClass} resize-y font-mono text-xs flex-1`}
                    style={{ ...inputStyle, minHeight: '260px' }}
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

                {/* .claude/settings.json */}
                <div className="flex flex-col">
                  <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>
                    .claude/settings.json
                    {filesLoading && <Loader2 className="w-3 h-3 inline ml-1 animate-spin" />}
                  </label>
                  <textarea
                    value={settingsJson}
                    onChange={(e) => setSettingsJson(e.target.value)}
                    placeholder="File will be created on save"
                    className={`${inputClass} resize-y font-mono text-xs flex-1`}
                    style={{ ...inputStyle, minHeight: '260px' }}
                  />
                </div>
              </div>
            )}

            {/* RuFlo toggle — add mode only */}
            {mode === 'add' && (
              <label className="flex items-center gap-3 cursor-pointer">
                <div
                  onClick={() => setInstallRuflo(!installRuflo)}
                  className="relative w-10 h-5 rounded-full transition-colors"
                  style={{ background: installRuflo ? 'var(--accent)' : 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
                >
                  <div
                    className="absolute top-0.5 w-4 h-4 rounded-full transition-transform"
                    style={{ background: 'white', left: installRuflo ? '20px' : '2px' }}
                  />
                </div>
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  Initialize RuFlo (agents, skills, memory, swarm)
                </span>
              </label>
            )}

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
                {rufloSetupStatus === 'installing' ? 'Installing RuFlo...' : rufloSetupStatus === 'done' ? 'Done!' : isPending ? 'Saving...' : mode === 'add' ? 'Add Project' : 'Save Changes'}
              </button>
              <button
                onClick={onCancel}
                className="px-6 py-2.5 rounded-lg border text-sm font-medium"
                style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
              >
                Cancel
              </button>
            </div>

            {/* RuFlo conflict confirmation */}
            {rufloConfirmPending && rufloConflicts && (
              <ConfirmModal
                title="RuFlo will overwrite existing files"
                message={`This project has config files that will be replaced by RuFlo:\n${rufloConflicts.settingsJson ? '  - .claude/settings.json\n' : ''}${rufloConflicts.claudeMd ? '  - CLAUDE.md\n' : ''}\nTimestamped .bak backups will be created before overwriting.`}
                confirmLabel="Continue & Backup"
                variant="danger"
                onConfirm={() => {
                  setRufloConfirmPending(false);
                  createMutation.mutate();
                }}
                onCancel={() => {
                  setRufloConfirmPending(false);
                  setRufloConflicts(null);
                }}
              />
            )}
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
    window.addEventListener('openflow:open-project', handler);
    return () => window.removeEventListener('openflow:open-project', handler);
  }, [onOpenProject]);

  const { data: projectsData, isLoading: loadingProjects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects.list(),
  });

  const projects = projectsData?.projects || [];

  // Claude-flow status for all projects
  const { data: cfStatusData } = useQuery({
    queryKey: ['ruflo-status'],
    queryFn: () => api.projects.rufloStatus(),
    enabled: projects.length > 0,
    staleTime: 5_000, // Short cache so install status updates quickly
  });

  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [rufloConfirm, setRufloConfirm] = useState<{ id: string; conflicts: { settingsJson: boolean; claudeMd: boolean } } | null>(null);
  const installMutation = useMutation({
    mutationFn: (id: string) => api.projects.rufloInstall(id),
    onMutate: (id) => { setInstallingId(id); setInstallError(null); },
    onSuccess: () => setInstallError(null),
    onError: (err: Error) => setInstallError(err.message || 'Install failed'),
    onSettled: () => {
      setInstallingId(null);
      queryClient.invalidateQueries({ queryKey: ['ruflo-status'] });
    },
  });

  const handleRufloInstall = async (projectId: string) => {
    try {
      const conflicts = await api.projects.rufloCheck(projectId);
      if (conflicts.settingsJson || conflicts.claudeMd) {
        setRufloConfirm({ id: projectId, conflicts });
      } else {
        installMutation.mutate(projectId);
      }
    } catch {
      installMutation.mutate(projectId);
    }
  };

  // Sessions — driven by WebSocket invalidation, no polling needed
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
  });

  const activeSessionsByProject = useMemo(() => {
    const map: Record<string, { hivemind: number; terminal: number; agent: number; total: number }> = {};
    for (const s of sessionsData?.sessions || []) {
      if (s.project_id && (s.status === 'running' || s.status === 'detached' || s.status === 'pending')) {
        if (!map[s.project_id]) map[s.project_id] = { hivemind: 0, terminal: 0, agent: 0, total: 0 };
        const entry = map[s.project_id];
        entry.total++;
        if (s.task === 'Terminal') entry.terminal++;
        else if (s.task.startsWith('Agent (')) entry.agent++;
        else entry.hivemind++;
      }
    }
    return map;
  }, [sessionsData]);

  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const deleteProjectMutation = useMutation({
    mutationFn: (id: string) => api.projects.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
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
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
              Projects
            </h2>
            <button
              onClick={() => {
                setRefreshing(true);
                // Invalidate all queries - don't await so fast ones resolve immediately
                Promise.all([
                  queryClient.invalidateQueries({ queryKey: ['projects'] }),
                  queryClient.invalidateQueries({ queryKey: ['sessions'] }),
                  queryClient.invalidateQueries({ queryKey: ['git-status'] }),
                  queryClient.invalidateQueries({ queryKey: ['ruflo-status'] }),
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

        {/* Project cards grid */}
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
              const cfProjects = projects.filter(p => cfStatuses[p.id]?.installed);
              const otherProjects = projects.filter(p => !cfStatuses[p.id]?.installed);

              const groups: { label: string; color: string; icon: typeof Folder; items: typeof projects }[] = [];
              if (cfProjects.length > 0) groups.push({ label: 'RuFlo Projects', color: '#60a5fa', icon: Zap, items: cfProjects });
              if (otherProjects.length > 0) groups.push({ label: 'Projects', color: 'var(--text-secondary)', icon: Folder, items: otherProjects });
              // If all projects have CF, still show the group
              if (groups.length === 0) groups.push({ label: 'Projects', color: 'var(--text-secondary)', icon: Folder, items: projects });

              return groups.map((group, gi) => (
                <div key={gi}>
                  <div className="flex items-center gap-2 mb-3">
                    <group.icon className="w-4 h-4" style={{ color: group.color }} />
                    <h3 className="text-sm font-semibold" style={{ color: group.color }}>{group.label}</h3>
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>({group.items.length})</span>
                    <div className="flex-1 h-px ml-2" style={{ background: 'var(--border)' }} />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {group.items.map((project) => {
              const cfStatus = cfStatuses[project.id];
              const isInstalling = installingId === project.id;

              return (
                <div
                  key={project.id}
                  className="rounded-xl border flex flex-col group hover:border-[var(--accent)] transition-colors overflow-hidden cursor-pointer"
                  style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
                  onClick={() => onOpenProject(project.id, project.name)}
                >
                  {/* RuFlo status bar */}
                  {cfStatus?.installed && (
                    <div
                      className="flex items-center gap-1.5 px-4 py-2"
                      style={{ background: '#3b82f615', borderBottom: '1px solid #3b82f640' }}
                    >
                      <Zap className="w-3 h-3 shrink-0" style={{ color: '#60a5fa' }} />
                      <span className="text-xs font-semibold truncate" style={{ color: '#60a5fa' }}>
                        RuFlo
                      </span>
                      {cfStatus.version && (
                        <span className="text-[10px] font-mono shrink-0" style={{ color: '#60a5fa', opacity: 0.7 }}>
                          v{cfStatus.version}
                        </span>
                      )}
                      {(() => {
                        const counts = activeSessionsByProject[project.id];
                        if (!counts || counts.total === 0) return null;
                        const parts: string[] = [];
                        if (counts.hivemind > 0) parts.push(`${counts.hivemind} hive`);
                        if (counts.agent > 0) parts.push(`${counts.agent} agent`);
                        if (counts.terminal > 0) parts.push(`${counts.terminal} term`);
                        const badgeBg = counts.total <= 2 ? '#22c55e20' : counts.total <= 4 ? '#f59e0b20' : '#ef444420';
                        const badgeText = counts.total <= 2 ? '#22c55e' : counts.total <= 4 ? '#f59e0b' : '#ef4444';
                        return (
                          <span
                            className="shrink-0 ml-auto px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap"
                            style={{ background: badgeBg, color: badgeText }}
                            title={parts.join(', ')}
                          >
                            {parts.join(' / ')}
                          </span>
                        );
                      })()}
                    </div>
                  )}

                  <div className="p-5 flex flex-col gap-3 flex-1">
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                          {project.name}
                        </h3>
                        <p className="text-xs font-mono truncate mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                          {project.path}
                        </p>
                      </div>
                      {/* Session badge for projects without RuFlo bar */}
                      {!cfStatus?.installed && (() => {
                        const counts = activeSessionsByProject[project.id];
                        if (!counts || counts.total === 0) return null;
                        const badgeBg = counts.total <= 2 ? '#22c55e20' : counts.total <= 4 ? '#f59e0b20' : '#ef444420';
                        const badgeText = counts.total <= 2 ? '#22c55e' : counts.total <= 4 ? '#f59e0b' : '#ef4444';
                        return (
                          <span
                            className="shrink-0 ml-2 px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap"
                            style={{ background: badgeBg, color: badgeText }}
                          >
                            {counts.total} active
                          </span>
                        );
                      })()}
                    </div>

                    {project.description && (
                      <p className="text-xs line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                        {project.description}
                      </p>
                    )}

                    {/* Git repo / branch info */}
                    <div onClick={(e) => e.stopPropagation()}>
                      <GitInfoBadge projectPath={project.path} />
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 mt-auto pt-1" onClick={(e) => e.stopPropagation()}>
                      {/* Install ruflo button for projects without it */}
                      {!cfStatus?.installed && (
                        <button
                          onClick={() => handleRufloInstall(project.id)}
                          disabled={isInstalling}
                          className="flex items-center gap-1 p-1.5 rounded-lg border text-xs"
                          style={{ background: '#3b82f615', borderColor: '#3b82f640', color: isInstalling ? '#facc15' : (installError && installingId === null) ? '#f87171' : '#60a5fa' }}
                          title={isInstalling ? 'Installing RuFlo...' : 'Install RuFlo (memory + hive-mind)'}
                        >
                          {isInstalling ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>Installing...</span>
                            </>
                          ) : (
                            <Download className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                      {installError && installingId === null && !cfStatus?.installed && (
                        <span className="text-[10px]" style={{ color: '#f87171' }} title={installError}>
                          Failed - retry?
                        </span>
                      )}
                      {cfStatus?.installed && (
                        <button
                          onClick={() => handleRufloInstall(project.id)}
                          disabled={isInstalling}
                          className="flex items-center gap-1 p-1.5 rounded-lg border text-xs"
                          style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: isInstalling ? '#facc15' : 'var(--text-secondary)' }}
                          title={isInstalling ? 'Re-initializing RuFlo...' : 'Re-init RuFlo (update agents + memory)'}
                        >
                          {isInstalling ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                      <button
                        onClick={() => api.openFolder(project.path)}
                        className="p-1.5 rounded-lg border text-xs"
                        style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                        title="Open in file manager"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => api.openTerminal(project.path)}
                        className="p-1.5 rounded-lg border text-xs"
                        style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                        title="Open in terminal"
                      >
                        <Terminal className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setView({ mode: 'edit', project })}
                        className="p-1.5 rounded-lg border text-xs"
                        style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                        title="Edit project"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(project.id)}
                        className="p-1.5 rounded-lg border text-xs"
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
              ));
            })()}
          </div>
        )}
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

      {rufloConfirm && (
        <ConfirmModal
          title="Install / Re-init RuFlo"
          message={`This project has existing config files that will be replaced:\n${rufloConfirm.conflicts.settingsJson ? '• .claude/settings.json\n' : ''}${rufloConfirm.conflicts.claudeMd ? '• CLAUDE.md\n' : ''}\nBackups will be created with a .bak extension before overwriting.`}
          confirmLabel="Continue & Backup"
          variant="danger"
          onConfirm={() => {
            installMutation.mutate(rufloConfirm.id);
            setRufloConfirm(null);
          }}
          onCancel={() => setRufloConfirm(null)}
        />
      )}

    </div>
  );
}
