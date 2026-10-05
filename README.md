<p align="center">
  <img src="https://raw.githubusercontent.com/ai-genius-automations/octoally/59dc5a2/dashboard/public/octoally-logo-lg.png" alt="OctoAlly" width="500">
  <p align="center">
    <strong>AI Coding Session Orchestration Dashboard</strong>
  </p>
  <p align="center">
    The dashboard for Claude Code &amp; OpenAI Codex. Launch, monitor, and manage AI coding sessions<br>
    with built-in agents and specialist workflows — all from one place.
  </p>
</p>

<p align="center">
  <a href="https://github.com/ai-genius-automations/octoally/stargazers"><img src="https://img.shields.io/github/stars/ai-genius-automations/octoally?style=flat&color=gold" alt="GitHub Stars"></a>
  <a href="https://github.com/ai-genius-automations/octoally/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0%20+%20Commons%20Clause-blue" alt="License"></a>
  <a href="https://github.com/ai-genius-automations/octoally/releases"><img src="https://img.shields.io/github/v/release/ai-genius-automations/octoally?color=green" alt="Release"></a>
  <a href="https://octoally.com"><img src="https://img.shields.io/badge/website-octoally.com-blue" alt="Website"></a>
  <a href="https://aigeniusautomations.com"><img src="https://img.shields.io/badge/by-AI%20Genius%20Automations-purple" alt="AI Genius Automations"></a>
</p>

---

