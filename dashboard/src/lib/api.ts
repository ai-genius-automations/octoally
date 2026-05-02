const API_BASE = '/api';

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${url}`, {
    headers,
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `API error: ${res.status}`);
  }
  return res.json();
}

// Sessions
export const api = {
  sessions: {
    list: (status?: string) =>
      fetchJSON<{ sessions: Session[] }>(`/sessions${status ? `?status=${status}` : ''}`),
    get: (id: string) => fetchJSON<{ session: Session }>(`/sessions/${id}`),
    create: (data: { project_path: string; task?: string; mode?: 'session' | 'terminal' | 'agent'; agent_type?: string; project_id?: string; cli_type?: 'claude' | 'codex' }) =>
      fetchJSON<{ ok: boolean; session: Session }>('/sessions', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    kill: (id: string) =>
      fetchJSON<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' }),
    reconnect: (id: string) =>
      fetchJSON<{ ok: boolean; session: Session }>(`/sessions/${id}/reconnect`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    discoverable: (projectPath?: string) => {
      const qs = projectPath ? `?project_path=${encodeURIComponent(projectPath)}` : '';
      return fetchJSON<{ sessions: DiscoverableSession[] }>(`/sessions/discoverable${qs}`);
    },
    scanAll: () =>
      fetchJSON<{ sessions: ScannedSession[] }>('/sessions/scan-all'),
    resumeExternal: (pid: number, sessionId: string, projectPath: string, task: string, projectId?: string) =>
      fetchJSON<{ ok: boolean; session: Session }>('/sessions/resume-external', {
        method: 'POST',
        body: JSON.stringify({ pid, session_id: sessionId, project_path: projectPath, task, project_id: projectId }),
      }),
    adopt: (socketPath: string, projectId?: string) =>
      fetchJSON<{ ok: boolean; session: Session }>('/sessions/adopt', {
        method: 'POST',
        body: JSON.stringify({ socket_path: socketPath, project_id: projectId }),
      }),
    output: (id: string, opts?: { before?: number; limit?: number }) => {
      const qs = new URLSearchParams();
      if (opts?.before != null) qs.set('before', String(opts.before));
      if (opts?.limit != null) qs.set('limit', String(opts.limit));
      return fetchJSON<SessionOutput>(`/sessions/${id}/output?${qs}`);
    },
    popOut: (id: string) =>
      fetchJSON<{ ok: boolean; terminal?: string; socketPath?: string; error?: string }>(`/sessions/${id}/pop-out`, { method: 'POST' }),
    renderedOutput: (id: string, cols?: number, rows?: number) => {
      const qs = new URLSearchParams();
      if (cols) qs.set('cols', String(cols));
      if (rows) qs.set('rows', String(rows));
      const qsStr = qs.toString();
      return fetchJSON<{ rendered: string }>(`/sessions/${id}/rendered-output${qsStr ? `?${qsStr}` : ''}`);
    },
  },
  events: {
    list: (params?: { session_id?: string; project_id?: string; project_path?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.session_id) qs.set('session_id', params.session_id);
      if (params?.project_id) qs.set('project_id', params.project_id);
      if (params?.project_path) qs.set('project_path', params.project_path);
      if (params?.limit) qs.set('limit', String(params.limit));
      return fetchJSON<{ events: Event[] }>(`/events?${qs}`);
    },
  },
  tasks: {
    list: (status?: string) =>
      fetchJSON<{ tasks: Task[] }>(`/tasks${status ? `?status=${status}` : ''}`),
    create: (data: { title: string; description?: string; project_id?: string }) =>
      fetchJSON<{ ok: boolean; task: Task }>('/tasks', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  projects: {
    list: () => fetchJSON<{ projects: Project[] }>('/projects'),
    create: (data: { name: string; path: string; description?: string; session_prompt?: string; openclaw_prompt?: string; default_web_url?: string; color?: string }) =>
      fetchJSON<{ ok: boolean; project: Project }>('/projects', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { name?: string; description?: string; session_prompt?: string | null; openclaw_prompt?: string | null; default_web_url?: string | null; skip_permissions?: number; color?: string }) =>
      fetchJSON<{ ok: boolean; project: Project }>(`/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchJSON<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
    browse: (path?: string) =>
      fetchJSON<BrowseResult>(`/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
    rufloAgents: (id: string) =>
      fetchJSON<{ agents: RufloAgent[] }>(`/projects/${id}/ruflo-agents`),
    rufloUninstall: (id: string) =>
      fetchJSON<{ ok: boolean; cleaned: string[] }>(`/projects/${id}/ruflo-uninstall`, { method: 'POST' }),
    rufloUninstallAll: () =>
      fetchJSON<{ ok: boolean; projectsCleaned: number; globalCleaned: string[] }>('/projects/ruflo-uninstall-all', { method: 'POST' }),
    rufloDisposition: () =>
      fetchJSON<{ disposition: string; rufloDetected: boolean }>('/projects/ruflo-disposition'),
    setRufloDisposition: (disposition: string) =>
      fetchJSON<{ ok: boolean; disposition: string }>('/projects/ruflo-disposition', {
        method: 'PUT',
        body: JSON.stringify({ disposition }),
      }),
    setSkipPermissionsAll: (skipPermissions: boolean) =>
      fetchJSON<{ ok: boolean; updated: number }>('/projects/skip-permissions-all', {
        method: 'PUT',
        body: JSON.stringify({ skip_permissions: skipPermissions }),
      }),
    devcortexStatus: () =>
      fetchJSON<DevcortexStatusResponse>('/projects/devcortex-status'),
    devcortexUninstall: (id: string) =>
      fetchJSON<{ ok: boolean }>(`/projects/${id}/devcortex`, { method: 'DELETE' }),
  },
  files: {
    list: (path: string, showHidden?: boolean) =>
      fetchJSON<{ path: string; files: FileEntry[] }>(`/files?path=${encodeURIComponent(path)}${showHidden ? '&showHidden=true' : ''}`),
    read: (path: string) =>
      fetchJSON<{ path: string; content: string; extension: string; size: number }>(
        `/files/read?path=${encodeURIComponent(path)}`
      ),
    write: (path: string, content: string) =>
      fetchJSON<{ ok: boolean; size: number }>('/files/write', {
        method: 'PUT',
        body: JSON.stringify({ path, content }),
      }),
    openVSCode: (path: string) =>
      fetchJSON<{ ok: boolean }>('/open-vscode', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    diff: (pathA: string, pathB: string) =>
      fetchJSON<{ diff: string }>('/files/diff', {
        method: 'POST',
        body: JSON.stringify({ pathA, pathB }),
      }),
  },
  git: {
    status: (path: string) =>
      fetchJSON<GitStatus>(`/git/status?path=${encodeURIComponent(path)}`),
    log: (path: string, limit = 20) =>
      fetchJSON<{ commits: GitCommit[] }>(
        `/git/log?path=${encodeURIComponent(path)}&limit=${limit}`
      ),
    diff: (path: string, file?: string, staged?: boolean, ignoreWhitespace?: boolean, fullFile?: boolean) => {
      const qs = new URLSearchParams({ path });
      if (file) qs.set('file', file);
      if (staged) qs.set('staged', 'true');
      if (ignoreWhitespace) qs.set('ignoreWhitespace', 'true');
      if (fullFile) qs.set('fullFile', 'true');
      return fetchJSON<{ diff: string }>(`/git/diff?${qs}`);
    },
    show: (path: string, hash: string, ignoreWhitespace?: boolean, fullFile?: boolean) => {
      const qs = new URLSearchParams({ path, hash });
      if (ignoreWhitespace) qs.set('ignoreWhitespace', 'true');
      if (fullFile) qs.set('fullFile', 'true');
      return fetchJSON<{ files: CommitFile[]; diff: string }>(`/git/show?${qs}`);
    },
    stage: (path: string, files: string[]) =>
      fetchJSON<{ ok: boolean }>('/git/stage', {
        method: 'POST',
        body: JSON.stringify({ path, files }),
      }),
    unstage: (path: string, files: string[]) =>
      fetchJSON<{ ok: boolean }>('/git/unstage', {
        method: 'POST',
        body: JSON.stringify({ path, files }),
      }),
    commit: (path: string, message: string) =>
      fetchJSON<{ ok: boolean; output: string }>('/git/commit', {
        method: 'POST',
        body: JSON.stringify({ path, message }),
      }),
    push: (path: string) =>
      fetchJSON<{ ok: boolean; output: string }>('/git/push', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    discard: (path: string, files: string[]) =>
      fetchJSON<{ ok: boolean }>('/git/discard', {
        method: 'POST',
        body: JSON.stringify({ path, files }),
      }),
    branches: (path: string) =>
      fetchJSON<{ branches: GitBranch[]; current: string }>(
        `/git/branches?path=${encodeURIComponent(path)}`
      ),
    checkout: (path: string, branch: string, isRemote?: boolean) =>
      fetchJSON<{ ok: boolean }>('/git/checkout', {
        method: 'POST',
        body: JSON.stringify({ path, branch, isRemote }),
      }),
    fetch: (path: string) =>
      fetchJSON<{ ok: boolean; output: string }>('/git/fetch', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    pull: (path: string) =>
      fetchJSON<{ ok: boolean; output: string }>('/git/pull', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    ghAccounts: () =>
      fetchJSON<{ accounts: string[] }>('/git/gh-accounts'),
    createRepo: (data: { path: string; name?: string; owner?: string; private?: boolean; defaultBranch?: string }) =>
      fetchJSON<{ ok: boolean; output: string }>('/git/create-repo', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  agent: {
    execute: (sessionId: string, opts: {
      input: string;
      waitFor?: string;
      timeout?: number;
      stripAnsi?: boolean;
      quiescenceMs?: number;
    }) =>
      fetchJSON<ExecuteResult>(`/sessions/${sessionId}/execute`, {
        method: 'POST',
        body: JSON.stringify(opts),
      }),
    state: (sessionId: string) =>
      fetchJSON<SessionStateResponse>(`/sessions/${sessionId}/state`),
  },
  settings: {
    get: () => fetchJSON<{ settings: Record<string, string> }>('/settings'),
    update: (settings: Record<string, string>) =>
      fetchJSON<{ ok: boolean; settings: Record<string, string> }>('/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings }),
      }),
    statusline: {
      get: () => fetchJSON<{ installed: boolean }>('/settings/statusline'),
      install: () => fetchJSON<{ ok: boolean; scriptPath: string }>('/settings/statusline/install', { method: 'POST' }),
      uninstall: () => fetchJSON<{ ok: boolean; removed: string[] }>('/settings/statusline/uninstall', { method: 'POST' }),
    },
  },
  health: () => fetchJSON<{ name: string; version: string; status: string; uptime?: number; reconnecting?: boolean; reconnectTotal?: number; reconnectDone?: number }>('/health'),
  openFolder: (path: string) =>
    fetchJSON<{ ok: boolean }>('/open-folder', { method: 'POST', body: JSON.stringify({ path }) }),
  openTerminal: (path: string) =>
    fetchJSON<{ ok: boolean }>('/open-terminal', { method: 'POST', body: JSON.stringify({ path }) }),
  versionCheck: () =>
    fetchJSON<{ current: string; latest: string; name: string; url: string; prerelease: boolean; channel: string; updateAvailable: boolean }>('/version-check'),
};

// Types
export interface Session {
  id: string;
  project_id: string | null;
  task: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'detached';
  pid: number | null;
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  created_at: string;
  cli_type?: 'claude' | 'codex';
}

export interface Event {
  id: number;
  session_id: string | null;
  type: string;
  tool_name: string | null;
  data: string | null;
  timestamp: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  session_prompt: string | null;
  openclaw_prompt: string | null;
  default_web_url: string | null;
  skip_permissions: number;
  color: string;
  created_at: string;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  extension: string;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  remoteUrl: string | null;
}

export interface GitFileStatus {
  x: string; // index status
  y: string; // worktree status
  path: string;
}

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface CommitFile {
  status: string;
  path: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  tracking?: string;
}

export interface RufloAgent {
  name: string;
  type: string;
  description: string;
  category: string;
}

export interface RufloProjectStatus {
  installed: boolean;
  version: string | null;
  memoryInitialized: boolean;
  codexReady?: boolean;
  sonaPatchVersion?: number;
  sonaPatchOutdated?: boolean;
}

export interface DevcortexProjectStatus {
  installed: boolean;
  eligible: boolean;
  version?: string;
}

export interface DevcortexStatusResponse {
  globalInstalled: boolean;
  statuses: Record<string, DevcortexProjectStatus>;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  folderName: string;
  dirs: { name: string; path: string; hasChildren: boolean }[];
}

export interface Task {
  id: string;
  project_id: string | null;
  title: string;
  description: string | null;
  priority: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  session_id: string | null;
  created_at: string;
}

export interface ExecuteResult {
  id: string;
  status: 'completed' | 'timeout' | 'pattern_matched';
  output: string;
  durationMs: number;
  state: SessionStateResponse;
}

export interface ScannedSession {
  pid: number;
  projectPath: string;
  sessionId: string;
  task: string;
  startedAt: string;
}

export interface DiscoverableSession {
  socketPath: string;
  projectPath: string;
  task: string;
  startedAt: string;
  cliType?: 'claude' | 'codex';
}

export interface SessionOutput {
  chunks: { seq: number; data: string }[];
  hasMore: boolean;
  oldestSeq: number | null;
}

export interface SessionStateResponse {
  sessionId: string;
  processState: 'busy' | 'idle' | 'waiting_for_input';
  lastActivity: number;
  promptType: 'choice' | 'confirmation' | 'text' | null;
  choices: string[] | null;
}

