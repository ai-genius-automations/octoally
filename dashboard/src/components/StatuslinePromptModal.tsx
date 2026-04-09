import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { BarChart3, Download, X, Loader2, CheckCircle } from 'lucide-react';

interface StatuslinePromptModalProps {
  onClose: () => void;
}

export function StatuslinePromptModal({ onClose }: StatuslinePromptModalProps) {
  const queryClient = useQueryClient();
  const [done, setDone] = useState(false);
  const [installed, setInstalled] = useState(false);

  const dismiss = async () => {
    await api.settings.update({ statusline_prompted: 'true' });
    queryClient.invalidateQueries({ queryKey: ['settings'] });
  };

  const installMutation = useMutation({
    mutationFn: async () => {
      await api.settings.statusline.install();
      await dismiss();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statusline'] });
      setInstalled(true);
      setDone(true);
    },
  });

  const skipMutation = useMutation({
    mutationFn: () => dismiss(),
    onSuccess: () => onClose(),
  });

  const isPending = installMutation.isPending || skipMutation.isPending;

  if (done) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        style={{ background: 'rgba(0,0,0,0.6)' }}
      >
        <div
          className="flex flex-col rounded-xl shadow-2xl overflow-hidden"
          style={{
            width: '100%',
            maxWidth: '460px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
          }}
        >
          <div className="px-6 py-8 text-center">
            <CheckCircle className="w-12 h-12 mx-auto mb-4" style={{ color: '#22c55e' }} />
            <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
              {installed ? 'Status Bar Installed' : 'Got it'}
            </h3>
            {installed && (
              <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>
                It will appear on your next Claude Code interaction.
              </p>
            )}
            <p className="text-xs mb-6" style={{ color: 'var(--text-secondary)' }}>
              You can install or uninstall it anytime from <strong>Settings</strong>.
            </p>
            <button
              onClick={onClose}
              className="px-6 py-2 rounded-lg text-sm font-medium"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={() => !isPending && skipMutation.mutate()}
    >
      <div
        className="flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{
          width: '100%',
          maxWidth: '460px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="px-6 py-4"
          style={{ background: '#06b6d415', borderBottom: '1px solid #06b6d440' }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <BarChart3 className="w-6 h-6 shrink-0" style={{ color: '#06b6d4' }} />
              <div>
                <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Custom Claude Status Bar
                </h3>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  Enhance your Claude Code experience
                </p>
              </div>
            </div>
            <button
              onClick={() => !isPending && skipMutation.mutate()}
              className="p-1 rounded-md transition-colors hover:opacity-80"
              style={{ color: 'var(--text-secondary)' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            OctoAlly includes a custom status bar for Claude Code that shows useful info at a glance:
          </p>

          <div className="space-y-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
              <span style={{ color: '#a855f7' }}>&#xE0A0;</span>
              <span>Current <strong>git branch</strong></span>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
              <span style={{ color: '#06b6d4' }}>&#x23F1;</span>
              <span><strong>Session duration</strong> and lines changed</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
              <span style={{ color: '#22c55e' }}>&#x2593;</span>
              <span>Color-coded <strong>context window</strong> usage bar</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
              <span style={{ color: '#eab308' }}>$</span>
              <span><strong>Session cost</strong> and model indicator</span>
            </div>
          </div>

          <div className="flex flex-col gap-2 pt-2">
            <button
              onClick={() => installMutation.mutate()}
              disabled={isPending}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium"
              style={{ background: '#06b6d4', color: 'white', opacity: isPending ? 0.6 : 1 }}
            >
              {installMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              {installMutation.isPending ? 'Installing...' : 'Install Status Bar'}
            </button>
            <button
              onClick={() => skipMutation.mutate()}
              disabled={isPending}
              className="w-full px-4 py-2.5 rounded-lg text-xs font-medium"
              style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              No thanks
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
