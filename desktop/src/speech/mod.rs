pub mod audio;
pub mod download;
pub mod vad;
pub mod whisper;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

use self::audio::AudioCapture;
use self::whisper::WhisperEngine;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum MicMode {
    Off,
    Global,
    PushToTalk,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelSize {
    Tiny,
    Small,
    Medium,
}

impl ModelSize {
    pub fn file_name(&self) -> &'static str {
        match self {
            ModelSize::Tiny => "ggml-tiny.bin",
            ModelSize::Small => "ggml-small.bin",
            ModelSize::Medium => "ggml-medium.bin",
        }
    }

    pub fn download_url(&self) -> String {
        format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
            self.file_name()
        )
    }

    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "tiny" => Ok(ModelSize::Tiny),
            "small" => Ok(ModelSize::Small),
            "medium" => Ok(ModelSize::Medium),
            _ => Err(format!("Unknown model size: {s}. Use tiny, small, or medium.")),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub installed: bool,
    pub model_size: String,
    pub path: String,
    pub size_bytes: Option<u64>,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttStatus {
    pub mode: MicMode,
    pub model_loaded: bool,
    pub model_size: String,
    pub speaking: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionPayload {
    pub text: String,
    pub is_final: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct VadStatusPayload {
    pub speaking: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressPayload {
    pub percent: f32,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct SpeechState {
    pub inner: Mutex<SpeechInner>,
}

pub struct SpeechInner {
    pub mode: MicMode,
    pub model_size: ModelSize,
    pub whisper_engine: Option<WhisperEngine>,
    pub audio_capture: Option<AudioCapture>,
    pub speaking: bool,
    pub last_activity: Instant,
    pub selected_device: Option<String>, // None = system default
}

impl SpeechState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SpeechInner {
                mode: MicMode::Off,
                model_size: ModelSize::Small,
                whisper_engine: None,
                audio_capture: None,
                speaking: false,
                last_activity: Instant::now(),
                selected_device: None,
            }),
        }
    }
}

/// Returns the models directory: ~/.hivecommand/models/
pub fn models_dir() -> PathBuf {
    let home = dirs::home_dir().expect("Could not determine home directory");
    home.join(".hivecommand").join("models")
}

/// Returns the path for a given model size
pub fn model_path(size: &ModelSize) -> PathBuf {
    models_dir().join(size.file_name())
}

// ---------------------------------------------------------------------------
// Types for device listing
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
    pub is_hardware: bool,
    pub formats: Vec<String>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn stt_list_devices() -> Result<Vec<AudioDevice>, String> {
    audio::list_input_devices()
}

#[tauri::command]
pub async fn stt_set_device(
    state: State<'_, SpeechState>,
    device_name: Option<String>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    eprintln!("[STT] Setting device to: {:?}", device_name);
    inner.selected_device = device_name;

    // If currently capturing, restart with the new device
    if inner.audio_capture.is_some() {
        eprintln!("[STT] Restarting audio capture with new device");
        inner.audio_capture = None;
        // Caller should call stt_start again to restart with new device
    }

    Ok(())
}

#[tauri::command]
pub async fn stt_check_model(
    state: State<'_, SpeechState>,
) -> Result<ModelStatus, String> {
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    let path = model_path(&inner.model_size);
    let installed = path.exists();
    let size_bytes = if installed {
        std::fs::metadata(&path).ok().map(|m| m.len())
    } else {
        None
    };

    Ok(ModelStatus {
        installed,
        model_size: format!("{:?}", inner.model_size).to_lowercase(),
        path: path.to_string_lossy().to_string(),
        size_bytes,
        active: true,
    })
}

#[tauri::command]
pub async fn stt_list_models(
    state: State<'_, SpeechState>,
) -> Result<Vec<ModelStatus>, String> {
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    let active_size = format!("{:?}", inner.model_size).to_lowercase();

    let sizes = [ModelSize::Tiny, ModelSize::Small, ModelSize::Medium];
    let mut result = Vec::new();

    for size in &sizes {
        let path = model_path(size);
        let installed = path.exists();
        let size_bytes = if installed {
            std::fs::metadata(&path).ok().map(|m| m.len())
        } else {
            None
        };
        let name = format!("{:?}", size).to_lowercase();
        let active = name == active_size;

        result.push(ModelStatus {
            installed,
            model_size: name,
            path: path.to_string_lossy().to_string(),
            size_bytes,
            active,
        });
    }

    Ok(result)
}

