import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { X, Settings, Check, Loader2, Zap, Bot } from 'lucide-react';
import { ClaudeIcon, CodexIcon } from './CliIcons';

interface SettingsModalProps {
  onClose: () => void;
}

function CommandInput({
  label,
  icon,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
        {icon}
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded-lg text-sm"
        style={{
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          outline: 'none',
        }}
        onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
        onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
      />
    </div>
  );
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
  });

  const [hivemindClaudeCmd, setHivemindClaudeCmd] = useState('');
  const [hivemindCodexCmd, setHivemindCodexCmd] = useState('');
  const [agentClaudeCmd, setAgentClaudeCmd] = useState('');
  const [agentCodexCmd, setAgentCodexCmd] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data?.settings) {
      const s = data.settings;
      // Fall back to ruflo_command for backward compat
      setHivemindClaudeCmd(s.hivemind_claude_command || s.ruflo_command || '');
      setHivemindCodexCmd(s.hivemind_codex_command || s.ruflo_command || '');
      setAgentClaudeCmd(s.agent_claude_command || s.ruflo_command || '');
      setAgentCodexCmd(s.agent_codex_command || s.ruflo_command || '');
    }
  }, [data]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: (settings: Record<string, string>) => api.settings.update(settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  function handleSave() {
    mutation.mutate({
      ruflo_command: hivemindClaudeCmd, // keep backward compat
      hivemind_claude_command: hivemindClaudeCmd,
      hivemind_codex_command: hivemindCodexCmd,
      agent_claude_command: agentClaudeCmd,
      agent_codex_command: agentCodexCmd,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{
          width: '100%',
          maxWidth: '620px',
          maxHeight: '90vh',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5" style={{ color: 'var(--accent)' }} />
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Settings
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md transition-colors hover:opacity-80"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-6 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-secondary)' }} />
            </div>
          ) : (
            <>
              {/* Hive Mind Commands */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4" style={{ color: '#60a5fa' }} />
                  <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    Hive Mind Commands
                  </h4>
                </div>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  The RuFlo command used when launching Hive Mind sessions.
                </p>
                <div className="space-y-3 pl-1">
                  <CommandInput
                    label="Claude"
                    icon={<ClaudeIcon className="w-3.5 h-3.5" style={{ color: '#60a5fa' }} />}
                    value={hivemindClaudeCmd}
                    onChange={setHivemindClaudeCmd}
                    placeholder="bash ~/.octoally/ruflo-run.sh"
                  />
                  <CommandInput
                    label="Codex"
                    icon={<CodexIcon className="w-3.5 h-3.5" style={{ color: '#60a5fa' }} />}
                    value={hivemindCodexCmd}
                    onChange={setHivemindCodexCmd}
                    placeholder="bash ~/.octoally/ruflo-run.sh"
                  />
                </div>
              </div>

              {/* Agent Commands */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Bot className="w-4 h-4" style={{ color: '#ef4444' }} />
                  <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    Agent Commands
                  </h4>
                </div>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  The RuFlo command used when launching single Agent sessions.
                </p>
                <div className="space-y-3 pl-1">
                  <CommandInput
                    label="Claude"
                    icon={<ClaudeIcon className="w-3.5 h-3.5" style={{ color: '#ef4444' }} />}
                    value={agentClaudeCmd}
                    onChange={setAgentClaudeCmd}
                    placeholder="bash ~/.octoally/ruflo-run.sh"
                  />
                  <CommandInput
                    label="Codex"
                    icon={<CodexIcon className="w-3.5 h-3.5" style={{ color: '#ef4444' }} />}
                    value={agentCodexCmd}
                    onChange={setAgentCodexCmd}
                    placeholder="bash ~/.octoally/ruflo-run.sh"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-6 py-4 shrink-0"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={mutation.isPending}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: saved ? 'var(--success, #22c55e)' : 'var(--accent)',
              color: '#fff',
              opacity: mutation.isPending ? 0.7 : 1,
            }}
          >
            {mutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : saved ? (
              <Check className="w-3.5 h-3.5" />
            ) : null}
            {saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
