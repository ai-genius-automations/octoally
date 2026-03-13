<p align="center">
  <h1 align="center">🚀 OpenFlow</h1>
  <p align="center">
    <strong>AI Coding Session Orchestration Dashboard</strong>
  </p>
  <p align="center">
    The dashboard for Claude Code. Launch, monitor, and manage AI coding sessions<br>
    with <a href="https://github.com/ruvnet/ruflo">RuFlo</a> multi-agent orchestration — all from one place.
  </p>
</p>

<p align="center">
  <a href="https://github.com/ai-genius-automations/openflow/stargazers"><img src="https://img.shields.io/github/stars/ai-genius-automations/openflow?style=flat&color=gold" alt="GitHub Stars"></a>
  <a href="https://github.com/ai-genius-automations/openflow/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0%20+%20Commons%20Clause-blue" alt="License"></a>
  <a href="https://github.com/ai-genius-automations/openflow/releases"><img src="https://img.shields.io/github/v/release/ai-genius-automations/openflow?color=green" alt="Release"></a>
  <a href="https://aigeniusautomations.com"><img src="https://img.shields.io/badge/by-AI%20Genius%20Automations-purple" alt="AI Genius Automations"></a>
</p>

---

> **OpenFlow** is a local-first orchestration dashboard for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [RuFlo](https://github.com/ruvnet/ruflo). Run multi-agent hive-mind sessions, single-agent workflows, and interactive terminals — all from a beautiful web UI with real-time streaming.

---

## ✨ Features

- 🐝 **Hive-Mind Sessions** — Launch multi-agent Claude Code orchestration via [RuFlo](https://github.com/ruvnet/ruflo)
- 🤖 **Agent Sessions** — Run single-agent sessions with custom agent definitions (`.claude/agents/*.md`)
- 💻 **Terminal Sessions** — Interactive terminals managed through the dashboard
- 📡 **Real-Time Streaming** — WebSocket-powered live output, tool calls, and progress tracking
- 📁 **Project Management** — Multi-project support with per-project RuFlo initialization and agent configurations
- 📋 **Task Queue** — Organize and queue work items for your coding sessions
- 🎙️ **Speech-to-Text** — Voice commands via local Whisper or cloud APIs (desktop app)
- 🖥️ **Desktop App** — Electron system tray app with native STT and auto-launch
- 🔒 **Encrypted Config** — API keys encrypted at rest with AES-256-GCM

---

## 📦 Quick Install

### Supported Platforms

| Platform | Status |
|----------|--------|
| **Linux** (Ubuntu/Debian) | ✅ Fully supported |
| **macOS** | 🔜 Coming soon |

### Prerequisites

| Requirement | Why | Install |
|-------------|-----|---------|
| **Node.js 20+** | Runtime for the server | [nodejs.org](https://nodejs.org) |
| **Claude Code** | AI coding agent | `npm install -g @anthropic-ai/claude-code` |

> **Important:** Before installing OpenFlow, you must run Claude Code at least once to accept terms and enable non-interactive mode:
> ```bash
> claude                              # Accept terms & sign in
> claude --dangerously-skip-permissions  # Enable non-interactive agent sessions
> ```

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/ai-genius-automations/openflow/main/scripts/install.sh | bash
```

The installer will:
1. Check for Node.js and Claude Code (offer to install if missing)
2. Verify Claude Code has been initialized
3. Download and extract the pre-built release
4. Install the `openflow` CLI
5. Start the server
6. Optionally install the desktop app

> 💡 **Custom install location:** `OPENFLOW_INSTALL_DIR=/opt/openflow bash install.sh`

### What you get

- **Web Dashboard:** http://localhost:42010
- **CLI:** `openflow start | stop | restart | status | update | logs`
- **Desktop App:** Optional Electron app with system tray and speech-to-text

### Manual Install (Development)

```bash
git clone https://github.com/ai-genius-automations/openflow.git
cd openflow

# Server
cd server && npm install && npm run build && cd ..

# Dashboard
cd dashboard && npm install && npm run build && cd ..

# Start
cd server && npm start
```

- **Dashboard:** http://localhost:42010
- **Dev mode (with hot reload):** `cd server && npm run dev` + `cd dashboard && npm run dev`

---

## 🛠️ How It Works

OpenFlow is a dashboard that sits on top of **Claude Code** and **RuFlo**:

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** is Anthropic's CLI agent for coding tasks
- **[RuFlo](https://github.com/ruvnet/ruflo)** adds multi-agent orchestration, hive-mind coordination, and memory to Claude Code
- **OpenFlow** provides the UI to manage projects, launch sessions, and monitor everything in real-time

When you add a project and enable RuFlo, OpenFlow automatically initializes the project with agent definitions, hive-mind support, and the configuration files Claude Code needs. You then launch sessions directly from the dashboard.

---

## 🖥️ CLI Commands

```bash
openflow start              # Start the server (background)
openflow stop               # Stop the server
openflow restart            # Restart
openflow status             # Show version, channel, and update info
openflow update             # Check for and apply updates
openflow channel [name]     # Switch release channel (stable/beta/canary)
openflow logs               # Tail server logs
openflow install-service    # Install as systemd/launchd service (auto-start)
openflow uninstall-service  # Remove the system service
```

---

## 🏗️ Architecture

```
┌──────────────────────┐     WebSocket      ┌─────────────────────────┐
│   Dashboard (React)  │ ◄────────────────► │    Server (Fastify)     │
│   Vite + Tailwind    │                    │    SQLite + WebSocket   │
│   TanStack Query     │                    │                         │
│   Zustand            │                    │    PTY Worker           │
└──────────────────────┘                    │    ├── tmux sessions    │
                                            │    ├── Claude Code      │
┌──────────────────────┐                    │    ├── RuFlo agents     │
│   Desktop (Electron) │                    │    └── Terminal shells  │
│   System tray        │ ◄────────────────► │                         │
│   Speech-to-text     │                    └─────────────────────────┘
└──────────────────────┘
```

| Layer | Stack |
|-------|-------|
| **Frontend** | React 19, Vite, Tailwind CSS 4, TanStack Query, Zustand, xterm.js |
| **Backend** | Fastify, TypeScript, SQLite (better-sqlite3), node-pty, WebSocket |
| **Desktop** | Electron, system tray, local Whisper STT, AES-256-GCM config encryption |
| **Sessions** | tmux for persistence, dtach for detach/reattach, Claude Code + RuFlo |

---

## 📂 Project Structure

```
openflow/
├── server/              # Fastify backend
│   └── src/
│       ├── routes/      # REST API endpoints
│       ├── services/    # Session manager, PTY worker, state tracking
│       └── db/          # SQLite schema and migrations
├── dashboard/           # React frontend
│   └── src/
│       ├── components/  # UI components
│       └── lib/         # API client, stores, utilities
├── desktop-electron/    # Electron desktop app
│   └── src/
│       └── speech/      # Whisper STT integration
├── bin/                 # CLI launcher
└── scripts/             # Install, build-release, update, and service scripts
```

---

## ⚙️ Configuration

Copy `.env.example` to `.env` in the project root:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `42010` | Server port |
| `OPENFLOW_TOKEN` | *(none)* | Auth token for API/WebSocket — leave empty for local use |
| `DB_PATH` | `~/.openflow/openflow.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Log verbosity (`trace` / `debug` / `info` / `warn` / `error`) |
| `OPENFLOW_USE_TMUX` | `true` | Use tmux for session management |
| `OPENFLOW_USE_DTACH` | `true` | Use dtach for session persistence |

---

## 🖥️ Desktop App

The Electron desktop app adds:
- System tray with quick server access
- Automatic server lifecycle management
- Local speech-to-text via Whisper (no cloud needed)
- Cloud STT via OpenAI Whisper API or Groq (API keys encrypted at rest)

The desktop app is offered during installation, or can be downloaded from [GitHub Releases](https://github.com/ai-genius-automations/openflow/releases).

---

## 🤝 Contributing

Contributions are welcome! Please open an issue or pull request.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push and open a PR

---

## 📄 License

**Apache License 2.0 with Commons Clause** — see [LICENSE](LICENSE) for full details.

You are free to use, modify, and distribute OpenFlow. You may use it as a tool in your workflow to build products you charge for. However, you may not sell products or services whose value derives substantially from OpenFlow itself. Any product that incorporates OpenFlow source code must be distributed free of charge.

Copyright 2025 [AI Genius Automations](https://aigeniusautomations.com)