> **OctoAlly** is a local-first orchestration dashboard for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [OpenAI Codex](https://github.com/openai/codex). Run agent sessions, specialist workflows, and interactive terminals — with both Claude and Codex CLIs — all from a beautiful web UI with real-time streaming.

---

## Screenshots

<p align="center">
<img src="docs/screenshots/active-sessions.png" alt="Active Sessions Grid" width="100%">
</p>

**Active Sessions Grid** — Monitor all your AI coding sessions at a glance. The grid view shows every running session across all projects — agent sessions, Claude Code sessions, and terminals — each with live-streaming output. Click any cell to expand, or use the column controls to fit your screen.

<table>
<tr>
<td width="50%">
<img src="docs/screenshots/projects.png" alt="Project Management">
<p><b>Project Management</b> — Organize all your projects in one place. Add project folders, manage git repos and branches, and launch sessions directly from the project card. Each project gets its own configuration, color theme, and session history.</p>
</td>
<td width="50%">
<img src="docs/screenshots/hivemind.png" alt="Agent Session">
<p><b>Agent Session</b> — Launch specialist agents for targeted tasks. Choose from 36 built-in agents covering development, code review, testing, security, infrastructure, data engineering, and more. Each agent runs with focused tools and expertise for its domain.</p>
</td>
</tr>
<tr>
<td width="50%">
<img src="docs/screenshots/terminal.png" alt="Terminal Session">
<p><b>Interactive Terminals</b> — Full terminal sessions managed through tmux. Pop out to a system terminal anytime, do your work, then adopt the session back into OctoAlly — it picks up right where you left off. Sessions persist across server restarts.</p>
</td>
<td width="50%">
<img src="docs/screenshots/source.png" alt="Git Source Control">
<p><b>Git Source Control</b> — Built-in git integration with side-by-side diffs, staged/unstaged changes, commit history, and a file explorer. Review what your AI agents changed, stage files, and commit — all without leaving the dashboard.</p>
</td>
</tr>
</table>

**More highlights:**

- **Reconnect anytime** — Close a tab, restart the server, even reboot — every session is backed by tmux and persists. Reconnect and pick up exactly where you left off with full scrollback.
- **Pop out & adopt back** — Open any session in your system terminal (`tmux attach`), work with your favorite tools, then bring it back into the dashboard. No lock-in.
- **Voice dictation** — Speak your instructions using local Whisper STT (no cloud, no data leaves your machine) or cloud APIs like OpenAI/Groq. API keys are encrypted at rest with AES-256-GCM.
- **36 built-in agents** — Ships with specialist agents for frontend, backend, security, testing, DevOps, data, and more. Define custom agents in `.claude/agents/*.md` and launch them from the dashboard.
- **Dual CLI support** — Launch sessions with either Claude Code or OpenAI Codex. Each session tracks which CLI it uses, with branded icons and separate configuration.

---

## Features

- **Active Sessions Grid** — See every running session across all projects in a live-updating grid with real-time streaming output
- **Agent Sessions** — Launch specialist agents (code reviewer, debugger, security auditor, and 33 more) with focused tools and expertise
- **Agent Sessions** — Run single-agent sessions with Claude Code (`.claude/agents/*.md`) or Codex
- **Dual CLI Support** — Switch between Claude Code and OpenAI Codex per-session with branded icons, separate commands, and per-CLI settings
- **Interactive Terminals** — Full terminal sessions with tmux persistence — pop out to system terminal and adopt back anytime
- **Built-in Web Browser** — Browse and test web apps alongside your coding sessions with full OAuth support
- **Git Source Control** — Side-by-side diffs, staged changes, commit history, and file explorer — review and commit AI-generated changes in-app
- **File Explorer** — Browse your project files, open and edit them, all from the sidebar
- **Session Persistence** — Every session survives server restarts, tab closes, and reboots — reconnect with full scrollback
- **Real-Time Streaming** — WebSocket-powered live output, tool calls, and progress tracking
- **Multi-Project Support** — Per-project agent configurations, color-coded cards, and session management
- **Voice Dictation** — Speak your instructions via local Whisper or cloud APIs (OpenAI, Groq) — keys encrypted at rest
- **Desktop App** — Electron system tray app with auto-launch, server management, and native STT

---

## Quick Install

### Supported Platforms

| Platform | Status |
|----------|--------|
| **Linux** (Ubuntu/Debian) | Fully supported |
| **macOS** (Intel & Apple Silicon) | Fully supported |

### Prerequisites

| Requirement | Why | Install |
|-------------|-----|---------|
| **Node.js 20+** | Runtime for the server | [nodejs.org](https://nodejs.org) |
| **Claude Code** | Anthropic's AI coding agent | `npm install -g @anthropic-ai/claude-code` |
| **Codex CLI** *(optional)* | OpenAI's AI coding agent | `npm install -g @openai/codex` |

> **Important:** Before installing OctoAlly, you must run Claude Code at least once to accept terms and enable non-interactive mode:
> ```bash
> claude                              # Accept terms & sign in
> claude --dangerously-skip-permissions  # Enable non-interactive agent sessions
> ```
>
> For Codex support, also run:
> ```bash
> codex                               # Accept terms & sign in
> ```

### Install

```bash
npx octoally@latest
```

Installs OctoAlly, starts the server, and launches the desktop app. On subsequent runs, automatically updates if a new version is available.

> **Custom install location:** `OCTOALLY_INSTALL_DIR=/opt/octoally npx octoally@latest`

### What you get

- **Web Dashboard:** http://localhost:42010
- **CLI:** `octoally start | stop | restart | status | update | logs`
- **Desktop App:** Optional Electron app with system tray and speech-to-text

### Manual Install (Development)

```bash
git clone https://github.com/ai-genius-automations/octoally.git
cd octoally

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

## How It Works

OctoAlly is a dashboard that sits on top of **Claude Code** and **OpenAI Codex**:

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** is Anthropic's CLI agent for coding tasks (uses `CLAUDE.md` for project instructions)
- **[OpenAI Codex](https://github.com/openai/codex)** is OpenAI's CLI agent for coding tasks (uses `AGENTS.md` for project instructions)
- **OctoAlly** provides the UI to manage projects, launch sessions, and monitor everything in real-time

When you add a project, OctoAlly installs 36 default agent definitions to `~/.claude/agents/` covering development, testing, security, infrastructure, and more. You can then launch sessions or specialist agents with either Claude or Codex directly from the dashboard — each session tracks which CLI is running, with branded icons and per-CLI settings.

---

## CLI Commands

```bash
octoally start              # Start the server (background)
octoally stop               # Stop the server
octoally restart            # Restart
octoally status             # Show version, channel, and update info
octoally update             # Check for and apply updates
octoally channel [name]     # Switch release channel (stable/beta/canary)
octoally logs               # Tail server logs
octoally install-service    # Install as systemd/launchd service (auto-start)
octoally uninstall-service  # Remove the system service
```

---

## Architecture

```
┌──────────────────────┐     WebSocket      ┌─────────────────────────┐
│   Dashboard (React)  │ <────────────────> │    Server (Fastify)     │
│   Vite + Tailwind    │                    │    SQLite + WebSocket   │
│   TanStack Query     │                    │                         │
│   Zustand            │                    │    PTY Worker           │
└──────────────────────┘                    │    ├── tmux sessions    │
                                            │    ├── Claude Code      │
┌──────────────────────┐                    │    ├── Agent sessions   │
│   Desktop (Electron) │                    │    └── Terminal shells  │
│   System tray        │ <────────────────> │                         │
│   Speech-to-text     │                    └─────────────────────────┘
└──────────────────────┘
```

| Layer | Stack |
|-------|-------|
| **Frontend** | React 19, Vite, Tailwind CSS 4, TanStack Query, Zustand, xterm.js |
| **Backend** | Fastify, TypeScript, SQLite (better-sqlite3), node-pty, WebSocket |
| **Desktop** | Electron, system tray, local Whisper STT, AES-256-GCM config encryption |
| **Sessions** | tmux for persistence, dtach for detach/reattach, Claude Code + Codex |

---

## Project Structure

```
octoally/
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
└── scripts/             # Install, release, build-archive, update, and service scripts
```

---

## Configuration

Copy `.env.example` to `.env` in the project root:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `42010` | Server port |
| `HOST` | `localhost` | Bind address. Defaults to loopback only (127.0.0.1 and ::1) |
| `DB_PATH` | `~/.octoally/octoally.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Log verbosity (`trace` / `debug` / `info` / `warn` / `error`) |
| `OCTOALLY_USE_TMUX` | `true` | Use tmux for session management |
| `OCTOALLY_USE_DTACH` | `true` | Use dtach for session persistence |

The server is local-only by default: it listens on loopback and rejects requests with a non-loopback `Host` or `Origin` header. The API has **no authentication** — setting `HOST=0.0.0.0` (or any non-loopback address) lets anyone who can reach the port read/write files and run commands on your machine. Not recommended.

---

## Desktop App

The Electron desktop app adds:
- System tray with quick server access
- Automatic server lifecycle management
- Local speech-to-text via Whisper (no cloud needed)
- Cloud STT via OpenAI Whisper API or Groq (API keys encrypted at rest)

The desktop app is offered during installation, or can be downloaded from [GitHub Releases](https://github.com/ai-genius-automations/octoally/releases).

---

## Contributing

Contributions are welcome! Please open an issue or pull request.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push and open a PR

---

## License

**Apache License 2.0 with Commons Clause** — see [LICENSE](LICENSE) for full details.

You are free to use, modify, and distribute OctoAlly. You may use it as a tool in your workflow to build products you charge for. However, you may not sell products or services whose value derives substantially from OctoAlly itself. Any product that incorporates OctoAlly source code must be distributed free of charge.

Copyright 2025 [AI Genius Automations](https://aigeniusautomations.com)


## Star History

<a href="https://www.star-history.com/?repos=ai-genius-automations%2Foctoally&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=ai-genius-automations/octoally&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=ai-genius-automations/octoally&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=ai-genius-automations/octoally&type=date&legend=top-left" />
 </picture>
</a>
