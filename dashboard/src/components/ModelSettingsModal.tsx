import { useEffect, useRef, useState } from 'react';
import { Settings, Download, Check, Loader2, X, Cloud, HardDrive, Eye, EyeOff, Ear, Plus, Trash2, Sparkles, Timer, Clock } from 'lucide-react';
import { invoke } from '../lib/tauri';
import { useSpeechStore, downloadModel, stopMic, unloadModel, setWakePhrase, setSilenceTimeout, setMaxSpeechDuration } from '../lib/speech';

interface ModelInfo {
  installed: boolean;
  modelSize: string;
  path: string;
  sizeBytes: number | null;
  active: boolean;
}

const MODEL_META: Record<string, { label: string; size: string; desc: string }> = {
  tiny: {
    label: 'Tiny',
    size: '~75 MB',
    desc: 'Fastest (~2s), lower accuracy. Good for simple commands.',
  },
  small: {
    label: 'Small',
    size: '~500 MB',
    desc: 'Balanced accuracy and speed (~6s). Recommended.',
  },
  medium: {
    label: 'Medium',
    size: '~1.5 GB',
    desc: 'Best accuracy, slower (~15s). For detailed dictation.',
  },
};

interface ModelSettingsModalProps {
  onClose: () => void;
}

export function ModelSettingsModal({ onClose }: ModelSettingsModalProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const downloadProgress = useSpeechStore((s) => s.downloadProgress);
  const modelLoaded = useSpeechStore((s) => s.modelLoaded);
  const whisperInstallStage = useSpeechStore((s) => s.whisperInstallStage);
  const whisperInstallPercent = useSpeechStore((s) => s.whisperInstallPercent);
  const whisperInstallMessage = useSpeechStore((s) => s.whisperInstallMessage);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);

  // Snapshot of the "committed" backend state when modal opened
  const committedBackend = useRef(useSpeechStore.getState().backend);
  const committedOpenaiKey = useRef(useSpeechStore.getState().openaiApiKey);
  const committedGroqKey = useRef(useSpeechStore.getState().groqApiKey);
  const committedWakePhrase = useRef(useSpeechStore.getState().wakePhrase);
  const committedSilenceTimeout = useRef(useSpeechStore.getState().silenceTimeoutMs);
  const committedMaxSpeech = useRef(useSpeechStore.getState().maxSpeechMs);

  // Draft state — what the user is configuring (not yet saved)
  const [draftBackend, setDraftBackend] = useState<'local' | 'openai' | 'groq'>(committedBackend.current);
  const [draftOpenaiKey, setDraftOpenaiKey] = useState(committedOpenaiKey.current);
  const [draftGroqKey, setDraftGroqKey] = useState(committedGroqKey.current);
  const [draftWakePhrase, setDraftWakePhrase] = useState(committedWakePhrase.current);
  const [draftSilenceTimeout, setDraftSilenceTimeout] = useState(committedSilenceTimeout.current);
  const [draftMaxSpeech, setDraftMaxSpeech] = useState(committedMaxSpeech.current);
  const [showApiKey, setShowApiKey] = useState(false);
  const [activeTab, setActiveTab] = useState<'speech' | 'commands'>('speech');

  // Has the user changed anything?
  const hasChanges = draftBackend !== committedBackend.current
    || (draftBackend === 'openai' && draftOpenaiKey !== committedOpenaiKey.current)
    || (draftBackend === 'groq' && draftGroqKey !== committedGroqKey.current)
    || draftWakePhrase !== committedWakePhrase.current
    || draftSilenceTimeout !== committedSilenceTimeout.current
    || draftMaxSpeech !== committedMaxSpeech.current;

  const loadModels = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<ModelInfo[]>('stt_list_models');
      setModels(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !downloadingModel) handleCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, downloadingModel]);

  // Refresh model list when download completes
  useEffect(() => {
    if (downloadProgress === null && downloadingModel) {
      setDownloadingModel(null);
      loadModels();
    }
  }, [downloadProgress, downloadingModel]);

  const handleActivate = async (modelSize: string) => {
    setSwitching(true);
    setError(null);
    try {
      const micMode = useSpeechStore.getState().micMode;
      if (micMode !== 'off') {
        await stopMic();
      }
      await invoke('stt_set_model', { modelSize });
      await loadModels();
    } catch (e) {
      setError(String(e));
    } finally {
      setSwitching(false);
    }
  };

  const handleDownload = async (modelSize: string) => {
    setError(null);
    setDownloadingModel(modelSize);
    await downloadModel(modelSize);
  };

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      if (draftBackend === 'openai' && !draftOpenaiKey) {
        setError('Please enter an OpenAI API key.');
        setSaving(false);
        return;
      }
      if (draftBackend === 'groq' && !draftGroqKey) {
        setError('Please enter a Groq API key.');
        setSaving(false);
        return;
      }

      // Always pass the OpenAI key — it's shared with smart command matching
      await invoke('stt_set_backend', {
        backend: draftBackend,
        openaiApiKey: draftOpenaiKey || undefined,
        groqApiKey: draftBackend === 'groq' ? draftGroqKey : undefined,
      });

      const store = useSpeechStore.getState();
      store.setBackend(draftBackend);
      if (draftOpenaiKey) store.setOpenaiApiKey(draftOpenaiKey);
      if (draftBackend === 'groq') store.setGroqApiKey(draftGroqKey);

      // Save wake phrase if changed
      if (draftWakePhrase !== committedWakePhrase.current && draftWakePhrase.trim()) {
        await setWakePhrase(draftWakePhrase.trim());
      }

      // Save silence timeout if changed
      if (draftSilenceTimeout !== committedSilenceTimeout.current) {
        await setSilenceTimeout(draftSilenceTimeout);
      }

      // Save max speech duration if changed
      if (draftMaxSpeech !== committedMaxSpeech.current) {
        await setMaxSpeechDuration(draftMaxSpeech);
      }

      // Update committed refs
      committedBackend.current = draftBackend;
      committedOpenaiKey.current = draftOpenaiKey;
      committedGroqKey.current = draftGroqKey;
      committedWakePhrase.current = draftWakePhrase;
      committedSilenceTimeout.current = draftSilenceTimeout;
      committedMaxSpeech.current = draftMaxSpeech;

      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraftBackend(committedBackend.current);
    setDraftOpenaiKey(committedOpenaiKey.current);
    setDraftGroqKey(committedGroqKey.current);
    setDraftWakePhrase(committedWakePhrase.current);
    setDraftSilenceTimeout(committedSilenceTimeout.current);
    setDraftMaxSpeech(committedMaxSpeech.current);
    onClose();
  };

  const isDownloading = downloadProgress !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={() => !isDownloading && handleCancel()}
    >
      <div
        className="flex flex-col rounded-lg shadow-2xl overflow-hidden"
        style={{
          width: '100%',
          maxWidth: activeTab === 'commands' ? '540px' : '460px',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-2">
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center w-9 h-9 rounded-full shrink-0"
              style={{ background: 'var(--accent)20' }}
            >
              <Settings className="w-5 h-5" style={{ color: 'var(--accent)' }} />
            </div>
            <div>
              <h3
                className="text-sm font-semibold"
                style={{ color: 'var(--text-primary)' }}
              >
                Speech Settings
              </h3>
              {/* Current active mode indicator */}
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                Active: {committedBackend.current === 'openai' ? (
                  <span style={{ color: 'var(--accent)' }}>OpenAI Cloud</span>
                ) : committedBackend.current === 'groq' ? (
                  <span style={{ color: '#f97316' }}>Groq Cloud</span>
                ) : (
                  <span style={{ color: '#16a34a' }}>Local Whisper</span>
                )}
              </p>
            </div>
          </div>
          {!isDownloading && (
            <button
              onClick={handleCancel}
              className="p-1 rounded hover:opacity-80 shrink-0"
              style={{ color: 'var(--text-secondary)' }}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex px-5 gap-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <button
            onClick={() => setActiveTab('speech')}
            className="pb-2 text-[11px] font-medium transition-colors"
            style={{
              color: activeTab === 'speech' ? 'var(--accent)' : 'var(--text-secondary)',
              borderBottom: activeTab === 'speech' ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            Speech
          </button>
          <button
            onClick={() => setActiveTab('commands')}
            className="pb-2 text-[11px] font-medium transition-colors"
            style={{
              color: activeTab === 'commands' ? 'var(--accent)' : 'var(--text-secondary)',
              borderBottom: activeTab === 'commands' ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            Voice Commands
          </button>
        </div>

        {/* Body */}
        {activeTab === 'speech' ? (
        <div className="px-5 py-3 space-y-3" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {/* Backend toggle */}
          <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            <button
              onClick={() => { setDraftBackend('local'); setError(null); }}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-medium transition-colors"
              style={{
                background: draftBackend === 'local' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: draftBackend === 'local' ? 'white' : 'var(--text-secondary)',
              }}
            >
              <HardDrive className="w-3.5 h-3.5" />
              Local
            </button>
            <button
              onClick={() => { setDraftBackend('openai'); setError(null); }}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-medium transition-colors"
              style={{
                background: draftBackend === 'openai' ? 'var(--accent)' : 'var(--bg-secondary)',
                color: draftBackend === 'openai' ? 'white' : 'var(--text-secondary)',
              }}
            >
              <Cloud className="w-3.5 h-3.5" />
              OpenAI
            </button>
            <button
              onClick={() => { setDraftBackend('groq'); setError(null); }}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-medium transition-colors"
              style={{
                background: draftBackend === 'groq' ? '#f97316' : 'var(--bg-secondary)',
                color: draftBackend === 'groq' ? 'white' : 'var(--text-secondary)',
              }}
            >
              <Cloud className="w-3.5 h-3.5" />
              Groq
            </button>
          </div>

          {/* Backend descriptions */}
          {draftBackend === 'local' && (
            <div className="space-y-1.5">
              <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                Runs whisper.cpp locally — your audio never leaves your machine. Slower (~2-6s per utterance) and requires downloading a model.
              </p>
              <p
                className="text-[10px] leading-relaxed px-2 py-1.5 rounded-md"
                style={{ background: '#f9731610', color: '#f97316', border: '1px solid #f9731630' }}
              >
                Consider <strong>Groq</strong> instead — near-instant results, 9x cheaper than OpenAI, and under $1/mo even with heavy use. Only requires a free API key.
              </p>
            </div>
          )}
          {draftBackend === 'openai' && (
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Uses OpenAI's whisper-1 model. Fast (~200-500ms) but more expensive at $0.36/hr transcribed.
            </p>
          )}
          {draftBackend === 'groq' && (
            <div className="space-y-1.5">
              <div
                className="flex items-center gap-1.5 px-2 py-1 rounded-md w-fit text-[10px] font-semibold"
                style={{ background: '#f9731620', color: '#f97316' }}
              >
                Recommended
              </div>
              <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                Near-instant transcription powered by Groq's custom LPU chips. Uses <strong style={{ color: 'var(--text-primary)' }}>whisper-large-v3-turbo</strong> — a newer, more accurate model than OpenAI's whisper-1, at <strong style={{ color: 'var(--text-primary)' }}>9x cheaper</strong> ($0.04/hr vs $0.36/hr). Heavy daily use costs under $1/month.
              </p>
            </div>
          )}

          {/* Cloud API key input */}
          {(draftBackend === 'openai' || draftBackend === 'groq') && (
            <div className="space-y-1.5">
              <label className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                {draftBackend === 'openai' ? 'OpenAI API Key' : 'Groq API Key'}
              </label>
              <div className="flex gap-1.5">
                <div className="relative flex-1">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={draftBackend === 'openai' ? draftOpenaiKey : draftGroqKey}
                    onChange={(e) => draftBackend === 'openai' ? setDraftOpenaiKey(e.target.value) : setDraftGroqKey(e.target.value)}
                    placeholder={draftBackend === 'openai' ? 'sk-...' : 'gsk_...'}
                    className="w-full pl-2.5 pr-7 py-1.5 rounded-md text-[11px] font-mono outline-none"
                    style={{
                      background: 'var(--bg-tertiary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border)',
                    }}
                  />
                  <button
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {showApiKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Utterance timing (silence timeout) */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Timer className="w-3 h-3" style={{ color: 'var(--text-secondary)' }} />
              <label className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                Utterance Pause Duration
              </label>
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
              >
                {draftSilenceTimeout}ms
              </span>
            </div>
            <input
              type="range"
              min={200}
              max={5000}
              step={100}
              value={draftSilenceTimeout}
              onChange={(e) => setDraftSilenceTimeout(parseInt(e.target.value))}
              className="w-full h-1.5 rounded-lg appearance-none cursor-pointer"
              style={{
                background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${((draftSilenceTimeout - 200) / 4800) * 100}%, var(--bg-tertiary) ${((draftSilenceTimeout - 200) / 4800) * 100}%, var(--bg-tertiary) 100%)`,
                accentColor: 'var(--accent)',
              }}
            />
            <div className="flex justify-between text-[9px]" style={{ color: 'var(--text-secondary)' }}>
              <span>200ms (fast)</span>
              <span>5000ms (slow)</span>
            </div>
            <p className="text-[10px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              How long to wait after you stop speaking before sending the audio for transcription. Shorter = more responsive but may cut you off mid-sentence. Longer = waits for natural pauses.
            </p>
          </div>

          {/* Max speech duration */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Clock className="w-3 h-3" style={{ color: 'var(--text-secondary)' }} />
              <label className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                Max Speech Duration
              </label>
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
              >
                {Math.floor(draftMaxSpeech / 60_000) > 0 ? `${Math.floor(draftMaxSpeech / 60_000)}m ` : ''}{((draftMaxSpeech % 60_000) / 1000)}s
              </span>
            </div>
            <input
              type="range"
              min={10_000}
              max={300_000}
              step={5_000}
              value={draftMaxSpeech}
              onChange={(e) => setDraftMaxSpeech(parseInt(e.target.value))}
              className="w-full h-1.5 rounded-lg appearance-none cursor-pointer"
              style={{
                background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${((draftMaxSpeech - 10_000) / 290_000) * 100}%, var(--bg-tertiary) ${((draftMaxSpeech - 10_000) / 290_000) * 100}%, var(--bg-tertiary) 100%)`,
                accentColor: 'var(--accent)',
              }}
            />
            <div className="flex justify-between text-[9px]" style={{ color: 'var(--text-secondary)' }}>
              <span>10s</span>
              <span>5 min</span>
            </div>
            <p className="text-[10px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Maximum continuous speech before the mic auto-segments. Increase this if you dictate long passages and get cut off. Default is 30 seconds.
            </p>
          </div>

          {/* Local backend: whisper binary install progress */}
          {draftBackend === 'local' && whisperInstallStage && (
            <div
              className="p-3 rounded-lg space-y-2"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--accent)' }}
            >
              <div className="flex items-center gap-2">
                {whisperInstallStage === 'error' ? (
                  <X className="w-4 h-4 shrink-0" style={{ color: 'var(--error)' }} />
                ) : (
                  <Loader2 className="w-4 h-4 shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />
                )}
                <span
                  className="text-[11px] font-medium"
                  style={{ color: whisperInstallStage === 'error' ? 'var(--error)' : 'var(--text-primary)' }}
                >
                  {whisperInstallStage === 'downloading' && 'Downloading whisper.cpp source...'}
                  {whisperInstallStage === 'extracting' && 'Extracting source...'}
                  {whisperInstallStage === 'building' && 'Compiling whisper.cpp (this may take a minute)...'}
                  {whisperInstallStage === 'error' && 'Install failed'}
                </span>
              </div>
              {whisperInstallMessage && (
                <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                  {whisperInstallMessage}
                </p>
              )}
              {whisperInstallPercent != null && whisperInstallStage !== 'error' && (
                <div
                  className="w-full h-1.5 rounded-full overflow-hidden"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${whisperInstallPercent}%`,
                      background: 'var(--accent)',
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Local backend: model list */}
          {draftBackend === 'local' && (loading ? (
            <div
              className="text-xs text-center py-4"
              style={{ color: 'var(--text-secondary)' }}
            >
              Loading models...
            </div>
          ) : (
            <div className="space-y-1.5">
              {models.map((model) => {
                const meta = MODEL_META[model.modelSize] || {
                  label: model.modelSize,
                  size: '?',
                  desc: '',
                };
                const isThisDownloading =
                  isDownloading && downloadingModel === model.modelSize;

                return (
                  <div
                    key={model.modelSize}
                    className="flex items-center gap-3 p-3 rounded-lg"
                    style={{
                      background: model.active
                        ? 'var(--accent)10'
                        : 'var(--bg-secondary)',
                      border: `1px solid ${
                        model.active ? 'var(--accent)' : 'var(--border)'
                      }`,
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="text-xs font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {meta.label}
                        </span>
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded"
                          style={{
                            background: 'var(--bg-tertiary)',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          {meta.size}
                        </span>
                        {model.modelSize === 'small' && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                            style={{
                              background: 'var(--accent)',
                              color: 'white',
                            }}
                          >
                            Recommended
                          </span>
                        )}
                        {model.active && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                            style={{
                              background: '#16a34a',
                              color: 'white',
                            }}
                          >
                            Active
                          </span>
                        )}
                      </div>
                      <p
                        className="text-[10px] mt-0.5"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {meta.desc}
                      </p>

                      {/* Download progress bar */}
                      {isThisDownloading && (
                        <div className="mt-2 space-y-1">
                          <div
                            className="flex items-center justify-between text-[10px]"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            <span>Downloading...</span>
                            <span>{Math.round(downloadProgress!)}%</span>
                          </div>
                          <div
                            className="w-full h-1.5 rounded-full overflow-hidden"
                            style={{ background: 'var(--bg-tertiary)' }}
                          >
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{
                                width: `${downloadProgress}%`,
                                background: 'var(--accent)',
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Action button */}
                    <div className="shrink-0">
                      {model.installed ? (
                        model.active ? (
                          <div
                            className="flex items-center justify-center w-7 h-7 rounded-md"
                            style={{ color: '#16a34a' }}
                          >
                            <Check className="w-4 h-4" />
                          </div>
                        ) : (
                          <button
                            onClick={() => handleActivate(model.modelSize)}
                            disabled={switching || isDownloading}
                            className="px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors disabled:opacity-50"
                            style={{
                              background: 'var(--bg-tertiary)',
                              color: 'var(--text-primary)',
                              border: '1px solid var(--border)',
                            }}
                          >
                            {switching ? 'Switching...' : 'Use'}
                          </button>
                        )
                      ) : isThisDownloading ? (
                        <Loader2
                          className="w-4 h-4 animate-spin"
                          style={{ color: 'var(--accent)' }}
                        />
                      ) : (
                        <button
                          onClick={() => handleDownload(model.modelSize)}
                          disabled={isDownloading}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors disabled:opacity-50"
                          style={{
                            background: 'var(--accent)',
                            color: '#fff',
                          }}
                        >
                          <Download className="w-3 h-3" />
                          Get
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {/* Local backend: Load/Unload model */}
          {draftBackend === 'local' && (
            <div>
              {modelLoaded ? (
                <button
                  onClick={async () => { await unloadModel(); }}
                  disabled={isDownloading}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors disabled:opacity-50"
                  style={{
                    color: 'var(--error)',
                    background: 'transparent',
                    border: '1px solid var(--error)',
                  }}
                >
                  Unload Model
                </button>
              ) : (
                <button
                  onClick={async () => {
                    setError(null);
                    try {
                      const check = await invoke<{ installed: boolean; path: string | null }>('stt_check_whisper');
                      if (!check.installed) {
                        await invoke('stt_install_whisper');
                      }
                      const status = await invoke<{ mode: string; modelLoaded: boolean }>('stt_status');
                      useSpeechStore.getState().setModelLoaded(status.modelLoaded);
                      if (!status.modelLoaded) {
                        setError('Model not available. Download a model first.');
                      }
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                  disabled={isDownloading || !!whisperInstallStage}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors disabled:opacity-50"
                  style={{
                    color: 'var(--accent)',
                    background: 'transparent',
                    border: '1px solid var(--accent)',
                  }}
                >
                  {whisperInstallStage ? 'Installing...' : 'Load Model'}
                </button>
              )}
            </div>
          )}

          {/* Wake Word section */}
          <div
            className="p-3 rounded-lg space-y-2"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2">
              <Ear className="w-3.5 h-3.5" style={{ color: '#7c3aed' }} />
              <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                Wake Word
              </span>
            </div>
            <p className="text-[10px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Say the wake phrase to activate voice command mode. Uses the tiny whisper model locally (free) to detect the phrase, then transcribes your command with the selected backend above.
            </p>
            <div className="space-y-1">
              <label className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                Wake Phrase
              </label>
              <input
                type="text"
                value={draftWakePhrase}
                onChange={(e) => setDraftWakePhrase(e.target.value)}
                placeholder="hey octoally"
                className="w-full px-2.5 py-1.5 rounded-md text-[11px] outline-none"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                }}
              />
            </div>
            <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
              Click the <Ear className="w-2.5 h-2.5 inline" /> button in the header to start wake word listening.
            </p>
          </div>

          {error && (
            <p
              className="text-xs p-2 rounded"
              style={{ color: 'var(--error)', background: 'var(--error)10' }}
            >
              {error}
            </p>
          )}
        </div>
        ) : (
        <div className="px-5 py-3" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <VoiceCommandsSection />
        </div>
        )}

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3"
          style={{
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
          }}
        >
          <button
            onClick={handleCancel}
            disabled={isDownloading}
            className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}
          >
            Cancel
          </button>
          {hasChanges && (
            <button
              onClick={handleSave}
              disabled={isDownloading || saving}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
              style={{
                background: 'var(--accent)',
                color: 'white',
              }}
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voice Commands sub-component
// ---------------------------------------------------------------------------

interface VoiceCommandDef {
  id: string;
  name: string;
  triggerPhrases: string[];
  action: { kind: string; target?: string; sessionType?: string; command?: string; background?: boolean };
  type: 'builtin' | 'custom';
  enabled: boolean;
}

function VoiceCommandsSection() {
  const [commands, setCommands] = useState<VoiceCommandDef[]>([]);
  const [builtinDefaults, setBuiltinDefaults] = useState<VoiceCommandDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newCommandName, setNewCommandName] = useState('');
  const [newCommandPhrases, setNewCommandPhrases] = useState('');
  const [newCommandScript, setNewCommandScript] = useState('');
  const [newCommandBg, setNewCommandBg] = useState(true);

  // Smart matching state
  const smartMatching = useSpeechStore((s) => s.smartMatching);
  const storeOpenaiKey = useSpeechStore((s) => s.openaiApiKey);
  const [draftSmartMatching, setDraftSmartMatching] = useState(smartMatching);
  const [draftSmartKey, setDraftSmartKey] = useState(storeOpenaiKey);
  const [showSmartKey, setShowSmartKey] = useState(false);
  const [savingSmart, setSavingSmart] = useState(false);

  const smartDirty = draftSmartMatching !== smartMatching || draftSmartKey !== storeOpenaiKey;

  const handleSaveSmart = async () => {
    setSavingSmart(true);
    try {
      await invoke('stt_set_smart_matching', { enabled: draftSmartMatching, openaiApiKey: draftSmartKey || undefined });
      useSpeechStore.getState().setSmartMatching(draftSmartMatching);
      if (draftSmartKey) useSpeechStore.getState().setOpenaiApiKey(draftSmartKey);
    } catch (e) {
      console.error('[STT] Failed to save smart matching:', e);
    } finally {
      setSavingSmart(false);
    }
  };

  const loadCommands = async () => {
    setLoading(true);
    try {
      const result = await invoke<{ commands: VoiceCommandDef[]; builtinDefaults: VoiceCommandDef[] }>('stt_get_voice_commands');
      setCommands(result.commands);
      setBuiltinDefaults(result.builtinDefaults);
    } catch (e) {
      console.error('[STT] Failed to load voice commands:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadCommands(); }, []);

  const handleSaveCommands = async () => {
    setSaving(true);
    try {
      const builtinOverrides: Record<string, { triggerPhrases?: string[]; enabled?: boolean }> = {};
      const customs: VoiceCommandDef[] = [];

      for (const cmd of commands) {
        if (cmd.type === 'builtin') {
          const def = builtinDefaults.find((d) => d.id === cmd.id);
          if (def) {
            const phrasesChanged = JSON.stringify(cmd.triggerPhrases) !== JSON.stringify(def.triggerPhrases);
            const enabledChanged = cmd.enabled !== def.enabled;
            if (phrasesChanged || enabledChanged) {
              builtinOverrides[cmd.id] = {};
              if (phrasesChanged) builtinOverrides[cmd.id].triggerPhrases = cmd.triggerPhrases;
              if (enabledChanged) builtinOverrides[cmd.id].enabled = cmd.enabled;
            }
          }
        } else {
          customs.push(cmd);
        }
      }

      await invoke('stt_set_voice_commands', { customCommands: customs, builtinOverrides });
      setDirty(false);
    } catch (e) {
      console.error('[STT] Failed to save voice commands:', e);
    } finally {
      setSaving(false);
    }
  };

  const updateCommand = (id: string, updates: Partial<VoiceCommandDef>) => {
    setCommands((prev) =>
      prev.map((cmd) => (cmd.id === id ? { ...cmd, ...updates } : cmd))
    );
    setDirty(true);
  };

  const deleteCommand = (id: string) => {
    setCommands((prev) => prev.filter((cmd) => cmd.id !== id));
    setDirty(true);
  };

  const addCustomCommand = () => {
    if (!newCommandName.trim() || !newCommandPhrases.trim() || !newCommandScript.trim()) return;

    const newCmd: VoiceCommandDef = {
      id: `custom-${Date.now()}`,
      name: newCommandName.trim(),
      triggerPhrases: newCommandPhrases.split(',').map((p) => p.trim()).filter(Boolean),
      action: { kind: 'shell', command: newCommandScript.trim(), background: newCommandBg },
      type: 'custom',
      enabled: true,
    };

    setCommands((prev) => [...prev, newCmd]);
    setNewCommandName('');
    setNewCommandPhrases('');
    setNewCommandScript('');
    setNewCommandBg(true);
    setDirty(true);
  };

  const builtins = commands.filter((c) => c.type === 'builtin');
  const customs = commands.filter((c) => c.type === 'custom');

  const actionLabel = (cmd: VoiceCommandDef) => {
    const a = cmd.action;
    if (a.kind === 'navigate') return `Navigate → ${a.target}`;
    if (a.kind === 'start-transcribe') return 'Start dictation';
    if (a.kind === 'stop-transcribe') return 'Stop dictation';
    if (a.kind === 'stop-transcribe-enter') return 'Stop dictation + Enter';
    if (a.kind === 'press-enter') return 'Press Enter';
    if (a.kind === 'create-session') return `New ${a.sessionType}`;
    if (a.kind === 'close-session') return `Close ${a.sessionType}`;
    if (a.kind === 'dismiss-commands') return 'Exit command mode';
    if (a.kind === 'stop-listening') return 'Stop mic entirely';
    if (a.kind === 'shell') return `Run: ${a.command}`;
    return a.kind;
  };

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        Voice commands are triggered after the wake phrase is detected. Edit trigger phrases or add custom shell commands below.
      </p>

      {/* Smart command matching */}
      <div
        className="p-3 rounded-lg space-y-2"
        style={{ background: 'var(--bg-secondary)', border: `1px solid ${draftSmartMatching ? 'var(--accent)' : 'var(--border)'}` }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5" style={{ color: draftSmartMatching ? 'var(--accent)' : 'var(--text-secondary)' }} />
            <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              Smart Command Matching
            </span>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={draftSmartMatching}
              onChange={(e) => setDraftSmartMatching(e.target.checked)}
              className="sr-only peer"
            />
            <div
              className="w-8 h-4 rounded-full peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:start-0.5 after:rounded-full after:h-3 after:w-3 after:transition-all"
              style={{
                background: draftSmartMatching ? 'var(--accent)' : 'var(--bg-tertiary)',
                border: `1px solid ${draftSmartMatching ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
              <div
                className="absolute top-0.5 h-3 w-3 rounded-full transition-all"
                style={{
                  background: 'white',
                  left: draftSmartMatching ? 'calc(100% - 14px)' : '2px',
                }}
              />
            </div>
          </label>
        </div>
        <p className="text-[10px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Uses GPT-5 mini to intelligently classify voice commands. Handles short words like "stop", "start", "send" and garbled transcriptions much better than phrase matching. Falls back to phrase matching if disabled or if the API call fails.
        </p>
        {draftSmartMatching && (
          <div className="space-y-1">
            <label className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              OpenAI API Key {storeOpenaiKey && <span style={{ color: '#16a34a' }}>(shared with Speech settings)</span>}
            </label>
            <div className="relative">
              <input
                type={showSmartKey ? 'text' : 'password'}
                value={draftSmartKey}
                onChange={(e) => setDraftSmartKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-2.5 py-1.5 rounded-md text-[11px] font-mono outline-none"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                }}
              />
              <button
                onClick={() => setShowSmartKey(!showSmartKey)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded"
                style={{ color: 'var(--text-secondary)' }}
              >
                {showSmartKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
            {!draftSmartKey && (
              <p className="text-[10px]" style={{ color: '#f97316' }}>
                An OpenAI API key is required for smart matching.
              </p>
            )}
          </div>
        )}
        {smartDirty && (
          <button
            onClick={handleSaveSmart}
            disabled={savingSmart || (draftSmartMatching && !draftSmartKey)}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium disabled:opacity-30"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            {savingSmart ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            {savingSmart ? 'Saving...' : 'Save'}
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--accent)' }} />
        </div>
      ) : (
        <>
          {/* Built-in commands */}
          <p className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>Built-in Commands</p>
              {builtins.map((cmd) => (
                <div key={cmd.id} className="flex items-start gap-2 p-2 rounded" style={{ background: 'var(--bg-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={cmd.enabled}
                    onChange={(e) => updateCommand(cmd.id, { enabled: e.target.checked })}
                    className="mt-0.5 shrink-0"
                  />
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>{cmd.name}</span>
                      <span className="text-[9px] px-1 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                        {actionLabel(cmd)}
                      </span>
                    </div>
                    <input
                      type="text"
                      value={cmd.triggerPhrases.join(', ')}
                      onChange={(e) => updateCommand(cmd.id, {
                        triggerPhrases: e.target.value.split(',').map((p) => p.trim()).filter(Boolean),
                      })}
                      className="w-full px-1.5 py-1 rounded text-[10px] font-mono outline-none"
                      style={{
                        background: 'var(--bg-tertiary)',
                        color: cmd.enabled ? 'var(--text-primary)' : 'var(--text-secondary)',
                        border: '1px solid var(--border)',
                        opacity: cmd.enabled ? 1 : 0.5,
                      }}
                    />
                  </div>
                </div>
              ))}

              {/* Custom commands */}
              <p className="text-[10px] font-medium mt-2" style={{ color: 'var(--text-secondary)' }}>Custom Commands</p>
              {customs.length === 0 && (
                <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>No custom commands yet.</p>
              )}
              {customs.map((cmd) => (
                <div key={cmd.id} className="flex items-start gap-2 p-2 rounded" style={{ background: 'var(--bg-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={cmd.enabled}
                    onChange={(e) => updateCommand(cmd.id, { enabled: e.target.checked })}
                    className="mt-0.5 shrink-0"
                  />
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>{cmd.name}</span>
                      {cmd.action.kind === 'shell' && (
                        <span className="text-[9px] px-1 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                          {cmd.action.background ? 'background' : 'terminal'}
                        </span>
                      )}
                    </div>
                    <input
                      type="text"
                      value={cmd.triggerPhrases.join(', ')}
                      onChange={(e) => updateCommand(cmd.id, {
                        triggerPhrases: e.target.value.split(',').map((p) => p.trim()).filter(Boolean),
                      })}
                      placeholder="Trigger phrases (comma-separated)"
                      className="w-full px-1.5 py-1 rounded text-[10px] font-mono outline-none"
                      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                    />
                    {cmd.action.kind === 'shell' && (
                      <input
                        type="text"
                        value={cmd.action.command || ''}
                        onChange={(e) => updateCommand(cmd.id, {
                          action: { ...cmd.action, command: e.target.value },
                        })}
                        placeholder="Shell command"
                        className="w-full px-1.5 py-1 rounded text-[10px] font-mono outline-none"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                      />
                    )}
                  </div>
                  <button
                    onClick={() => deleteCommand(cmd.id)}
                    className="p-1 rounded hover:opacity-80 shrink-0"
                    style={{ color: 'var(--error)' }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}

              {/* Add custom command */}
              <div className="p-2 rounded space-y-1.5" style={{ background: 'var(--bg-secondary)', border: '1px dashed var(--border)' }}>
                <p className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>Add Custom Command</p>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={newCommandName}
                    onChange={(e) => setNewCommandName(e.target.value)}
                    placeholder="Name"
                    className="flex-1 px-1.5 py-1 rounded text-[10px] outline-none"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                  />
                  <label className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                    <input
                      type="checkbox"
                      checked={newCommandBg}
                      onChange={(e) => setNewCommandBg(e.target.checked)}
                    />
                    Background
                  </label>
                </div>
                <input
                  type="text"
                  value={newCommandPhrases}
                  onChange={(e) => setNewCommandPhrases(e.target.value)}
                  placeholder="Trigger phrases (comma-separated)"
                  className="w-full px-1.5 py-1 rounded text-[10px] font-mono outline-none"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                />
                <input
                  type="text"
                  value={newCommandScript}
                  onChange={(e) => setNewCommandScript(e.target.value)}
                  placeholder="Shell command or script"
                  className="w-full px-1.5 py-1 rounded text-[10px] font-mono outline-none"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                />
                <button
                  onClick={addCustomCommand}
                  disabled={!newCommandName.trim() || !newCommandPhrases.trim() || !newCommandScript.trim()}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium disabled:opacity-30"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              </div>

              {/* Save commands */}
          {dirty && (
            <button
              onClick={handleSaveCommands}
              disabled={saving}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[10px] font-medium w-full justify-center"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              {saving ? 'Saving...' : 'Save Commands'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
