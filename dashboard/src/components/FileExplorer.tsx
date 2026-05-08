import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Folder, FolderOpen, File, ChevronRight, ChevronDown, ChevronUp, Loader2, Save, Circle, Eye, Pencil, Home, X, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, GitCompareArrows, FolderOpen as FolderOpenIcon, Terminal, Scissors, Copy as CopyIcon, Clipboard, Trash2, Edit3 } from 'lucide-react';
import { api, type FileEntry } from '../lib/api';
import { ConfirmModal } from './ConfirmModal';
import {
  type HunkInfo,
  parseHunks,
  parseSplitRows,
  SplitHalf,
  OverviewRuler,
  MONO,
  ROW_H,
  HUNK_HIGHLIGHT,
} from './DiffComponents';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown as markdownLang } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { oneDark } from '@codemirror/theme-one-dark';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface FileExplorerProps {
  rootPath: string;
  instanceId?: string; // unique ID for localStorage persistence
  refreshFilePath?: string | null; // when set, reload this file if it's open and not dirty
  openFileRequest?: { path: string; key: number } | null; // when key changes, open & reveal this file
  onFileSaved?: (filePath: string) => void; // notify parent when a file is saved
}

interface TreeNode {
  entry: FileEntry;
  fullPath: string;
  children?: TreeNode[];
  loaded: boolean;
  expanded: boolean;
}

interface FileTab {
  path: string;
  name: string;
  pinned: boolean;
  content: string;        // original from disk
  editedContent: string;  // current in editor
  extension: string;
  size: number;
  viewMode: 'edit' | 'preview';
}

interface CompareState {
  leftPath: string;
  rightPath: string;
  diff: string;
  hunks: HunkInfo[];
  leftContent: string;   // in-memory content (may have applied hunks)
  rightContent: string;   // in-memory content (may have applied hunks)
  appliedHunks: Map<number, 'left' | 'right'>; // hunkIndex → direction applied
}

interface PersistedExplorerState {
  expandedPaths: string[];
  selectedFile: string | null;
  currentPath?: string;
  openTabPaths?: { path: string; pinned: boolean }[];
  activeTabPath?: string | null;
  showHidden?: boolean;
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);

function isMarkdownFile(ext: string) {
  return MARKDOWN_EXTENSIONS.has(ext);
}

function getLanguageExtension(ext: string) {
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': case 'cjs':
      return javascript({ jsx: true });
    case 'ts': case 'tsx': case 'mts': case 'cts':
      return javascript({ jsx: true, typescript: true });
    case 'py': case 'pyw':
      return python();
    case 'json': case 'jsonc':
      return json();
    case 'html': case 'htm': case 'svg':
      return html();
    case 'css': case 'scss': case 'less':
      return css();
    case 'md': case 'mdx': case 'markdown':
      return markdownLang();
    case 'rs':
      return rust();
    case 'java':
      return java();
    case 'c': case 'h': case 'cpp': case 'hpp': case 'cc': case 'cxx':
      return cpp();
    default:
      return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function explorerStorageKey(instanceId: string) {
  return `octoally-explorer-${instanceId}`;
}

function loadExplorerState(instanceId: string): PersistedExplorerState | null {
  try {
    const raw = localStorage.getItem(explorerStorageKey(instanceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.expandedPaths)) return parsed;
  } catch {}
  return null;
}

function saveExplorerState(instanceId: string, state: PersistedExplorerState) {
  try {
    localStorage.setItem(explorerStorageKey(instanceId), JSON.stringify(state));
  } catch {}
}

// Collect all expanded paths from the tree
function getExpandedPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.expanded) {
      paths.push(node.fullPath);
      if (node.children) {
        paths.push(...getExpandedPaths(node.children));
      }
    }
  }
  return paths;
}

interface ContextMenuItem {
  kind?: 'item' | 'separator';
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

function ContextMenu({ x, y, items, onClose }: ContextMenuState & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    // Adjust position if menu would overflow viewport
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      let nx = x;
      let ny = y;
      if (x + rect.width > window.innerWidth - 8) nx = Math.max(8, window.innerWidth - rect.width - 8);
      if (y + rect.height > window.innerHeight - 8) ny = Math.max(8, window.innerHeight - rect.height - 8);
      if (nx !== x || ny !== y) setPos({ x: nx, y: ny });
    }
    const onDown = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[60] rounded-md shadow-lg py-1 text-xs"
      style={{
        left: pos.x,
        top: pos.y,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        minWidth: 200,
        color: 'var(--text-primary)',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.kind === 'separator') {
          return <div key={i} className="my-1" style={{ borderTop: '1px solid var(--border)' }} />;
        }
        return (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => { if (!item.disabled && item.onClick) { item.onClick(); onClose(); } }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{ color: item.danger ? 'var(--error)' : 'var(--text-primary)' }}
          >
            <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function TreeItem({
  node,
  depth,
  onToggle,
  onFileClick,
  onFileDoubleClick,
  onContextMenu,
  selectedPath,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  cutPath,
}: {
  node: TreeNode;
  depth: number;
  onToggle: (path: string) => void;
  onFileClick: (path: string) => void;
  onFileDoubleClick: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  selectedPath: string | null;
  renamingPath: string | null;
  onRenameSubmit: (path: string, newName: string) => void;
  onRenameCancel: () => void;
  cutPath: string | null;
}) {
  const isDir = node.entry.type === 'directory';
  const isSelected = node.fullPath === selectedPath;
  const isRenaming = renamingPath === node.fullPath;
  const isCut = cutPath === node.fullPath;
  const [loading, setLoading] = useState(false);
  const [renameValue, setRenameValue] = useState(node.entry.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(node.entry.name);
      // Focus input and select the basename (excluding extension) for files
      setTimeout(() => {
        const el = renameInputRef.current;
        if (!el) return;
        el.focus();
        const name = node.entry.name;
        const dotIdx = !isDir && name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length;
        el.setSelectionRange(0, dotIdx);
      }, 0);
    }
  }, [isRenaming, node.entry.name, isDir]);

  function handleClick() {
    if (isRenaming) return;
    if (isDir) {
      setLoading(true);
      onToggle(node.fullPath);
      setTimeout(() => setLoading(false), 500);
    } else {
      onFileClick(node.fullPath);
    }
  }

  function handleDoubleClick() {
    if (isRenaming) return;
    if (!isDir) {
      onFileDoubleClick(node.fullPath);
    }
  }

