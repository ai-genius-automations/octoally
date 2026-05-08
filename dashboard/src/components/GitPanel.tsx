import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  RefreshCw,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Minus,
  Undo2,
  Redo2,
  GitBranch,
  ArrowUp,
  ArrowDown,
  X,
  Columns2,
  Rows3,
  Space,
  FileText,
  Save,
  FolderTree,
} from 'lucide-react';
import { api, type GitFileStatus, type GitCommit, type CommitFile, type GitBranch as GitBranchInfo } from '../lib/api';
import {
  parseHunks,
  filterDiffToFile,
  UnifiedDiff,
  SplitDiff,
} from './DiffComponents';

/* ================================================================
   Types & helpers
   ================================================================ */

interface GitPanelProps { projectPath: string; isVisible?: boolean; onFileSaved?: (filePath: string) => void; onOpenInExplorer?: (filePath: string) => void; }
interface CategorizedFile { file: GitFileStatus; statusChar: string; }
type DetailView =
  | { type: 'diff'; path: string; staged: boolean }
  | { type: 'commit'; hash: string; message: string };
type DiffMode = 'unified' | 'split';

function categorizeFiles(files: GitFileStatus[]) {
  const staged: CategorizedFile[] = [], changed: CategorizedFile[] = [], untracked: CategorizedFile[] = [];
  for (const file of files) {
    if (file.x !== ' ' && file.x !== '?' && file.x !== '!') staged.push({ file, statusChar: file.x });
    if (file.y !== ' ' && file.y !== '?' && file.y !== '!') changed.push({ file, statusChar: file.y });
    if (file.x === '?' && file.y === '?') untracked.push({ file, statusChar: '?' });
  }
  return { staged, changed, untracked };
}

function statusColor(s: string) {
  switch (s) {
    case 'M': return 'var(--warning, #e5a00d)'; case 'A': return 'var(--success, #3fb950)';
    case 'D': return 'var(--error, #f85149)'; case 'R': return 'var(--accent, #58a6ff)';
    case '?': return 'var(--text-tertiary, #6e7681)'; default: return 'var(--text-secondary)';
  }
}

function statusLabel(s: string) {
  switch (s) {
    case 'M': return 'Modified'; case 'A': return 'Added'; case 'D': return 'Deleted';
    case 'R': return 'Renamed'; case 'C': return 'Copied'; case '?': return 'Untracked';
    case 'U': return 'Conflict'; default: return s;
  }
}

/* ================================================================
   Main component
   ================================================================ */