/// Switch the active model size. If mic is running, it will be restarted.
#[tauri::command]
pub async fn stt_set_model(
    state: State<'_, SpeechState>,
    model_size: String,
) -> Result<(), String> {
    let size = ModelSize::from_str(&model_size)?;
    let path = model_path(&size);

    if !path.exists() {
        return Err(format!("Model '{}' is not installed. Download it first.", model_size));
    }

    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let current = format!("{:?}", inner.model_size).to_lowercase();
    if current == model_size {
        return Ok(()); // already active
    }

    eprintln!("[STT] Switching model from {} to {}", current, model_size);
    inner.model_size = size;

    // Must reload whisper engine with new model
    inner.audio_capture = None;
    inner.whisper_engine = None;
    inner.mode = MicMode::Off;
    inner.speaking = false;

    Ok(())
}

#[tauri::command]
pub async fn stt_download_model(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_size: String,
) -> Result<(), String> {
    let size = ModelSize::from_str(&model_size)?;
    let path = model_path(&size);

    // Update preferred model size
    {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.model_size = size.clone();
    }

    // Create models directory
    let dir = models_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create models directory: {e}"))?;

    let url = size.download_url();
    download::download_model(app, &url, &path).await
}

#[tauri::command]
pub async fn stt_start(
    app: AppHandle,
    state: State<'_, SpeechState>,
    mode: String,
) -> Result<(), String> {
    let mic_mode = match mode.as_str() {
        "global" => MicMode::Global,
        "push-to-talk" => MicMode::PushToTalk,
        _ => return Err(format!("Unknown mode: {mode}. Use 'global' or 'push-to-talk'.")),
    };

    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;

    // Check model is installed
    let path = model_path(&inner.model_size);
    if !path.exists() {
        return Err("Model not installed. Call stt_download_model first.".into());
    }

    // Load whisper model if not already loaded
    if inner.whisper_engine.is_none() {
        let engine = WhisperEngine::new(&path, app.clone())
            .map_err(|e| format!("Failed to load whisper model: {e}"))?;
        inner.whisper_engine = Some(engine);
    }

    // Start audio capture if not already running
    if inner.audio_capture.is_none() {
        let whisper_tx = inner
            .whisper_engine
            .as_ref()
            .unwrap()
            .sender();

        let app_clone = app.clone();
        let device_name = inner.selected_device.clone();
        let capture = AudioCapture::new(app_clone, whisper_tx, device_name.as_deref())
            .map_err(|e| format!("Failed to start audio capture: {e}"))?;
        inner.audio_capture = Some(capture);
    }

    inner.mode = mic_mode;
    inner.last_activity = Instant::now();

    Ok(())
}

#[tauri::command]
pub async fn stt_stop(
    state: State<'_, SpeechState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;

    // Stop audio capture (drops the cpal stream)
    inner.audio_capture = None;
    inner.mode = MicMode::Off;
    inner.speaking = false;

    // Keep whisper model loaded — inactivity timer will unload it

    Ok(())
}

#[tauri::command]
pub async fn stt_unload_model(
    state: State<'_, SpeechState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;

    // Stop capture first
    inner.audio_capture = None;
    inner.mode = MicMode::Off;
    inner.speaking = false;

    // Drop whisper model — frees ~500MB RAM
    inner.whisper_engine = None;

    Ok(())
}

#[tauri::command]
pub async fn stt_status(
    state: State<'_, SpeechState>,
) -> Result<SttStatus, String> {
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(SttStatus {
        mode: inner.mode.clone(),
        model_loaded: inner.whisper_engine.is_some(),
        model_size: format!("{:?}", inner.model_size).to_lowercase(),
        speaking: inner.speaking,
    })
}

// ---------------------------------------------------------------------------
// Inactivity watcher — unloads model after 5 min idle
// ---------------------------------------------------------------------------

pub fn start_inactivity_watcher(app: AppHandle) {
    let timeout = std::time::Duration::from_secs(300); // 5 minutes

    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(30));

            let state = app.state::<SpeechState>();
            let mut inner = match state.inner.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };

            // Only unload if mic is off and model is loaded
            if inner.mode == MicMode::Off
                && inner.whisper_engine.is_some()
                && inner.last_activity.elapsed() > timeout
            {
                inner.whisper_engine = None;
                let _ = app.emit("stt://model-unloaded", ());
            }
        }
    });
}