  function commitRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === node.entry.name) {
      onRenameCancel();
      return;
    }
    onRenameSubmit(node.fullPath, trimmed);
  }

  return (
    <>
      <button
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
        data-filepath={node.fullPath}
        className="flex items-center gap-1 w-full text-left text-xs py-0.5 px-2 hover:bg-[var(--bg-tertiary)] transition-colors"
        style={{
          paddingLeft: `${depth * 16 + 8}px`,
          color: isSelected ? 'var(--accent)' : 'var(--text-primary)',
          background: isSelected ? 'var(--bg-tertiary)' : undefined,
          opacity: isCut ? 0.5 : 1,
        }}
      >
        {isDir ? (
          loading && !node.loaded ? (
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" style={{ color: 'var(--text-secondary)' }} />
          ) : node.expanded ? (
            <ChevronDown className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}

        {isDir ? (
          node.expanded ? (
            <FolderOpen className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
          ) : (
            <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
          )
        ) : (
          <File className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} />
        )}

        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onRenameCancel();
              }
            }}
            onBlur={commitRename}
            className="flex-1 min-w-0 text-xs px-1 py-0 rounded"
            style={{
              background: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--accent)',
              outline: 'none',
              fontFamily: 'inherit',
            }}
            spellCheck={false}
          />
        ) : (
          <span className="truncate">{node.entry.name}</span>
        )}
      </button>

      {isDir && node.expanded && node.children?.map((child) => (
        <TreeItem
          key={child.fullPath}
          node={child}
          depth={depth + 1}
          onToggle={onToggle}
          onFileClick={onFileClick}
          onFileDoubleClick={onFileDoubleClick}
          onContextMenu={onContextMenu}
          selectedPath={selectedPath}
          renamingPath={renamingPath}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
          cutPath={cutPath}
        />
      ))}
    </>
  );
}