export function GitPanel({ projectPath, isVisible, onFileSaved, onOpenInExplorer }: GitPanelProps) {
  const [branch, setBranch] = useState('');
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commitMsg, setCommitMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [branchFilter, setBranchFilter] = useState('');
  const [switching, setSwitching] = useState(false);
  const branchPickerRef = useRef<HTMLDivElement>(null);

  const [changesOpen, setChangesOpen] = useState(true);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [untrackedOpen, setUntrackedOpen] = useState(true);
  const [commitsOpen, setCommitsOpen] = useState(true);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  // Resizable left panel
  const [leftPanelWidth, setLeftPanelWidth] = useState(340);
  const isDraggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const newWidth = Math.min(Math.max(e.clientX - (containerRef.current?.getBoundingClientRect().left ?? 0), 200), 600);
      setLeftPanelWidth(newWidth);
    };
    const onMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const startDragging = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const [detail, setDetail] = useState<DetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [diffContent, setDiffContent] = useState('');
  const [commitFiles, setCommitFiles] = useState<CommitFile[]>([]);
  const [commitDiff, setCommitDiff] = useState('');

  const [diffMode, setDiffMode] = useState<DiffMode>('split');
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [fullFile, setFullFile] = useState(false);
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(null);

  const hasLoadedOnce = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [statusRes, logRes] = await Promise.all([
        api.git.status(projectPath),
        api.git.log(projectPath, 20),
      ]);
      setBranch(statusRes.branch);
      setAhead(statusRes.ahead);
      setBehind(statusRes.behind);
      setFiles(statusRes.files);
      setRemoteUrl(statusRes.remoteUrl ?? null);
      setCommits(logRes.commits);
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }, [projectPath]);

  useEffect(() => { refresh(); hasLoadedOnce.current = true; }, [refresh]);
  useEffect(() => { if (isVisible && hasLoadedOnce.current) refresh(); }, [isVisible, refresh]);

  // Re-fetch when toggles change
  useEffect(() => {
    if (!detail) return;
    if (detail.type === 'diff') fetchDiff(detail.path, detail.staged);
    else fetchCommitDetail(detail.hash);
  }, [ignoreWhitespace, fullFile]);

  async function fetchDiff(path: string, staged: boolean) {
    setDetailLoading(true);
    try { const res = await api.git.diff(projectPath, path, staged, ignoreWhitespace, fullFile); setDiffContent(res.diff); }
    catch { setDiffContent('Failed to load diff'); }
    finally { setDetailLoading(false); }
  }

  async function fetchCommitDetail(hash: string) {
    setDetailLoading(true);
    try {
      const res = await api.git.show(projectPath, hash, ignoreWhitespace, fullFile);
      setCommitFiles(res.files);
      setCommitDiff(res.diff);
      setSelectedCommitFile(null);
    } catch { setCommitFiles([]); setCommitDiff('Failed to load commit details'); }
    finally { setDetailLoading(false); }
  }

  const { staged, changed, untracked } = categorizeFiles(files);

  const handleStage = async (fps: string[]) => { await api.git.stage(projectPath, fps); setSelectedFiles(prev => { const next = new Set(prev); fps.forEach(f => next.delete(f)); return next; }); refresh(); };
  const handleUnstage = async (fps: string[]) => { await api.git.unstage(projectPath, fps); refresh(); };
  const handleDiscard = async (fps: string[]) => { await api.git.discard(projectPath, fps); setSelectedFiles(prev => { const next = new Set(prev); fps.forEach(f => next.delete(f)); return next; }); refresh(); };

  const toggleFileSelect = (path: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const selectedUnstagedPaths = [...selectedFiles].filter(p =>
    changed.some(f => f.file.path === p) || untracked.some(f => f.file.path === p)
  );

  const handleCommit = async () => {
    if (!commitMsg.trim() || committing) return;
    setCommitting(true);
    try {
      if (staged.length === 0) {
        const allPaths = [...changed.map(f => f.file.path), ...untracked.map(f => f.file.path)];
        if (allPaths.length > 0) await api.git.stage(projectPath, allPaths);
      }
      await api.git.commit(projectPath, commitMsg.trim());
      setCommitMsg('');
      setSelectedFiles(new Set());
      refresh();
    }
    catch (err: any) { setError(err.message); } finally { setCommitting(false); }
  };

  const handlePush = async () => {
    if (pushing) return; setPushing(true);
    try { await api.git.push(projectPath); refresh(); }
    catch (err: any) { setError(err.message); } finally { setPushing(false); }
  };

  const handlePull = async () => {
    if (pulling) return; setPulling(true);
    try { await api.git.pull(projectPath); refresh(); }
    catch (err: any) { setError(err.message); } finally { setPulling(false); }
  };

  const openBranchPicker = async () => {
    if (branchPickerOpen) { setBranchPickerOpen(false); return; }
    setBranchPickerOpen(true);
    setBranchFilter('');
    try {
      const res = await api.git.branches(projectPath);
      setBranches(res.branches);
    } catch { setBranches([]); }
  };

  const handleSwitchBranch = async (name: string, isRemote: boolean) => {
    if (switching) return;
    setSwitching(true);
    setBranchPickerOpen(false);
    try {
      await api.git.checkout(projectPath, name, isRemote);
      refresh();
    } catch (err: any) { setError(err.message); }
    finally { setSwitching(false); }
  };

  // Click-outside to close branch picker
  useEffect(() => {
    if (!branchPickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (branchPickerRef.current && !branchPickerRef.current.contains(e.target as Node)) {
        setBranchPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [branchPickerOpen]);

  const handleViewDiff = (path: string, staged: boolean) => {
    if (detail?.type === 'diff' && detail.path === path && detail.staged === staged) { setDetail(null); return; }
    setDetail({ type: 'diff', path, staged });
    fetchDiff(path, staged);
  };

  const handleViewCommit = (commit: GitCommit) => {
    if (detail?.type === 'commit' && detail.hash === commit.hash) { setDetail(null); return; }
    setDetail({ type: 'commit', hash: commit.hash, message: commit.message });
    fetchCommitDetail(commit.hash);
  };

  // When DiffViewer saves a file, re-fetch diff and notify parent
  const handleDiffChanged = () => {
    if (detail?.type === 'diff') {
      fetchDiff(detail.path, detail.staged);
      refresh();
      onFileSaved?.(detail.path);
    }
  };

  if (loading) return <div className="h-full flex items-center justify-center" style={{ color: 'var(--text-secondary)' }}><RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading...</div>;
  if (error && !branch) return <div className="h-full flex items-center justify-center p-4 text-center" style={{ color: 'var(--text-secondary)' }}><div><p style={{ color: 'var(--error)' }}>Not a git repository</p><p className="text-xs mt-1">Initialize a git repo in this project to use source control.</p></div></div>;

  const displayDiff = detail?.type === 'commit'
    ? (selectedCommitFile ? filterDiffToFile(commitDiff, selectedCommitFile) : commitDiff)
    : diffContent;

  // Determine the full file path for editing (only for working tree diffs, not commits)
  const isEditable = detail?.type === 'diff' && !detail.staged;
  const editFilePath = detail?.type === 'diff' ? `${projectPath}/${detail.path}` : undefined;

  return (
    <div ref={containerRef} className="h-full flex">
      {/* ===== LEFT PANE ===== */}
      {!leftCollapsed && (
      <div className="h-full flex flex-col shrink-0" style={{ width: leftPanelWidth, background: 'var(--bg-primary)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-1.5 shrink-0" style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
          <div className="flex items-center gap-1.5 relative" ref={branchPickerRef}>
            <button onClick={openBranchPicker} className="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-white/10 transition-colors" style={{ color: 'var(--text-primary)' }} title="Switch branch">
              <GitBranch className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
              <span className="text-xs font-medium">{switching ? '...' : branch}</span>
              <ChevronDown className="w-3 h-3" style={{ color: 'var(--text-tertiary)' }} />
            </button>
            {(ahead > 0 || behind > 0) && <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{ahead > 0 && `${ahead}↑`}{behind > 0 && `${behind}↓`}</span>}

            {/* Branch picker dropdown */}
            {branchPickerOpen && (
              <div className="absolute top-full left-0 mt-1 z-50 rounded shadow-lg overflow-hidden" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', width: 280, maxHeight: 340 }}>
                <div className="px-2 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
                  <input type="text" placeholder="Filter branches..." value={branchFilter} onChange={e => setBranchFilter(e.target.value)} autoFocus
                    className="w-full px-2 py-1 text-xs rounded" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }} />
                </div>
                <div className="overflow-y-auto" style={{ maxHeight: 280 }}>
                  {(() => {
                    const filter = branchFilter.toLowerCase();
                    const localBranches = branches.filter(b => !b.remote && b.name.toLowerCase().includes(filter));
                    const localNames = new Set(branches.filter(b => !b.remote).map(b => b.name));
                    const remoteBranches = branches.filter(b => b.remote && b.name.toLowerCase().includes(filter) && !localNames.has(b.name.replace(/^origin\//, '')));
                    return (
                      <>
                        {localBranches.length > 0 && (
                          <>
                            <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Local</div>
                            {localBranches.map(b => (
                              <button key={b.name} onClick={() => b.name !== branch && handleSwitchBranch(b.name, false)}
                                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-[var(--bg-tertiary)] transition-colors"
                                style={{ color: b.name === branch ? 'var(--accent)' : 'var(--text-primary)' }}>
                                <span className="truncate flex-1">{b.name}</span>
                                {b.name === branch && <span style={{ color: 'var(--accent)' }}>✓</span>}
                              </button>
                            ))}
                          </>
                        )}
                        {remoteBranches.length > 0 && (
                          <>
                            <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)', borderTop: localBranches.length > 0 ? '1px solid var(--border)' : 'none' }}>Remote</div>
                            {remoteBranches.map(b => (
                              <button key={b.name} onClick={() => handleSwitchBranch(b.name, true)}
                                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-[var(--bg-tertiary)] transition-colors"
                                style={{ color: 'var(--text-primary)' }}>
                                <span className="truncate flex-1" style={{ opacity: 0.8 }}>{b.name}</span>
                              </button>
                            ))}
                          </>
                        )}
                        {localBranches.length === 0 && remoteBranches.length === 0 && (
                          <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>No matching branches</div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <button onClick={refresh} title="Refresh" className="p-1 rounded hover:bg-white/10 transition-colors" style={{ color: 'var(--text-secondary)' }}><RefreshCw className="w-3.5 h-3.5" /></button>
            <button onClick={() => setLeftCollapsed(true)} title="Hide sidebar" className="p-1 rounded hover:bg-white/10 transition-colors" style={{ color: 'var(--text-secondary)' }}><PanelLeftClose className="w-3.5 h-3.5" /></button>
          </div>
        </div>
        {/* Commit input */}
        <div className="flex items-center gap-1 px-2 py-1.5 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <input type="text" placeholder="Commit message" value={commitMsg} onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleCommit(); }}
            className="flex-1 min-w-0 px-2 py-1 text-xs rounded" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }} />
          <button onClick={handleCommit} disabled={!commitMsg.trim() || committing || (staged.length === 0 && changed.length === 0 && untracked.length === 0)}
            className="px-2 py-1 text-xs rounded font-medium transition-colors shrink-0"
            style={{ background: commitMsg.trim() && (staged.length > 0 || changed.length > 0 || untracked.length > 0) ? 'var(--accent)' : 'var(--bg-tertiary)', color: commitMsg.trim() && (staged.length > 0 || changed.length > 0 || untracked.length > 0) ? '#fff' : 'var(--text-tertiary)' }}
            title={staged.length > 0 ? 'Commit staged changes (Ctrl+Enter)' : 'Stage all & commit (Ctrl+Enter)'}>{committing ? '...' : '✓'}</button>
          <button onClick={handlePush} disabled={pushing || ahead === 0} className="flex items-center gap-0.5 px-2 py-1 text-xs rounded font-medium transition-colors shrink-0"
            style={{ background: ahead > 0 ? 'var(--bg-tertiary)' : 'transparent', color: ahead > 0 ? 'var(--text-secondary)' : 'var(--text-tertiary)', opacity: ahead === 0 ? 0.4 : 1 }} title="Push to remote">
            <ArrowUp className="w-3 h-3" />{ahead > 0 && <span className="opacity-70">{ahead}</span>}
          </button>
          {behind > 0 && (
            <button onClick={handlePull} disabled={pulling} className="flex items-center gap-0.5 px-2 py-1 text-xs rounded font-medium transition-colors shrink-0"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }} title="Pull from remote">
              <ArrowDown className="w-3 h-3" /><span className="opacity-70">{behind}</span>
            </button>
          )}
        </div>
        {error && <div className="px-3 py-1 text-xs shrink-0" style={{ color: 'var(--error)', background: 'rgba(248,81,73,0.07)' }}>{error}</div>}

        {/* Action bar for selected files */}
        {selectedUnstagedPaths.length > 0 && (
          <div className="flex items-center gap-1.5 px-2 py-1.5 shrink-0" style={{ borderBottom: '1px solid var(--border)', background: 'rgba(88,166,255,0.06)' }}>
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{selectedUnstagedPaths.length} selected</span>
            <button onClick={() => { handleStage(selectedUnstagedPaths); }} className="px-2 py-0.5 text-xs rounded font-medium transition-colors"
              style={{ background: 'var(--accent)', color: '#fff' }}>
              <Plus className="w-3 h-3 inline mr-0.5" style={{ verticalAlign: '-2px' }} />Stage
            </button>
            <button onClick={() => { handleDiscard(selectedUnstagedPaths); }} className="px-2 py-0.5 text-xs rounded font-medium transition-colors"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
              <Undo2 className="w-3 h-3 inline mr-0.5" style={{ verticalAlign: '-2px' }} />Discard
            </button>
            <button onClick={() => setSelectedFiles(new Set())} className="ml-auto p-0.5 rounded hover:bg-white/10" style={{ color: 'var(--text-tertiary)' }} title="Clear selection">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Changes */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {staged.length > 0 && (
            <FileSection title="Staged" count={staged.length} open={stagedOpen} onToggle={() => setStagedOpen(!stagedOpen)}
              headerActions={<button onClick={() => handleUnstage(staged.map(f => f.file.path))} title="Unstage all" className="p-0.5 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}><Minus className="w-3 h-3" /></button>}>
              {staged.map(f => <FileRow key={`s-${f.file.path}`} path={f.file.path} status={f.statusChar} isActive={detail?.type === 'diff' && detail.path === f.file.path && detail.staged} onClick={() => handleViewDiff(f.file.path, true)}
                onReveal={onOpenInExplorer ? () => onOpenInExplorer(`${projectPath.replace(/\/$/, '')}/${f.file.path}`) : undefined}
                actions={<button onClick={e => { e.stopPropagation(); handleUnstage([f.file.path]); }} title="Unstage" className="p-0.5 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}><Minus className="w-3 h-3" /></button>} />)}
            </FileSection>
          )}
          {changed.length > 0 && (
            <FileSection title="Changes" count={changed.length} open={changesOpen} onToggle={() => setChangesOpen(!changesOpen)}
              headerActions={<><button onClick={() => handleStage(changed.map(f => f.file.path))} title="Stage all" className="p-0.5 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}><Plus className="w-3 h-3" /></button><button onClick={() => handleDiscard(changed.map(f => f.file.path))} title="Discard all" className="p-0.5 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}><Undo2 className="w-3 h-3" /></button></>}>
              {changed.map(f => <FileRow key={`c-${f.file.path}`} path={f.file.path} status={f.statusChar} isActive={detail?.type === 'diff' && detail.path === f.file.path && !detail.staged} onClick={() => handleViewDiff(f.file.path, false)}
                selected={selectedFiles.has(f.file.path)} onSelect={() => toggleFileSelect(f.file.path)}
                onReveal={onOpenInExplorer ? () => onOpenInExplorer(`${projectPath.replace(/\/$/, '')}/${f.file.path}`) : undefined}
                actions={<><button onClick={e => { e.stopPropagation(); handleStage([f.file.path]); }} title="Stage" className="p-0.5 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}><Plus className="w-3 h-3" /></button><button onClick={e => { e.stopPropagation(); handleDiscard([f.file.path]); }} title="Discard" className="p-0.5 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}><Undo2 className="w-3 h-3" /></button></>} />)}
            </FileSection>
          )}
          {untracked.length > 0 && (
            <FileSection title="Untracked" count={untracked.length} open={untrackedOpen} onToggle={() => setUntrackedOpen(!untrackedOpen)}
              headerActions={<button onClick={() => handleStage(untracked.map(f => f.file.path))} title="Stage all" className="p-0.5 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}><Plus className="w-3 h-3" /></button>}>
              {untracked.map(f => <FileRow key={`u-${f.file.path}`} path={f.file.path} status="?" isActive={false} onClick={() => handleViewDiff(f.file.path, false)}
                selected={selectedFiles.has(f.file.path)} onSelect={() => toggleFileSelect(f.file.path)}
                onReveal={onOpenInExplorer ? () => onOpenInExplorer(`${projectPath.replace(/\/$/, '')}/${f.file.path}`) : undefined}
                actions={<button onClick={e => { e.stopPropagation(); handleStage([f.file.path]); }} title="Stage" className="p-0.5 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}><Plus className="w-3 h-3" /></button>} />)}
            </FileSection>
          )}
          {staged.length === 0 && changed.length === 0 && untracked.length === 0 && (
            <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>No changes detected.</div>
          )}
        </div>

        {/* Commits */}
        <div className="shrink-0 flex flex-col" style={{ borderTop: '1px solid var(--border)', maxHeight: commitsOpen ? '50%' : 'auto' }}>
          <button onClick={() => setCommitsOpen(!commitsOpen)} className="flex items-center w-full px-3 py-1.5 text-xs font-semibold uppercase tracking-wider shrink-0" style={{ color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }}>
            {commitsOpen ? <ChevronDown className="w-3 h-3 mr-1" /> : <ChevronRight className="w-3 h-3 mr-1" />}
            Commits <span className="ml-1 opacity-60">({commits.length})</span>
          </button>
          {commitsOpen && (
            <div className="flex-1 min-h-0 overflow-y-auto">
              {commits.map(c => (
                <div key={c.hash} onClick={() => handleViewCommit(c)} className="flex items-start gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors"
                  style={{ borderBottom: '1px solid var(--border)', background: detail?.type === 'commit' && detail.hash === c.hash ? 'var(--bg-tertiary)' : 'transparent' }}>
                  {remoteUrl ? (
                    <a href={`${remoteUrl}/commit/${c.hash}`} target="_blank" rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="shrink-0 font-mono hover:underline" style={{ color: 'var(--accent)', opacity: 0.8 }}>{c.hash.slice(0, 7)}</a>
                  ) : (
                    <span className="shrink-0 font-mono" style={{ color: 'var(--accent)', opacity: 0.8 }}>{c.hash.slice(0, 7)}</span>
                  )}
                  <span className="truncate flex-1" style={{ color: 'var(--text-primary)' }}>{c.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      )}

      {/* Resize handle */}
      {!leftCollapsed && (
        <div
          onMouseDown={startDragging}
          className="shrink-0 h-full"
          style={{
            width: 4,
            cursor: 'col-resize',
            background: 'var(--border)',
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent, #4a9eff)')}
          onMouseLeave={(e) => { if (!isDraggingRef.current) e.currentTarget.style.background = 'var(--border)'; }}
        />
      )}

      {/* ===== RIGHT PANE ===== */}
      <div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
        {!detail && (
          <div className="flex-1 flex items-center justify-center text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {leftCollapsed ? (
              <button onClick={() => setLeftCollapsed(false)} className="flex items-center gap-1.5 px-3 py-1.5 rounded transition-colors hover:bg-[var(--bg-tertiary)]" style={{ color: 'var(--text-secondary)' }}>
                <PanelLeftOpen className="w-4 h-4" /> Show sidebar
              </button>
            ) : 'Click a changed file to view its diff, or a commit to see its details.'}
          </div>
        )}

        {detail && (
          <>
            {/* Toolbar */}
            <div className="flex items-center justify-between px-3 py-1.5 shrink-0 gap-2" style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}>
              <div className="flex items-center gap-1.5 min-w-0">
                {leftCollapsed && (
                  <button onClick={() => setLeftCollapsed(false)} title="Show sidebar" className="p-1 rounded transition-colors hover:bg-white/10 shrink-0" style={{ color: 'var(--text-secondary)' }}>
                    <PanelLeftOpen className="w-3.5 h-3.5" />
                  </button>
                )}
                <span className="text-xs font-medium truncate" style={{ color: 'var(--text-secondary)' }}>
                  {detail.type === 'diff' ? `${detail.path}${detail.staged ? ' (staged)' : ''}` : `${detail.hash.slice(0, 7)} — ${detail.message}`}
                </span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <ToggleBtn active={diffMode === 'unified'} onClick={() => setDiffMode('unified')} title="Unified diff"><Rows3 className="w-3.5 h-3.5" /></ToggleBtn>
                <ToggleBtn active={diffMode === 'split'} onClick={() => setDiffMode('split')} title="Side-by-side diff"><Columns2 className="w-3.5 h-3.5" /></ToggleBtn>
                <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border)' }} />
                <ToggleBtn active={fullFile} onClick={() => setFullFile(!fullFile)} title={fullFile ? 'Full file context' : 'Diff hunks only'}><FileText className="w-3.5 h-3.5" /></ToggleBtn>
                <ToggleBtn active={ignoreWhitespace} onClick={() => setIgnoreWhitespace(!ignoreWhitespace)} title={ignoreWhitespace ? 'Ignoring whitespace' : 'Showing all changes'}><Space className="w-3.5 h-3.5" /></ToggleBtn>
                <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border)' }} />
                {onOpenInExplorer && detail.type === 'diff' && (
                  <button onClick={() => onOpenInExplorer(`${projectPath.replace(/\/$/, '')}/${detail.path}`)} title="Reveal in file explorer" className="p-1 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}><FolderTree className="w-3.5 h-3.5" /></button>
                )}
                <button onClick={() => setDetail(null)} className="p-1 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}><X className="w-3.5 h-3.5" /></button>
              </div>
            </div>

            {/* Commit file selector */}
            {detail.type === 'commit' && commitFiles.length > 1 && (
              <div className="flex items-center gap-1 px-2 py-1 shrink-0 overflow-x-auto" style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
                <button onClick={() => setSelectedCommitFile(null)}
                  className="px-2 py-0.5 text-xs rounded shrink-0 transition-colors"
                  style={{ background: !selectedCommitFile ? 'var(--accent)' : 'var(--bg-tertiary)', color: !selectedCommitFile ? '#fff' : 'var(--text-secondary)' }}>
                  All
                </button>
                {commitFiles.map(f => (
                  <button key={f.path} onClick={() => setSelectedCommitFile(f.path)}
                    className="flex items-center gap-1 px-2 py-0.5 text-xs rounded shrink-0 transition-colors"
                    style={{ background: selectedCommitFile === f.path ? 'var(--accent)' : 'var(--bg-tertiary)', color: selectedCommitFile === f.path ? '#fff' : 'var(--text-secondary)' }}>
                    <span style={{ color: selectedCommitFile === f.path ? '#fff' : statusColor(f.status) }}>{f.status}</span>
                    {f.path.split('/').pop()}
                  </button>
                ))}
              </div>
            )}

            {detailLoading ? (
              <div className="flex-1 flex items-center justify-center"><RefreshCw className="w-4 h-4 animate-spin" style={{ color: 'var(--text-secondary)' }} /></div>
            ) : (
              <DiffViewer
                diff={displayDiff}
                mode={diffMode}
                isEditable={!!isEditable}
                filePath={editFilePath}
                projectPath={projectPath}
                onDiffChanged={handleDiffChanged}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ================================================================
   Diff viewer with hunk navigation + editing
   ================================================================ */

interface DiffViewerProps {
  diff: string;
  mode: DiffMode;
  isEditable: boolean;
  filePath?: string;
  projectPath?: string;
  onDiffChanged?: () => void;
}

function DiffViewer({ diff, mode, isEditable, filePath, projectPath: _projectPath, onDiffChanged }: DiffViewerProps) {
  const [currentHunk, setCurrentHunk] = useState(0);
  const [revertedHunks, setRevertedHunks] = useState<Set<number>>(new Set());
  const [undoHistory, setUndoHistory] = useState<number[]>([]);
  const [editedLines, setEditedLines] = useState<Map<number, string>>(new Map());
  const [saving, setSaving] = useState(false);

  const hunks = useMemo(() => parseHunks(diff), [diff]);

  // Reset state when diff changes
  useEffect(() => {
    setCurrentHunk(0);
    setRevertedHunks(new Set());
    setUndoHistory([]);
    setEditedLines(new Map());
  }, [diff]);

  const dirty = editedLines.size > 0 || revertedHunks.size > 0;
  const changeCount = editedLines.size + revertedHunks.size;

  if (!diff) return <div className="flex-1 flex items-center justify-center text-xs" style={{ color: 'var(--text-tertiary)' }}>No diff available (new or binary file?)</div>;

  const goToHunk = (idx: number) => {
    const clamped = Math.max(0, Math.min(idx, hunks.length - 1));
    setCurrentHunk(clamped);
  };

  // Undo: visually revert the current hunk (in-memory only, no file I/O)
  const handleUndo = () => {
    if (hunks.length === 0) return;
    const hunkIdx = currentHunk;
    if (revertedHunks.has(hunkIdx)) return; // already reverted

    setRevertedHunks(prev => {
      const next = new Set(prev);
      next.add(hunkIdx);
      return next;
    });
    setUndoHistory(prev => [...prev, hunkIdx]);
  };

  // Redo: restore the last undone hunk (in-memory only)
  const handleRedo = () => {
    if (undoHistory.length === 0) return;
    const lastIdx = undoHistory[undoHistory.length - 1];

    setRevertedHunks(prev => {
      const next = new Set(prev);
      next.delete(lastIdx);
      return next;
    });
    setUndoHistory(prev => prev.slice(0, -1));
  };

  // Save: apply all in-memory reverts + edits to file, then refresh
  const handleSave = async () => {
    if (!filePath || !dirty) return;
    setSaving(true);
    try {
      const fileData = await api.files.read(filePath);
      const lines = fileData.content.split('\n');

      // Apply reverted hunks (process from bottom to top to avoid offset issues)
      // Replace the full hunk range (newStart..newStart+newCount-1) with old content
      const sortedReverted = [...revertedHunks]
        .map(idx => hunks[idx])
        .filter(Boolean)
        .sort((a, b) => b.newStart - a.newStart);

      for (const hunk of sortedReverted) {
        const start = hunk.newStart - 1;
        const deleteCount = hunk.newCount;
        lines.splice(start, deleteCount, ...hunk.oldContent);
      }

      // Apply edited lines (adjust for any offset from reverts above)
      // Note: edited lines reference the NEW file's line numbers, so if we've
      // already reverted some hunks, those line numbers may have shifted.
      // For simplicity, apply edits only to non-reverted regions.
      for (const [lineNum, newText] of editedLines) {
        if (lineNum > 0 && lineNum <= lines.length) {
          lines[lineNum - 1] = newText;
        }
      }

      await api.files.write(filePath, lines.join('\n'));
      setRevertedHunks(new Set());
      setUndoHistory([]);
      setEditedLines(new Map());
      onDiffChanged?.();
    } catch (err) {
      console.error('Failed to save changes:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleLineEdit = (lineNum: number, text: string) => {
    setEditedLines(prev => {
      const next = new Map(prev);
      next.set(lineNum, text);
      return next;
    });
  };

  return (
    <>
      {/* Hunk navigation bar */}
      {hunks.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1 shrink-0" style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
          <button onClick={() => goToHunk(currentHunk - 1)} disabled={currentHunk === 0}
            className="p-0.5 rounded hover:bg-white/10 disabled:opacity-30 transition-colors" style={{ color: 'var(--text-secondary)' }} title="Previous change">
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs font-mono tabular-nums" style={{ color: 'var(--text-secondary)' }}>
            {currentHunk + 1}/{hunks.length}
          </span>
          <button onClick={() => goToHunk(currentHunk + 1)} disabled={currentHunk >= hunks.length - 1}
            className="p-0.5 rounded hover:bg-white/10 disabled:opacity-30 transition-colors" style={{ color: 'var(--text-secondary)' }} title="Next change">
            <ArrowDown className="w-3.5 h-3.5" />
          </button>

          {isEditable && (
            <>
              <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border)' }} />
              <button onClick={handleUndo} disabled={hunks.length === 0 || revertedHunks.has(currentHunk)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs hover:bg-white/10 disabled:opacity-30 transition-colors"
                style={{ color: 'var(--text-secondary)' }} title="Revert this change (undo)">
                <Undo2 className="w-3 h-3" />
                <span>Undo</span>
              </button>
              <button onClick={handleRedo} disabled={undoHistory.length === 0}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs hover:bg-white/10 disabled:opacity-30 transition-colors"
                style={{ color: 'var(--text-secondary)' }} title="Reapply last undone change (redo)">
                <Redo2 className="w-3 h-3" />
                <span>Redo</span>
              </button>

              {dirty && (
                <>
                  <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border)' }} />
                  <button onClick={handleSave} disabled={saving}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors"
                    style={{ background: 'var(--accent)', color: '#fff' }}>
                    <Save className="w-3 h-3" />
                    {saving ? 'Saving...' : `Save (${changeCount})`}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}

      {mode === 'unified'
        ? <UnifiedDiff diff={diff} currentHunk={currentHunk} hunks={hunks} onHunkClick={goToHunk} revertedHunks={revertedHunks} />
        : <SplitDiff diff={diff} currentHunk={currentHunk} hunks={hunks} onHunkClick={goToHunk}
            isEditable={isEditable} onLineEdit={handleLineEdit} editedLines={editedLines} revertedHunks={revertedHunks} />
      }
    </>
  );
}

/* (Diff components imported from DiffComponents.tsx) */

function ToggleBtn({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} className="p-1 rounded transition-colors"
      style={{ background: active ? 'var(--bg-tertiary)' : 'transparent', color: active ? 'var(--accent)' : 'var(--text-tertiary)' }}>
      {children}
    </button>
  );
}

/* ================================================================
   Left-pane sub-components
   ================================================================ */

function FileSection({ title, count, open, onToggle, headerActions, children }: {
  title: string; count: number; open: boolean; onToggle: () => void; headerActions?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div onClick={onToggle} className="flex items-center w-full px-3 py-1.5 text-xs font-semibold uppercase tracking-wider group cursor-pointer" style={{ color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }}>
        {open ? <ChevronDown className="w-3 h-3 mr-1" /> : <ChevronRight className="w-3 h-3 mr-1" />}
        {title}<span className="ml-1 opacity-60">({count})</span>
        {headerActions && <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>{headerActions}</span>}
      </div>
      {open && children}
    </div>
  );
}

function FileRow({ path, status, isActive, onClick, actions, selected, onSelect, onReveal }: {
  path: string; status: string; isActive: boolean; onClick: () => void; actions: React.ReactNode;
  selected?: boolean; onSelect?: () => void; onReveal?: () => void;
}) {
  const fileName = path.split('/').pop() || path;
  const dirPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return (
    <div onClick={onClick} className="flex items-center gap-1.5 px-3 py-1 text-xs cursor-pointer group transition-colors hover:bg-[var(--bg-tertiary)]"
      style={{ background: isActive ? 'var(--bg-tertiary)' : selected ? 'rgba(88,166,255,0.08)' : 'transparent' }} title={`${statusLabel(status)}: ${path}`}>
      {onSelect && (
        <input type="checkbox" checked={!!selected} onChange={e => { e.stopPropagation(); onSelect(); }}
          onClick={e => e.stopPropagation()}
          className="shrink-0 w-3.5 h-3.5 rounded accent-[var(--accent)]" style={{ cursor: 'pointer' }} />
      )}
      <span className="shrink-0 font-mono font-bold w-4 text-center" style={{ color: statusColor(status) }}>{status}</span>
      <span className="truncate flex-1" style={{ color: 'var(--text-primary)' }}>{fileName}{dirPath && <span className="ml-1" style={{ color: 'var(--text-tertiary)' }}>{dirPath}</span>}</span>
      <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {onReveal && (
          <button onClick={e => { e.stopPropagation(); onReveal(); }} title="Reveal in file explorer"
            className="p-0.5 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}>
            <FolderTree className="w-3 h-3" />
          </button>
        )}
        {actions}
      </span>
    </div>
  );
}