export function FileExplorer({ rootPath, instanceId, refreshFilePath, openFileRequest, onFileSaved }: FileExplorerProps) {
  // Resolve initial path from persisted state or prop
  const [initialState] = useState(() => instanceId ? loadExplorerState(instanceId) : null);
  const [currentPath, setCurrentPath] = useState(initialState?.currentPath ?? rootPath);
  const [pathInput, setPathInput] = useState(initialState?.currentPath ?? rootPath);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [rootLoaded, setRootLoaded] = useState(false);
  const [showHidden, setShowHidden] = useState(initialState?.showHidden ?? false);
  const restoringRef = useRef(false);
  const treeScrollRef = useRef<HTMLDivElement>(null);

  // Tab state
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);

  // Resizable tree panel
  const [treePanelWidth, setTreePanelWidth] = useState(280);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const newWidth = Math.min(Math.max(e.clientX - (containerRef.current?.getBoundingClientRect().left ?? 0), 120), 600);
      setTreePanelWidth(newWidth);
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

  const containerRef = useRef<HTMLDivElement>(null);

  const startDragging = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // Compare mode
  const [compareState, setCompareState] = useState<CompareState | null>(null);
  const [compareSelecting, setCompareSelecting] = useState<string | null>(null); // first selected path
  const [compareHunk, setCompareHunk] = useState(0);

  function handleCompareHunkNav(delta: number) {
    if (!compareState) return;
    const total = compareState.hunks.length;
    if (total === 0) return;
    setCompareHunk(prev => ((prev + delta) % total + total) % total);
  }

  // Shared loading/error state
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Context menu / file ops state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ path: string; isDir: boolean } | null>(null);
  const [clipboard, setClipboard] = useState<{ kind: 'cut' | 'copy'; path: string; isDir: boolean } | null>(null);
  const [actionMessage, setActionMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    if (!actionMessage) return;
    const t = setTimeout(() => setActionMessage(null), 3500);
    return () => clearTimeout(t);
  }, [actionMessage]);

  // Derived state
  const activeTab = tabs.find(t => t.path === activeTabPath) ?? null;
  const isDirty = activeTab ? activeTab.editedContent !== activeTab.content : false;
  const isMarkdown = activeTab ? isMarkdownFile(activeTab.extension) : false;

  // Helper to update a specific tab
  function updateTab(path: string, updates: Partial<FileTab>) {
    setTabs(prev => prev.map(t => t.path === path ? { ...t, ...updates } : t));
  }

  // Reveal a file in the tree: expand ancestor folders and scroll to it
  async function revealFileInTree(filePath: string) {
    if (!filePath.startsWith(currentPath)) return;

    const relative = filePath.slice(currentPath.length + 1);
    const parts = relative.split('/');
    parts.pop(); // remove file name — we only need directories

    // Expand each ancestor directory
    let dirPath = currentPath;
    for (const part of parts) {
      dirPath = `${dirPath}/${part}`;
      const capturedDir = dirPath;

      try {
        const data = await api.files.list(capturedDir, showHidden);
        setTree(prev => {
          // Use functional updater to see latest state
          const node = findNodeInTree(prev, capturedDir);
          if (!node) return prev;
          if (node.loaded && node.expanded) return prev; // already good
          return updateNodeInTree(prev, capturedDir, {
            children: data.files.map(f => ({
              entry: f,
              fullPath: `${capturedDir}/${f.name}`,
              children: undefined,
              loaded: false,
              expanded: false,
            })),
            loaded: true,
            expanded: true,
          });
        });
      } catch {
        return; // can't expand — stop here
      }
    }

    // After React renders the expanded tree, scroll to the file
    setTimeout(() => {
      const el = treeScrollRef.current?.querySelector(`[data-filepath="${CSS.escape(filePath)}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  // Find a node by path in the tree
  function findNodeInTree(nodes: TreeNode[], path: string): TreeNode | null {
    for (const node of nodes) {
      if (node.fullPath === path) return node;
      if (node.children) {
        const found = findNodeInTree(node.children, path);
        if (found) return found;
      }
    }
    return null;
  }

  // Reveal active file in tree when switching tabs
  const revealingRef = useRef(false);
  useEffect(() => {
    if (!activeTabPath || restoringRef.current || revealingRef.current) return;
    revealingRef.current = true;
    revealFileInTree(activeTabPath).finally(() => { revealingRef.current = false; });
  }, [activeTabPath]);

  // Open a file as a preview (single-click) or pinned (double-click)
  async function openFile(path: string, pin: boolean) {
    // If already open, just switch to it (and pin if double-click)
    const existing = tabs.find(t => t.path === path);
    if (existing) {
      if (pin) updateTab(path, { pinned: true });
      setActiveTabPath(path);
      return;
    }

    setFileLoading(true);
    setFileError(null);
    try {
      const data = await api.files.read(path);
      const newTab: FileTab = {
        path: data.path,
        name: path.split('/').pop() || path,
        pinned: pin,
        content: data.content,
        editedContent: data.content,
        extension: data.extension,
        size: data.size,
        viewMode: isMarkdownFile(data.extension) ? 'preview' : 'edit',
      };

      setTabs(prev => {
        if (!pin) {
          // Replace existing preview tab (if not dirty)
          const previewIdx = prev.findIndex(t => !t.pinned);
          if (previewIdx >= 0) {
            const preview = prev[previewIdx];
            if (preview.editedContent !== preview.content) {
              // Preview is dirty — auto-pin it and add new preview at end
              return [...prev.map((t, i) => i === previewIdx ? { ...t, pinned: true } : t), newTab];
            }
            // Replace the preview tab
            const next = [...prev];
            next[previewIdx] = newTab;
            return next;
          }
        }
        return [...prev, newTab];
      });
      setActiveTabPath(data.path);
    } catch (err: any) {
      setFileError(err.message || 'Failed to read file');
    } finally {
      setFileLoading(false);
    }
  }

  function handleFileClick(path: string) {
    openFile(path, false);
  }

  function handleFileDoubleClick(path: string) {
    openFile(path, true);
  }

  function closeTab(path: string) {
    const idx = tabs.findIndex(t => t.path === path);
    setTabs(prev => prev.filter(t => t.path !== path));
    if (activeTabPath === path) {
      const remaining = tabs.filter(t => t.path !== path);
      if (remaining.length > 0) {
        // Switch to neighbor tab
        const newIdx = Math.min(idx, remaining.length - 1);
        setActiveTabPath(remaining[newIdx].path);
      } else {
        setActiveTabPath(null);
      }
    }
  }

  // Start compare flow: user clicks compare button, then clicks two tabs
  function startCompare() {
    if (compareState) {
      // Exit compare mode
      setCompareState(null);
      setCompareSelecting(null);
      return;
    }
    // If already selecting, cancel
    if (compareSelecting) {
      setCompareSelecting(null);
      return;
    }
    // Start selecting first file
    setCompareSelecting('waiting');
  }

  async function selectForCompare(path: string) {
    if (!compareSelecting) return;

    if (compareSelecting === 'waiting') {
      // First pick
      setCompareSelecting(path);
      return;
    }

    // Second pick — start the diff
    const leftPath = compareSelecting;
    const rightPath = path;
    if (leftPath === rightPath) {
      setCompareSelecting(null);
      return;
    }

    setCompareSelecting(null);
    setFileLoading(true);
    try {
      const { diff } = await api.files.diff(leftPath, rightPath);
      const hunks = parseHunks(diff);
      const leftTab = tabs.find(t => t.path === leftPath);
      const rightTab = tabs.find(t => t.path === rightPath);
      const leftContent = leftTab?.editedContent ?? (await api.files.read(leftPath)).content;
      const rightContent = rightTab?.editedContent ?? (await api.files.read(rightPath)).content;

      setCompareState({
        leftPath,
        rightPath,
        diff,
        hunks,
        leftContent,
        rightContent,
        appliedHunks: new Map(),
      });
      setCompareHunk(0);
    } catch (err: any) {
      setFileError(err.message || 'Failed to compare files');
    } finally {
      setFileLoading(false);
    }
  }

  // Apply a hunk from one side to the other
  function applyHunk(hunkIndex: number, direction: 'left' | 'right') {
    if (!compareState) return;
    const hunk = compareState.hunks[hunkIndex];
    if (!hunk) return;

    // direction 'right' = copy left content to right file (replace new lines with old lines)
    // direction 'left' = copy right content to left file (replace old lines with new lines)
    const newApplied = new Map(compareState.appliedHunks);
    if (newApplied.get(hunkIndex) === direction) {
      // Toggle off — undo this apply
      newApplied.delete(hunkIndex);
    } else {
      newApplied.set(hunkIndex, direction);
    }
    setCompareState({ ...compareState, appliedHunks: newApplied });
  }

  // Build the effective content for a side after applying hunks
  // Build the effective content for a side after applying hunk choices.
  // Semantics: 'left' arrow = keep left (right file adopts left content for this hunk)
  //            'right' arrow = accept right (left file adopts right content for this hunk)
  function buildEffectiveContent(side: 'left' | 'right'): string {
    if (!compareState) return '';
    const isLeft = side === 'left';
    let lines = (isLeft ? compareState.leftContent : compareState.rightContent).split('\n');

    // Collect hunks that affect this side
    const applicableHunks: { hunk: HunkInfo; dir: 'left' | 'right' }[] = [];
    for (const [idx, dir] of compareState.appliedHunks) {
      const hunk = compareState.hunks[idx];
      if (!hunk) continue;
      // 'right' arrow = accept right → left file changes (adopts right/new content)
      // 'left' arrow = keep left → right file changes (adopts left/old content)
      if ((dir === 'right' && isLeft) || (dir === 'left' && !isLeft)) {
        applicableHunks.push({ hunk, dir });
      }
    }

    // Sort descending by the start line of the side being modified (apply from bottom up)
    applicableHunks.sort((a, b) => {
      const aStart = isLeft ? a.hunk.oldStart : a.hunk.newStart;
      const bStart = isLeft ? b.hunk.oldStart : b.hunk.newStart;
      return bStart - aStart;
    });

    for (const { hunk, dir } of applicableHunks) {
      if (dir === 'right' && isLeft) {
        // "Accept right" → replace left (old) content with right (new) content
        lines.splice(hunk.oldStart - 1, hunk.oldCount, ...hunk.newContent);
      } else if (dir === 'left' && !isLeft) {
        // "Keep left" → replace right (new) content with left (old) content
        lines.splice(hunk.newStart - 1, hunk.newCount, ...hunk.oldContent);
      }
    }

    return lines.join('\n');
  }

  // Save compare changes to disk
  async function saveCompareChanges() {
    if (!compareState || compareState.appliedHunks.size === 0) return;
    setSaving(true);
    setSaveMessage(null);

    try {
      // 'right' arrow = accept right → left file changes
      const leftChanged = [...compareState.appliedHunks.values()].some(d => d === 'right');
      // 'left' arrow = keep left → right file changes
      const rightChanged = [...compareState.appliedHunks.values()].some(d => d === 'left');

      if (leftChanged) {
        const newContent = buildEffectiveContent('left');
        await api.files.write(compareState.leftPath, newContent);
        const leftTab = tabs.find(t => t.path === compareState.leftPath);
        if (leftTab) updateTab(compareState.leftPath, { content: newContent, editedContent: newContent });
        onFileSaved?.(compareState.leftPath);
      }

      if (rightChanged) {
        const newContent = buildEffectiveContent('right');
        await api.files.write(compareState.rightPath, newContent);
        const rightTab = tabs.find(t => t.path === compareState.rightPath);
        if (rightTab) updateTab(compareState.rightPath, { content: newContent, editedContent: newContent });
        onFileSaved?.(compareState.rightPath);
      }

      setSaveMessage('Saved');
      setTimeout(() => setSaveMessage(null), 2000);

      // Re-fetch diff after save
      const { diff } = await api.files.diff(compareState.leftPath, compareState.rightPath);
      const hunks = parseHunks(diff);
      const leftContent = (await api.files.read(compareState.leftPath)).content;
      const rightContent = (await api.files.read(compareState.rightPath)).content;
      setCompareState({
        leftPath: compareState.leftPath,
        rightPath: compareState.rightPath,
        diff,
        hunks,
        leftContent,
        rightContent,
        appliedHunks: new Map(),
      });
      setCompareHunk(0);
    } catch (err: any) {
      setSaveMessage('Save failed');
      setTimeout(() => setSaveMessage(null), 3000);
    } finally {
      setSaving(false);
    }
  }

  // Save active tab
  const handleSave = useCallback(async () => {
    if (!activeTab || !isDirty) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const result = await api.files.write(activeTab.path, activeTab.editedContent);
      updateTab(activeTab.path, { content: activeTab.editedContent, size: result.size });
      setSaveMessage('Saved');
      onFileSaved?.(activeTab.path);
      setTimeout(() => setSaveMessage(null), 2000);
    } catch (err: any) {
      setSaveMessage('Save failed');
      setTimeout(() => setSaveMessage(null), 3000);
    } finally {
      setSaving(false);
    }
  }, [activeTab, isDirty]);

  // Ctrl+S / Cmd+S keyboard shortcut
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSave]);

  // External "open this file" request — e.g. user clicked an icon in the git panel
  const lastOpenRequestKey = useRef<number | null>(null);
  useEffect(() => {
    if (!openFileRequest) return;
    if (openFileRequest.key === lastOpenRequestKey.current) return;
    lastOpenRequestKey.current = openFileRequest.key;
    // Defer until root has loaded so reveal can find the node
    if (!rootLoaded) return;
    openFile(openFileRequest.path, true);
    // openFile sets activeTabPath, which the existing reveal effect picks up
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFileRequest, rootLoaded]);

  // Refresh open tab when another view (e.g. git diff) saved it
  const lastRefreshPath = useRef<string | null>(null);
  useEffect(() => {
    if (!refreshFilePath || refreshFilePath === lastRefreshPath.current) return;
    lastRefreshPath.current = refreshFilePath;

    // Find any open tab matching this path that isn't dirty
    const tab = tabs.find(t => t.path === refreshFilePath);
    if (tab && tab.editedContent === tab.content) {
      api.files.read(refreshFilePath).then((data) => {
        updateTab(refreshFilePath, {
          content: data.content,
          editedContent: data.content,
          size: data.size,
        });
      }).catch(() => {});
    }
  }, [refreshFilePath, tabs]);

  // Persist explorer state on changes
  useEffect(() => {
    if (!instanceId || !rootLoaded || restoringRef.current) return;
    const expandedPaths = getExpandedPaths(tree);
    saveExplorerState(instanceId, {
      expandedPaths,
      selectedFile: activeTabPath,
      currentPath,
      openTabPaths: tabs.map(t => ({ path: t.path, pinned: t.pinned })),
      activeTabPath,
      showHidden,
    });
  }, [instanceId, tree, activeTabPath, rootLoaded, currentPath, tabs, showHidden]);

  // Load root directory and restore persisted state
  const loadRoot = useCallback(async () => {
    if (rootLoaded) return;
    try {
      const data = await api.files.list(currentPath, showHidden);
      const savedState = instanceId ? loadExplorerState(instanceId) : null;
      const expandedSet = new Set(savedState?.expandedPaths ?? []);

      const nodes: TreeNode[] = data.files.map((f) => ({
        entry: f,
        fullPath: `${currentPath}/${f.name}`,
        children: undefined,
        loaded: false,
        expanded: false,
      }));

      setTree(nodes);
      setRootLoaded(true);

      // Restore expanded directories
      if (savedState && expandedSet.size > 0) {
        restoringRef.current = true;
        await restoreExpandedPaths(nodes, expandedSet, rootPath);
        restoringRef.current = false;
      }

      // Restore open tabs
      if (savedState?.openTabPaths?.length) {
        restoringRef.current = true;
        const restoredTabs: FileTab[] = [];
        for (const { path, pinned } of savedState.openTabPaths) {
          try {
            const fileData = await api.files.read(path);
            restoredTabs.push({
              path: fileData.path,
              name: path.split('/').pop() || path,
              pinned,
              content: fileData.content,
              editedContent: fileData.content,
              extension: fileData.extension,
              size: fileData.size,
              viewMode: isMarkdownFile(fileData.extension) ? 'preview' : 'edit',
            });
          } catch {
            // File may have been deleted — skip
          }
        }
        if (restoredTabs.length > 0) {
          setTabs(restoredTabs);
          setActiveTabPath(savedState.activeTabPath ?? restoredTabs[0].path);
        }
        restoringRef.current = false;
      } else if (savedState?.selectedFile) {
        // Legacy: restore single selected file as a pinned tab
        restoringRef.current = true;
        try {
          const fileData = await api.files.read(savedState.selectedFile);
          setTabs([{
            path: fileData.path,
            name: savedState.selectedFile.split('/').pop() || savedState.selectedFile,
            pinned: true,
            content: fileData.content,
            editedContent: fileData.content,
            extension: fileData.extension,
            size: fileData.size,
            viewMode: isMarkdownFile(fileData.extension) ? 'preview' : 'edit',
          }]);
          setActiveTabPath(fileData.path);
        } catch {
          // File may have been deleted — just skip
        }
        restoringRef.current = false;
      }
    } catch (err) {
      console.error('Failed to load root directory:', err);
    }
  }, [currentPath, rootLoaded, instanceId, showHidden]);

  // Recursively restore expanded directories
  async function restoreExpandedPaths(currentNodes: TreeNode[], expandedSet: Set<string>, _rootPath: string) {
    // Find directories in current nodes that should be expanded
    const toExpand = currentNodes.filter(
      (n) => n.entry.type === 'directory' && expandedSet.has(n.fullPath)
    );

    for (const node of toExpand) {
      try {
        const data = await api.files.list(node.fullPath, showHidden);
        const children: TreeNode[] = data.files.map((f) => ({
          entry: f,
          fullPath: `${node.fullPath}/${f.name}`,
          children: undefined,
          loaded: false,
          expanded: false,
        }));

        // Update tree with this expanded node
        setTree((prev) =>
          updateNodeInTree(prev, node.fullPath, {
            children,
            loaded: true,
            expanded: true,
          })
        );

        // Recurse into children that also need expanding
        await restoreExpandedPaths(children, expandedSet, _rootPath);
      } catch {
        // Skip directories that can't be read
      }
    }
  }

  if (!rootLoaded) {
    loadRoot();
  }

  // Reload tree when showHidden changes
  const prevShowHidden = useRef(showHidden);
  useEffect(() => {
    if (prevShowHidden.current !== showHidden) {
      prevShowHidden.current = showHidden;
      setTree([]);
      setRootLoaded(false);
    }
  }, [showHidden]);

  function navigateTo(path: string) {
    const trimmed = path.trim().replace(/\/+$/, '') || '/';
    setCurrentPath(trimmed);
    setPathInput(trimmed);
    // Reset tree state so loadRoot fires again
    setTree([]);
    setRootLoaded(false);
    setFileError(null);
  }

  function navigateUp() {
    const parent = currentPath.replace(/\/[^/]+$/, '') || '/';
    navigateTo(parent);
  }

  function handlePathSubmit(e: React.FormEvent) {
    e.preventDefault();
    navigateTo(pathInput);
  }

  async function toggleDir(path: string) {
    setTree((prev) => toggleInTree(prev, path));
  }

  function toggleInTree(nodes: TreeNode[], path: string): TreeNode[] {
    return nodes.map((node) => {
      if (node.fullPath === path) {
        if (node.expanded) {
          return { ...node, expanded: false };
        }
        if (!node.loaded) {
          api.files.list(path, showHidden).then((data) => {
            setTree((prev) =>
              updateNodeInTree(prev, path, {
                children: data.files.map((f) => ({
                  entry: f,
                  fullPath: `${path}/${f.name}`,
                  children: undefined,
                  loaded: false,
                  expanded: false,
                })),
                loaded: true,
                expanded: true,
              })
            );
          });
          return { ...node, expanded: true };
        }
        return { ...node, expanded: true };
      }
      if (node.children) {
        return { ...node, children: toggleInTree(node.children, path) };
      }
      return node;
    });
  }

  function updateNodeInTree(nodes: TreeNode[], path: string, updates: Partial<TreeNode>): TreeNode[] {
    return nodes.map((node) => {
      if (node.fullPath === path) {
        return { ...node, ...updates };
      }
      if (node.children) {
        return { ...node, children: updateNodeInTree(node.children, path, updates) };
      }
      return node;
    });
  }

  function getParentDir(p: string): string {
    const idx = p.lastIndexOf('/');
    if (idx <= 0) return '/';
    return p.slice(0, idx);
  }

  // Reload one directory in the tree (or the whole root when dir === currentPath).
  // Preserves expanded state of unaffected subtrees by only replacing the children of the target.
  async function refreshDirectory(dir: string) {
    if (dir === currentPath) {
      setTree([]);
      setRootLoaded(false);
      return;
    }
    try {
      const data = await api.files.list(dir, showHidden);
      setTree(prev => {
        const node = findNodeInTree(prev, dir);
        if (!node) return prev;
        // Map new entries; preserve expanded/loaded/children for matching subdirs so we don't collapse the tree.
        const existingChildren = node.children ?? [];
        const newChildren: TreeNode[] = data.files.map(f => {
          const childPath = `${dir}/${f.name}`;
          const existing = existingChildren.find(c => c.fullPath === childPath);
          if (existing && existing.entry.type === f.type) {
            return { ...existing, entry: f };
          }
          return {
            entry: f,
            fullPath: childPath,
            children: undefined,
            loaded: false,
            expanded: false,
          };
        });
        return updateNodeInTree(prev, dir, {
          children: newChildren,
          loaded: true,
          expanded: true,
        });
      });
    } catch (err: any) {
      setActionMessage({ kind: 'error', text: err.message || 'Failed to refresh directory' });
    }
  }

  function openContextMenuFor(e: React.MouseEvent, node: TreeNode | null) {
    e.preventDefault();
    e.stopPropagation();
    const isDir = node ? node.entry.type === 'directory' : true;
    const targetPath = node?.fullPath ?? currentPath;
    const containingDir = node ? (isDir ? node.fullPath : getParentDir(node.fullPath)) : currentPath;

    const items: ContextMenuItem[] = [
      {
        kind: 'item',
        label: 'Open in OS file manager',
        icon: <FolderOpenIcon className="w-3.5 h-3.5" />,
        onClick: () => handleOpenInFolder(containingDir),
      },
      {
        kind: 'item',
        label: 'Open in terminal',
        icon: <Terminal className="w-3.5 h-3.5" />,
        onClick: () => handleOpenInTerminal(containingDir),
      },
    ];

    if (node) {
      items.push({ kind: 'separator' });
      items.push({
        kind: 'item',
        label: 'Cut',
        icon: <Scissors className="w-3.5 h-3.5" />,
        onClick: () => setClipboard({ kind: 'cut', path: node.fullPath, isDir }),
      });
      items.push({
        kind: 'item',
        label: 'Copy',
        icon: <CopyIcon className="w-3.5 h-3.5" />,
        onClick: () => setClipboard({ kind: 'copy', path: node.fullPath, isDir }),
      });
    }

    // Paste — only meaningful when target is a directory (or empty area)
    items.push({
      kind: 'item',
      label: clipboard ? `Paste ${clipboard.kind === 'cut' ? '(move)' : '(copy)'}` : 'Paste',
      icon: <Clipboard className="w-3.5 h-3.5" />,
      onClick: () => handlePaste(containingDir),
      disabled: !clipboard || (!isDir && !!node),
    });

    if (node) {
      items.push({ kind: 'separator' });
      items.push({
        kind: 'item',
        label: 'Rename',
        icon: <Edit3 className="w-3.5 h-3.5" />,
        onClick: () => setRenamingPath(node.fullPath),
      });
      items.push({
        kind: 'item',
        label: 'Delete',
        icon: <Trash2 className="w-3.5 h-3.5" />,
        danger: true,
        onClick: () => setPendingDelete({ path: targetPath, isDir }),
      });
    }

    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }

  async function handleOpenInFolder(path: string) {
    try {
      await api.openFolder(path);
    } catch (err: any) {
      setActionMessage({ kind: 'error', text: err.message || 'Failed to open folder' });
    }
  }

  async function handleOpenInTerminal(path: string) {
    try {
      await api.openTerminal(path);
    } catch (err: any) {
      setActionMessage({ kind: 'error', text: err.message || 'Failed to open terminal' });
    }
  }

  async function submitRename(path: string, newName: string) {
    setRenamingPath(null);
    try {
      const result = await api.files.rename(path, newName);
      // If a tab was open for the renamed file, update its path
      setTabs(prev => prev.map(t => t.path === path ? { ...t, path: result.path, name: newName } : t));
      if (activeTabPath === path) setActiveTabPath(result.path);
      // Clear clipboard reference if it pointed at the renamed item
      if (clipboard?.path === path) setClipboard(null);
      await refreshDirectory(getParentDir(path));
      setActionMessage({ kind: 'info', text: `Renamed to ${newName}` });
    } catch (err: any) {
      setActionMessage({ kind: 'error', text: err.message || 'Failed to rename' });
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const { path, isDir } = pendingDelete;
    setPendingDelete(null);
    try {
      await api.files.delete(path);
      // Close any tab pointing at the deleted file/folder
      setTabs(prev => prev.filter(t => t.path !== path && !t.path.startsWith(path + '/')));
      if (activeTabPath === path || activeTabPath?.startsWith(path + '/')) setActiveTabPath(null);
      if (clipboard?.path === path) setClipboard(null);
      await refreshDirectory(getParentDir(path));
      setActionMessage({ kind: 'info', text: `Deleted ${isDir ? 'folder' : 'file'}` });
    } catch (err: any) {
      setActionMessage({ kind: 'error', text: err.message || 'Failed to delete' });
    }
  }

  async function handlePaste(destDir: string) {
    if (!clipboard) return;
    const src = clipboard.path;
    const kind = clipboard.kind;
    const sourceParent = getParentDir(src);

    try {
      if (kind === 'cut') {
        await api.files.move(src, destDir);
        // Update any open tab whose path is being moved
        const newBase = `${destDir}/${src.split('/').pop()}`;
        setTabs(prev => prev.map(t => {
          if (t.path === src) return { ...t, path: newBase };
          if (t.path.startsWith(src + '/')) return { ...t, path: newBase + t.path.slice(src.length) };
          return t;
        }));
        if (activeTabPath === src) setActiveTabPath(newBase);
        else if (activeTabPath?.startsWith(src + '/')) setActiveTabPath(newBase + activeTabPath.slice(src.length));
        setClipboard(null);
      } else {
        await api.files.copy(src, destDir);
      }
      // Refresh both source and destination directory views
      if (sourceParent !== destDir) {
        await refreshDirectory(sourceParent);
      }
      await refreshDirectory(destDir);
      setActionMessage({ kind: 'info', text: kind === 'cut' ? 'Moved' : 'Copied' });
    } catch (err: any) {
      setActionMessage({ kind: 'error', text: err.message || `Failed to ${kind === 'cut' ? 'move' : 'copy'}` });
    }
  }

  // Build CodeMirror extensions for active tab
  const extensions = [];
  if (activeTab) {
    const langExt = getLanguageExtension(activeTab.extension);
    if (langExt) extensions.push(langExt);
  }

  return (
    <div ref={containerRef} className="h-full flex">
      {/* Tree panel */}
      <div
        className="h-full flex flex-col shrink-0"
        style={{
          width: treePanelWidth,
          background: 'var(--bg-primary)',
        }}
      >
        {/* Path bar */}
        <form
          onSubmit={handlePathSubmit}
          className="flex items-center gap-1 px-2 py-1.5 shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <button
            type="button"
            onClick={navigateUp}
            className="flex items-center justify-center rounded shrink-0 transition-colors hover:bg-[var(--bg-tertiary)]"
            style={{ width: 24, height: 24, color: 'var(--text-secondary)' }}
            title="Parent directory"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => navigateTo(rootPath)}
            className="flex items-center justify-center rounded shrink-0 transition-colors hover:bg-[var(--bg-tertiary)]"
            style={{ width: 24, height: 24, color: 'var(--text-secondary)' }}
            title="Project root"
          >
            <Home className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setShowHidden(h => !h)}
            className="flex items-center justify-center rounded shrink-0 transition-colors hover:bg-[var(--bg-tertiary)]"
            style={{ width: 24, height: 24, color: showHidden ? 'var(--accent)' : 'var(--text-tertiary)' }}
            title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
          >
            <Eye className="w-3.5 h-3.5" />
          </button>
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            className="flex-1 min-w-0 text-xs px-1.5 py-1 rounded"
            style={{
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              outline: 'none',
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            }}
            spellCheck={false}
          />
        </form>

        <div
          ref={treeScrollRef}
          className="flex-1 overflow-y-auto"
          onContextMenu={(e) => {
            // Right-click on empty area of the tree panel — context for currentPath
            if (e.target === e.currentTarget) openContextMenuFor(e, null);
          }}
        >
        {tree.map((node) => (
          <TreeItem
            key={node.fullPath}
            node={node}
            depth={0}
            onToggle={toggleDir}
            onFileClick={handleFileClick}
            onFileDoubleClick={handleFileDoubleClick}
            onContextMenu={openContextMenuFor}
            selectedPath={activeTabPath}
            renamingPath={renamingPath}
            onRenameSubmit={submitRename}
            onRenameCancel={() => setRenamingPath(null)}
            cutPath={clipboard?.kind === 'cut' ? clipboard.path : null}
          />
        ))}
        {tree.length === 0 && rootLoaded && (
          <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
            No files found
          </div>
        )}
        </div>
        {actionMessage && (
          <div
            className="px-2 py-1.5 text-xs shrink-0 truncate"
            style={{
              borderTop: '1px solid var(--border)',
              color: actionMessage.kind === 'error' ? 'var(--error)' : 'var(--text-secondary)',
              background: 'var(--bg-secondary)',
            }}
            title={actionMessage.text}
          >
            {actionMessage.text}
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={startDragging}
        className="shrink-0 h-full"
        style={{
          width: 4,
          cursor: 'col-resize',
          background: isDraggingRef.current ? 'var(--accent)' : 'var(--border)',
          transition: 'background 0.15s',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent, #4a9eff)')}
        onMouseLeave={(e) => { if (!isDraggingRef.current) e.currentTarget.style.background = 'var(--border)'; }}
      />

      {/* File editor / preview with tab bar */}
      <div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
        {/* Tab bar */}
        {tabs.length > 0 && (
          <div
            className="flex items-center gap-0.5 px-1 py-0.5 shrink-0 overflow-x-auto"
            style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
          >
            {tabs.map(tab => {
              const isActive = tab.path === activeTabPath;
              const tabDirty = tab.editedContent !== tab.content;
              const isCompareSelected = compareSelecting === tab.path;
              const isCompareTarget = compareSelecting && compareSelecting !== 'waiting' && compareSelecting !== tab.path;

              return (
                <div
                  key={tab.path}
                  className="flex items-center rounded-md shrink-0 group"
                  style={{
                    background: isCompareSelected
                      ? 'rgba(88,166,255,0.2)'
                      : isActive && !compareSelecting
                      ? 'var(--bg-tertiary)'
                      : 'transparent',
                    outline: isCompareSelected ? '1px solid var(--accent)' : undefined,
                  }}
                >
                  <button
                    onClick={() => {
                      if (compareSelecting) {
                        selectForCompare(tab.path);
                      } else {
                        setActiveTabPath(tab.path);
                      }
                    }}
                    onDoubleClick={() => {
                      if (!compareSelecting) updateTab(tab.path, { pinned: true });
                    }}
                    className="flex items-center gap-1 pl-2.5 pr-0.5 py-1 text-xs transition-colors max-w-[160px]"
                    style={{
                      color: isCompareSelected
                        ? 'var(--accent)'
                        : isActive
                        ? 'var(--text-primary)'
                        : 'var(--text-secondary)',
                      fontStyle: tab.pinned ? 'normal' : 'italic',
                      cursor: compareSelecting ? 'crosshair' : undefined,
                    }}
                    title={compareSelecting
                      ? (isCompareSelected ? 'Selected for compare' : isCompareTarget ? `Compare with ${compareSelecting.split('/').pop()}` : 'Click to select')
                      : tab.path}
                  >
                    {tabDirty && <Circle className="w-2 h-2 shrink-0 fill-current" style={{ color: 'var(--accent)' }} />}
                    <File className="w-3 h-3 shrink-0" style={{ color: 'var(--text-secondary)' }} />
                    <span className="truncate">{tab.name}</span>
                  </button>
                  {!compareSelecting && (
                    <button
                      onClick={(e) => { e.stopPropagation(); closeTab(tab.path); }}
                      className="p-0.5 rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity mr-0.5"
                      style={{ color: 'var(--text-secondary)' }}
                      title="Close"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}
            {/* Compare button */}
            {tabs.length >= 2 && (
              <button
                onClick={startCompare}
                className="flex items-center gap-1 px-2 py-1 rounded-md shrink-0 text-xs transition-colors ml-1"
                style={{
                  color: compareState || compareSelecting ? 'var(--accent)' : 'var(--text-secondary)',
                  background: compareState || compareSelecting ? 'rgba(88,166,255,0.15)' : 'transparent',
                }}
                title={compareState ? 'Exit compare' : compareSelecting ? 'Cancel compare' : 'Compare two files'}
              >
                <GitCompareArrows className="w-3.5 h-3.5" />
                {compareSelecting === 'waiting' && <span>Pick 1st file</span>}
                {compareSelecting && compareSelecting !== 'waiting' && <span>Pick 2nd file</span>}
              </button>
            )}
          </div>
        )}

        {/* Compare view */}
        {compareState && (
          <FileCompareView
            compareState={compareState}
            onApplyHunk={applyHunk}
            onSave={saveCompareChanges}
            onClose={() => { setCompareState(null); setCompareSelecting(null); }}
            saving={saving}
            saveMessage={saveMessage}
            currentHunk={compareHunk}
            onHunkNav={handleCompareHunkNav}
          />
        )}

        {/* Active tab file info bar + editor (hidden during compare) */}
        {!compareState && activeTab && (
          <>
            <div
              className="flex items-center justify-between px-4 py-1.5 text-xs shrink-0"
              style={{
                borderBottom: '1px solid var(--border)',
                color: 'var(--text-secondary)',
                background: 'var(--bg-secondary)',
              }}
            >
              <div className="flex items-center gap-2 truncate">
                <span className="truncate">{activeTab.path}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-2">
                {saveMessage && (
                  <span style={{ color: saveMessage === 'Saved' ? 'var(--success)' : 'var(--error)' }}>
                    {saveMessage}
                  </span>
                )}
                {isDirty && (
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors"
                    style={{
                      background: 'var(--accent)',
                      color: 'var(--bg-primary)',
                      opacity: saving ? 0.6 : 1,
                    }}
                  >
                    <Save className="w-3 h-3" />
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                )}
                {isMarkdown && (
                  <button
                    onClick={() => updateTab(activeTab.path, {
                      viewMode: activeTab.viewMode === 'preview' ? 'edit' : 'preview',
                    })}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors"
                    style={{
                      background: 'var(--bg-tertiary)',
                      color: 'var(--text-primary)',
                    }}
                    title={activeTab.viewMode === 'preview' ? 'Switch to editor' : 'Switch to preview'}
                  >
                    {activeTab.viewMode === 'preview' ? (
                      <><Pencil className="w-3 h-3" /> Edit</>
                    ) : (
                      <><Eye className="w-3 h-3" /> Preview</>
                    )}
                  </button>
                )}
                <span>{formatSize(activeTab.size)}</span>
              </div>
            </div>

            {isMarkdown && activeTab.viewMode === 'preview' ? (
              <div
                className="flex-1 overflow-auto p-6 prose-invert"
                style={{ color: 'var(--text-primary)' }}
              >
                <div className="markdown-preview">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {activeTab.editedContent}
                  </ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-auto">
                <CodeMirror
                  key={activeTab.path}
                  value={activeTab.editedContent}
                  onChange={(value) => updateTab(activeTab.path, { editedContent: value })}
                  extensions={extensions}
                  theme={oneDark}
                  height="100%"
                  style={{ height: '100%' }}
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: true,
                    highlightActiveLine: true,
                    highlightSelectionMatches: true,
                    bracketMatching: true,
                    closeBrackets: true,
                    autocompletion: true,
                    indentOnInput: true,
                  }}
                />
              </div>
            )}
          </>
        )}
        {fileLoading && !activeTab && !compareState && (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-secondary)' }} />
          </div>
        )}
        {fileError && (
          <div className="flex-1 flex items-center justify-center text-xs" style={{ color: 'var(--error)' }}>
            {fileError}
          </div>
        )}
        {!activeTab && !compareState && !fileLoading && !fileError && (
          <div className="flex-1 flex items-center justify-center text-xs" style={{ color: 'var(--text-secondary)' }}>
            Select a file to view its contents
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title={pendingDelete.isDir ? 'Delete folder?' : 'Delete file?'}
          message={
            pendingDelete.isDir
              ? `Permanently delete "${pendingDelete.path.split('/').pop()}" and all of its contents? This cannot be undone.`
              : `Permanently delete "${pendingDelete.path.split('/').pop()}"? This cannot be undone.`
          }
          confirmLabel="Delete"
          variant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

/* ================================================================
   FileCompareView — split diff with per-hunk apply arrows
   ================================================================ */

function FileCompareView({
  compareState,
  onApplyHunk,
  onSave,
  onClose,
  saving,
  saveMessage,
  currentHunk,
  onHunkNav,
}: {
  compareState: CompareState;
  onApplyHunk: (hunkIndex: number, direction: 'left' | 'right') => void;
  onSave: () => void;
  onClose: () => void;
  saving: boolean;
  saveMessage: string | null;
  currentHunk: number;
  onHunkNav: (delta: number) => void;
}) {
  const rows = useMemo(() => parseSplitRows(compareState.diff), [compareState.diff]);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const hunkRefs = useRef<(HTMLDivElement | null)[]>([]);

  const leftName = compareState.leftPath.split('/').pop() || 'left';
  const rightName = compareState.rightPath.split('/').pop() || 'right';
  const totalHunks = compareState.hunks.length;

  const markers = rows.map(r => {
    if (r.leftType === 'removed' || r.rightType === 'added') {
      if (r.leftType === 'removed' && r.rightType === 'added') return 'modified' as const;
      if (r.leftType === 'removed') return 'removed' as const;
      return 'added' as const;
    }
    return null;
  });

  function syncScroll(source: 'left' | 'right') {
    if (syncing.current) return;
    syncing.current = true;
    const from = source === 'left' ? leftRef.current : rightRef.current;
    const to = source === 'left' ? rightRef.current : leftRef.current;
    if (from && to) {
      to.scrollTop = from.scrollTop;
      to.scrollLeft = from.scrollLeft;
    }
    if (from && gutterRef.current) {
      gutterRef.current.scrollTop = from.scrollTop;
    }
    requestAnimationFrame(() => { syncing.current = false; });
  }

  // Scroll to current hunk when it changes
  useEffect(() => {
    const el = hunkRefs.current[currentHunk];
    if (el && leftRef.current) {
      const containerRect = leftRef.current.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const scrollTarget = leftRef.current.scrollTop + (elRect.top - containerRect.top) - containerRect.height / 3;
      leftRef.current.scrollTop = Math.max(0, scrollTarget);
      if (rightRef.current) rightRef.current.scrollTop = leftRef.current.scrollTop;
      if (gutterRef.current) gutterRef.current.scrollTop = leftRef.current.scrollTop;
    }
  }, [currentHunk]);

  const hasChanges = compareState.appliedHunks.size > 0;

  // Track hunk header row indices for ref assignment
  let hunkRefIdx = -1;

  // Identify the first row of each hunk for placing apply buttons in the gutter
  const hunkFirstRows = useMemo(() => {
    const map = new Map<number, number>();
    for (let i = 0; i < rows.length; i++) {
      const hi = rows[i].hunkIndex;
      if (hi !== null && !map.has(hi)) map.set(hi, i);
    }
    return map;
  }, [rows]);

  if (!compareState.diff) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 shrink-0"
          style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            <strong>{leftName}</strong> vs <strong>{rightName}</strong>
          </span>
          <button onClick={onClose} className="text-xs px-2 py-1 rounded" style={{ color: 'var(--text-secondary)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          Files are identical
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header bar with hunk navigation */}
      <div
        className="flex items-center justify-between px-4 py-1.5 text-xs shrink-0"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
      >
        <div className="flex items-center gap-3">
          <span><strong style={{ color: 'var(--error)' }}>{leftName}</strong></span>
          <span>vs</span>
          <span><strong style={{ color: 'var(--success)' }}>{rightName}</strong></span>
        </div>
        <div className="flex items-center gap-2">
          {/* Hunk navigation */}
          <div className="flex items-center gap-1 mr-2">
            <button
              onClick={() => onHunkNav(-1)}
              disabled={totalHunks === 0}
              className="flex items-center justify-center rounded transition-colors hover:bg-[var(--bg-tertiary)]"
              style={{ width: 22, height: 22, color: 'var(--text-secondary)' }}
              title="Previous difference"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <span style={{ color: 'var(--accent)', minWidth: 60, textAlign: 'center' }}>
              {totalHunks > 0 ? `${currentHunk + 1} / ${totalHunks}` : '0'}
            </span>
            <button
              onClick={() => onHunkNav(1)}
              disabled={totalHunks === 0}
              className="flex items-center justify-center rounded transition-colors hover:bg-[var(--bg-tertiary)]"
              style={{ width: 22, height: 22, color: 'var(--text-secondary)' }}
              title="Next difference"
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
          </div>
          {saveMessage && (
            <span style={{ color: saveMessage === 'Saved' ? 'var(--success)' : 'var(--error)' }}>
              {saveMessage}
            </span>
          )}
          {hasChanges && (
            <button
              onClick={onSave}
              disabled={saving}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors"
              style={{ background: 'var(--accent)', color: 'var(--bg-primary)', opacity: saving ? 0.6 : 1 }}
            >
              <Save className="w-3 h-3" />
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-white/10"
            style={{ color: 'var(--text-secondary)' }}
            title="Exit compare"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Split diff: left panel | center gutter | right panel | overview ruler */}
      <div className="flex-1 min-h-0 flex">
        {/* Left panel */}
        <div
          ref={leftRef}
          onScroll={() => syncScroll('left')}
          className="flex-1 min-w-0 overflow-auto"
          style={{ fontFamily: MONO }}
        >
          <div style={{ minWidth: 'fit-content' }}>
            {(() => { hunkRefIdx = -1; return null; })()}
            {rows.map((r, i) => {
              const applied = r.hunkIndex !== null ? compareState.appliedHunks.get(r.hunkIndex) : undefined;
              const isCurrent = r.hunkIndex === currentHunk;
              const isHunkHeader = r.leftType === 'header' && r.leftText.startsWith('@@');

              // Track hunk refs for scroll-to-hunk navigation
              let refCb: ((el: HTMLDivElement | null) => void) | undefined;
              if (isHunkHeader) {
                hunkRefIdx++;
                const idx = hunkRefIdx;
                refCb = (el) => { hunkRefs.current[idx] = el; };
              }

              // "Keep left" (applied === 'left'): show both sides as normal (no diff colors)
              if (applied === 'left' && r.leftType !== 'header' && r.leftType !== 'separator') {
                return (
                  <SplitHalf
                    key={i} ref={refCb}
                    num={r.leftNum}
                    text={r.leftText}
                    type={r.leftType === 'removed' ? 'normal' : r.leftType}
                    side="left"
                    isCurrentHunk={isCurrent}
                    isEditable={false}
                  />
                );
              }

              return (
                <SplitHalf
                  key={i} ref={refCb}
                  num={r.leftNum}
                  text={r.leftText}
                  type={r.leftType}
                  side="left"
                  isCurrentHunk={isCurrent}
                  isEditable={false}
                />
              );
            })}
          </div>
        </div>

        {/* Center gutter — scrolls in sync, shows apply arrows on hunk rows */}
        <div
          ref={gutterRef}
          className="shrink-0 overflow-hidden"
          style={{
            width: 44,
            background: 'var(--bg-secondary)',
            borderLeft: '1px solid var(--border)',
            borderRight: '1px solid var(--border)',
          }}
        >
          <div style={{ minHeight: 'fit-content' }}>
            {rows.map((r, i) => {
              const isHunkStart = r.hunkIndex !== null && hunkFirstRows.get(r.hunkIndex) === i;
              const applied = r.hunkIndex !== null ? compareState.appliedHunks.get(r.hunkIndex) : undefined;
              const isCurrent = r.hunkIndex === currentHunk;

              // Show apply buttons on the first row of each hunk
              if (isHunkStart && r.hunkIndex !== null) {
                const hIdx = r.hunkIndex;
                return (
                  <div
                    key={i}
                    className="flex items-center justify-center gap-0.5"
                    style={{
                      height: ROW_H,
                      background: isCurrent ? HUNK_HIGHLIGHT : undefined,
                    }}
                  >
                    <button
                      onClick={() => onApplyHunk(hIdx, 'left')}
                      className="flex items-center justify-center rounded transition-all"
                      style={{
                        width: 18, height: 16,
                        background: applied === 'left' ? 'var(--success)' : 'var(--bg-tertiary)',
                        color: applied === 'left' ? '#fff' : 'var(--text-secondary)',
                        border: applied === 'left' ? 'none' : '1px solid var(--border)',
                      }}
                      title="Keep left (no change)"
                    >
                      <ArrowLeft className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => onApplyHunk(hIdx, 'right')}
                      className="flex items-center justify-center rounded transition-all"
                      style={{
                        width: 18, height: 16,
                        background: applied === 'right' ? 'var(--success)' : 'var(--bg-tertiary)',
                        color: applied === 'right' ? '#fff' : 'var(--text-secondary)',
                        border: applied === 'right' ? 'none' : '1px solid var(--border)',
                      }}
                      title="Accept right side"
                    >
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>
                );
              }

              // Spacer row — match separator height if needed
              const isSep = r.leftType === 'separator' || r.rightType === 'separator';
              return <div key={i} style={{ height: isSep ? ROW_H + 8 : ROW_H }} />;
            })}
          </div>
        </div>

        {/* Right panel */}
        <div
          ref={rightRef}
          onScroll={() => syncScroll('right')}
          className="flex-1 min-w-0 overflow-auto"
          style={{ fontFamily: MONO }}
        >
          <div style={{ minWidth: 'fit-content' }}>
            {rows.map((r, i) => {
              const applied = r.hunkIndex !== null ? compareState.appliedHunks.get(r.hunkIndex) : undefined;
              const isCurrent = r.hunkIndex === currentHunk;

              // "Keep left" (applied === 'left'): right side also shows as normal (the left content)
              if (applied === 'left' && r.rightType !== 'header' && r.rightType !== 'separator') {
                // Show left-side text on the right, as normal
                return (
                  <SplitHalf
                    key={i}
                    num={r.leftNum ?? r.rightNum}
                    text={r.leftType === 'removed' ? r.leftText : r.rightType === 'added' ? r.leftText : r.rightText}
                    type="normal"
                    side="right"
                    isCurrentHunk={isCurrent}
                    isEditable={false}
                  />
                );
              }

              // "Accept right" (applied === 'right'): keep normal diff colors (red/green) — no change needed
              // Default (no apply): also show normal diff colors

              return (
                <SplitHalf
                  key={i}
                  num={r.rightNum}
                  text={r.rightText}
                  type={r.rightType}
                  side="right"
                  isCurrentHunk={isCurrent}
                  isEditable={false}
                />
              );
            })}
          </div>
        </div>

        <OverviewRuler markers={markers} scrollRef={rightRef} onJump={(st) => {
          if (leftRef.current) leftRef.current.scrollTop = st;
          if (rightRef.current) rightRef.current.scrollTop = st;
          if (gutterRef.current) gutterRef.current.scrollTop = st;
        }} />
      </div>
    </div>
  );
}
