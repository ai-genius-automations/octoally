import { useState } from 'react';
import { Bot, X, Copy, Check, Play } from 'lucide-react';

export function AgentGuideButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors hover:bg-white/10"
        style={{ color: 'var(--text-secondary)' }}
        title="Agent Integration Guide"
      >
        <Bot className="w-4 h-4" />
        <span className="hidden sm:inline">Agent API</span>
      </button>

      {open && <AgentGuideModal onClose={() => setOpen(false)} />}
    </>
  );
}

interface AgentGuideModalProps {
  onClose: () => void;
  projectName?: string;
  projectPath?: string;
  task?: string;
  additionalInstructions?: string;
}

export function AgentGuideModal({ onClose, projectName, projectPath, task, additionalInstructions }: AgentGuideModalProps) {
  const baseUrl = `${window.location.protocol}//${window.location.hostname}:42010`;
  const [copiedAll, setCopiedAll] = useState(false);
  const hasContext = !!(projectName && projectPath);

  const copyFullGuide = () => {
    const text = hasContext
      ? generateContextualGuide(baseUrl, projectName!, projectPath!, task, additionalInstructions)
      : generatePlainTextGuide(baseUrl);
    navigator.clipboard.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative rounded-xl border shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 border-b shrink-0"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5" style={{ color: 'var(--accent)' }} />
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {hasContext ? `Run ${projectName} with OpenClaw` : 'Agent Integration Guide'}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={copyFullGuide}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{
                background: copiedAll ? 'var(--success)' : 'var(--bg-tertiary)',
                color: copiedAll ? 'white' : 'var(--text-secondary)',
              }}
              title="Copy entire guide as plain text (for pasting into agent prompts)"
            >
              {copiedAll ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedAll ? 'Copied!' : 'Copy All'}
            </button>
            <button onClick={onClose} className="p-1 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}>
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Project context banner */}
          {hasContext && (
            <div
              className="rounded-lg border p-4 space-y-2"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--accent)', borderWidth: '1px' }}
            >
              <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--accent)' }}>
                <Play className="w-4 h-4" />
                Ready to Run
              </div>
              <div className="text-sm space-y-1" style={{ color: 'var(--text-secondary)' }}>
                <div><span className="font-medium" style={{ color: 'var(--text-primary)' }}>Project:</span> {projectName}</div>
                <div><span className="font-medium" style={{ color: 'var(--text-primary)' }}>Path:</span> <code className="text-xs font-mono">{projectPath}</code></div>
                {task && <div><span className="font-medium" style={{ color: 'var(--text-primary)' }}>Task:</span> {task}</div>}
                {additionalInstructions && (
                  <div>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Additional Instructions:</span>
                    <pre className="text-xs mt-1 whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{additionalInstructions}</pre>
                  </div>
                )}
              </div>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Click "Copy All" to copy the full command with project details, then paste it to OpenClaw.
              </p>
            </div>
          )}

          {/* Intro */}
          <Section title="Overview">
            <p>
              External bot agents (like OpenClaw) can fully control HiveCommand sessions via the REST API.
              Create sessions, send commands, read output, and respond to prompts — all programmatically.
            </p>
          </Section>

          {/* Capabilities endpoint */}
          <Section title="Self-Describing API">
            <p>
              The capabilities endpoint returns the full API spec, state machine, prompt types, and operational guidance.
              Point your agent here first:
            </p>
            <CodeBlock text={`GET ${baseUrl}/api/agent/capabilities`} />
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              This is the single source of truth for agent integration. It includes all endpoints, request/response schemas,
              error codes, and tips.
            </p>
          </Section>

          {/* Quick start */}
          <Section title="Quick Start">
            <ol className="list-decimal list-inside space-y-2">
              <li>
                <strong>List projects</strong> to find the target project ID:
                <CodeBlock text={`GET ${baseUrl}/api/projects`} />
              </li>
              <li>
                <strong>Create a session</strong> with a project path and task:
                <CodeBlock text={`POST ${baseUrl}/api/sessions
Content-Type: application/json

{
  "project_path": "/path/to/project",
  "task": "Fix the login bug",
  "project_id": "optional-project-id"
}`} />
              </li>
              <li>
                <strong>Poll for output + state</strong> with a single call (no side effects):
                <CodeBlock text={`GET ${baseUrl}/api/sessions/:id/display?lines=100

# Returns rendered terminal text + inline state:
{
  "sessionId": "...",
  "processState": "idle",
  "promptType": "choice",
  "choices": ["Option A", "Option B"],
  "output": "...last 100 lines of clean terminal text...",
  "cursor": 1234,
  "truncated": false
}`} />
              </li>
              <li>
                <strong>Poll incrementally</strong> — pass the <code>cursor</code> from previous response to only get new content:
                <CodeBlock text={`GET ${baseUrl}/api/sessions/:id/display?lines=100&since=1234`} />
              </li>
              <li>
                <strong>Send input</strong> when the session needs it (<code>waiting_for_input</code> or <code>idle</code>):
                <CodeBlock text={`POST ${baseUrl}/api/sessions/:id/execute
Content-Type: application/json

{
  "input": "your response or command",
  "timeout": 60000,
  "quiescenceMs": 5000
}`} />
              </li>
              <li>
                <strong>Repeat steps 3-5</strong> until the task is complete.
              </li>
            </ol>
          </Section>

          {/* Key rules */}
          <Section title="Critical Rules">
            <ul className="space-y-1.5">
              <Rule>ALWAYS read <code>/api/agent/capabilities</code> first before doing anything else.</Rule>
              <Rule>Use <code>GET /sessions/:id/display</code> for read-only monitoring — output + state in one call with cursor-based incremental polling.</Rule>
              <Rule>Use <code>POST /sessions/:id/execute</code> to send input and get the response.</Rule>
              <Rule>NEVER send empty strings, whitespace, or newlines as input — they produce no output. Always send meaningful text.</Rule>
              <Rule>NEVER read PTY output directly, scrape temp files, or parse raw terminal data.</Rule>
              <Rule>Check <code>processState</code> before sending input — if <code>busy</code>, wait.</Rule>
              <Rule>When <code>promptType</code> is <code>choice</code>, use the <code>choices</code> array to pick the right option number.</Rule>
              <Rule>Use <code>timeout: 60000</code> and <code>quiescenceMs: 5000</code> for hive-mind sessions (they are slower than raw Claude Code).</Rule>
            </ul>
          </Section>

          {/* Reading output */}
          <Section title="Reading Output (Display vs Execute)">
            <p>
              <strong><code>GET /sessions/:id/display</code></strong> — Read-only. Returns the last N lines of rendered terminal text
              plus inline state (processState, promptType, choices) in a single call. Use the <code>cursor</code> value
              for incremental polling — pass it back as <code>?since=cursor</code> to only get new content.
              This is the <strong>recommended way to monitor</strong> what a session is doing.
            </p>
            <p className="mt-2">
              <strong><code>POST /sessions/:id/execute</code></strong> — Send input and get output. Only returns
              <strong> new output generated after your input</strong>. Use this when you need to interact, not just observe.
              Send meaningful text (e.g. <code>"Ready"</code>), never empty strings.
            </p>
          </Section>

          {/* WebSocket */}
          <Section title="Real-Time WebSocket (Optional)">
            <p>
              For lower latency, connect via WebSocket instead of polling:
            </p>
            <CodeBlock text={`WS ${baseUrl.replace('http', 'ws')}/api/sessions/:id/agent`} />
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Supports <code>execute</code> and <code>get_state</code> messages. Pushes <code>state_change</code> and <code>output</code> events in real-time.
            </p>
          </Section>

          {/* All endpoints summary */}
          <Section title="All Endpoints">
            <div className="space-y-1 font-mono text-xs">
              <EndpointRow method="GET" path="/api/projects" desc="List all projects" />
              <EndpointRow method="POST" path="/api/projects" desc="Add a project" />
              <EndpointRow method="DELETE" path="/api/projects/:id" desc="Remove a project" />
              <EndpointRow method="GET" path="/api/sessions" desc="List all sessions" />
              <EndpointRow method="POST" path="/api/sessions" desc="Create a new session" />
              <EndpointRow method="DELETE" path="/api/sessions/:id" desc="Kill a session" />
              <EndpointRow method="GET" path="/api/sessions/:id/state" desc="Get session state" />
              <EndpointRow method="GET" path="/api/sessions/:id/display" desc="Rendered output + state (polling)" />
              <EndpointRow method="POST" path="/api/sessions/:id/execute" desc="Send input, get output" />
              <EndpointRow method="POST" path="/api/sessions/:id/cancel" desc="Cancel stuck execute" />
              <EndpointRow method="GET" path="/api/agent/capabilities" desc="Full API spec (self-describing)" />
              <EndpointRow method="GET" path="/api/context" desc="Concise session summary (low tokens)" />
              <EndpointRow method="WS" path="/api/sessions/:id/agent" desc="Real-time agent WebSocket" />
            </div>
          </Section>

          {/* Example bot loop */}
          <Section title="Example Agent Loop">
            <CodeBlock text={`// Minimal agent control loop
const BASE = "${baseUrl}/api";

// 1. Read capabilities first (important!)
const caps = await fetch(\`\${BASE}/agent/capabilities\`).then(r => r.json());

// 2. Create session
const { session } = await fetch(\`\${BASE}/sessions\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    project_path: "/home/user/myproject",
    task: "Fix the auth middleware"
  })
}).then(r => r.json());

// 3. Poll display endpoint for output + state (single call)
let cursor = null;
async function pollDisplay(id) {
  const url = cursor
    ? \`\${BASE}/sessions/\${id}/display?lines=100&since=\${cursor}\`
    : \`\${BASE}/sessions/\${id}/display?lines=100\`;
  const data = await fetch(url).then(r => r.json());
  cursor = data.cursor; // save for next incremental poll
  return data;
}

// 4. Wait for session to be ready, reading output along the way
let display;
while (true) {
  display = await pollDisplay(session.id);
  if (display.output) console.log(display.output);
  if (display.processState !== "busy") break;
  await new Promise(r => setTimeout(r, 2000));
}

// 5. Interact when session needs input
while (true) {
  if (display.processState === "waiting_for_input" || display.processState === "idle") {
    const input = decideInput(display); // your logic using output + promptType + choices

    const result = await fetch(\`\${BASE}/sessions/\${session.id}/execute\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, timeout: 60000, quiescenceMs: 5000 })
    }).then(r => r.json());
    console.log(result.output);
  }

  // Poll for new output
  await new Promise(r => setTimeout(r, 2000));
  display = await pollDisplay(session.id);
  if (display.output) console.log(display.output);
}`} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{title}</h3>
      <div className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {children}
      </div>
    </div>
  );
}

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group mt-2 mb-2">
      <pre
        className="text-xs font-mono p-3 rounded-lg overflow-x-auto"
        style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
      >
        {text}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
        title="Copy"
      >
        {copied ? <Check className="w-3 h-3" style={{ color: 'var(--success)' }} /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}

function Rule({ children }: { children: React.ReactNode }) {
  return (
    <li className="text-sm flex gap-2" style={{ color: 'var(--text-secondary)' }}>
      <span style={{ color: 'var(--accent)' }}>*</span>
      <span>{children}</span>
    </li>
  );
}

function generatePlainTextGuide(baseUrl: string): string {
  return `# HiveCommand Agent Integration Guide

## Overview
External bot agents can fully control HiveCommand sessions via the REST API.
Create sessions, send commands, read output, and respond to prompts — all programmatically.
Base URL: ${baseUrl}

## Self-Describing API (READ THIS FIRST)
The capabilities endpoint returns the full API spec, state machine, prompt types, and operational guidance.
ALWAYS read this before doing anything else:
GET ${baseUrl}/api/agent/capabilities

This is the single source of truth for agent integration. It includes all endpoints, request/response schemas, error codes, and tips.

## Quick Start

1. Read capabilities first:
   GET ${baseUrl}/api/agent/capabilities

2. List projects to find the target project:
   GET ${baseUrl}/api/projects

3. Create a session with a project path and task:
   POST ${baseUrl}/api/sessions
   Content-Type: application/json
   {"project_path": "/path/to/project", "task": "Fix the login bug", "project_id": "optional-project-id"}

4. Poll for output + state (single call, no side effects):
   GET ${baseUrl}/api/sessions/:id/display?lines=100
   Returns: { sessionId, processState, promptType, choices, output: "rendered text", cursor: 1234, truncated: false }

5. Poll incrementally — pass cursor from previous response to only get new content:
   GET ${baseUrl}/api/sessions/:id/display?lines=100&since=1234

6. Send input when the session needs it (processState is "idle" or "waiting_for_input"):
   POST ${baseUrl}/api/sessions/:id/execute
   Content-Type: application/json
   {"input": "your response", "timeout": 60000, "quiescenceMs": 5000}

7. Repeat steps 4-6 until the task is complete.

## Critical Rules
- ALWAYS read /api/agent/capabilities first before doing anything else.
- Use GET /api/sessions/:id/display for read-only monitoring — output + state in one call with cursor-based incremental polling.
- Use POST /api/sessions/:id/execute to send input and get the response.
- NEVER send empty strings (""), whitespace (" "), or newlines ("\\n") as input — they produce no output. Always send meaningful text.
- NEVER read PTY output directly, scrape temp files, or parse raw terminal data.
- Check processState before sending input — if "busy", wait.
- When promptType is "choice", use the choices array to pick the right option number.
- Use timeout: 60000 and quiescenceMs: 5000 for hive-mind sessions (they are slower than raw Claude Code).

## Reading Output (Display vs Execute)
GET /sessions/:id/display — Read-only. Returns the last N lines of rendered terminal text plus inline state (processState, promptType, choices) in a single call. Use the cursor value for incremental polling — pass it back as ?since=cursor to only get new content. This is the RECOMMENDED way to monitor what a session is doing.

POST /sessions/:id/execute — Send input and get output. Only returns NEW output generated AFTER your input. Use this when you need to interact, not just observe. Send meaningful text (e.g. "Ready"), never empty strings.

## Real-Time WebSocket (Optional)
For lower latency, connect via WebSocket instead of polling:
WS ${baseUrl.replace('http', 'ws')}/api/sessions/:id/agent
Supports "execute" and "get_state" messages. Pushes "state_change" and "output" events in real-time.

## All Endpoints
GET    /api/projects              — List all projects
POST   /api/projects              — Add a project
DELETE /api/projects/:id          — Remove a project
GET    /api/sessions              — List all sessions
POST   /api/sessions              — Create a new session
DELETE /api/sessions/:id          — Kill a session
GET    /api/sessions/:id/state    — Get session state
GET    /api/sessions/:id/display  — Rendered output + state (polling)
POST   /api/sessions/:id/execute  — Send input, get output
POST   /api/sessions/:id/cancel   — Cancel stuck execute
GET    /api/agent/capabilities    — Full API spec (self-describing)
GET    /api/context               — Concise session summary (low tokens)
WS     /api/sessions/:id/agent    — Real-time agent WebSocket

## Example Agent Loop (JavaScript)

const BASE = "${baseUrl}/api";

// 1. Read capabilities first (important!)
const caps = await fetch(\`\${BASE}/agent/capabilities\`).then(r => r.json());

// 2. Create session
const { session } = await fetch(\`\${BASE}/sessions\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ project_path: "/home/user/myproject", task: "Fix the auth middleware" })
}).then(r => r.json());

// 3. Poll display endpoint for output + state (single call)
let cursor = null;
async function pollDisplay(id) {
  const url = cursor
    ? \`\${BASE}/sessions/\${id}/display?lines=100&since=\${cursor}\`
    : \`\${BASE}/sessions/\${id}/display?lines=100\`;
  const data = await fetch(url).then(r => r.json());
  cursor = data.cursor;
  return data;
}

// 4. Wait for session to be ready, reading output along the way
let display;
while (true) {
  display = await pollDisplay(session.id);
  if (display.output) console.log(display.output);
  if (display.processState !== "busy") break;
  await new Promise(r => setTimeout(r, 2000));
}

// 5. Interact when session needs input
while (true) {
  if (display.processState === "waiting_for_input" || display.processState === "idle") {
    const input = decideInput(display); // your logic using output + promptType + choices
    const result = await fetch(\`\${BASE}/sessions/\${session.id}/execute\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, timeout: 60000, quiescenceMs: 5000 })
    }).then(r => r.json());
    console.log(result.output);
  }
  await new Promise(r => setTimeout(r, 2000));
  display = await pollDisplay(session.id);
  if (display.output) console.log(display.output);
}
`;
}

function generateContextualGuide(baseUrl: string, projectName: string, projectPath: string, task?: string, additionalInstructions?: string): string {
  const effectiveTask = task?.trim() || 'Start up and ask me what I want you to do and NOTHING ELSE';
  // Build the full task string for the API call: task + additional instructions separated
  const fullTaskForApi = additionalInstructions
    ? `${effectiveTask}\n\n---\nAdditional Instructions:\n${additionalInstructions}`
    : effectiveTask;

  const instructionsSection = additionalInstructions
    ? `\n## Additional Instructions\n${additionalInstructions}\n`
    : '';

  return `# HiveCommand Agent Command — ${projectName}

## Project Details
- **Project:** ${projectName}
- **Path:** ${projectPath}
- **Task:** ${effectiveTask}
- **Base URL:** ${baseUrl}
${instructionsSection}
## FIRST: Read Capabilities
ALWAYS read this before doing anything else:
GET ${baseUrl}/api/agent/capabilities

## Quick Start

1. Create a session for this project:
   POST ${baseUrl}/api/sessions
   Content-Type: application/json
   {"project_path": "${projectPath}", "task": ${JSON.stringify(fullTaskForApi)}}

2. Poll for output + state (single call, no side effects):
   GET ${baseUrl}/api/sessions/:id/display?lines=100
   Returns: { sessionId, processState, promptType, choices, output: "rendered text", cursor: 1234, truncated: false }

3. Poll incrementally — pass cursor from previous response to only get new content:
   GET ${baseUrl}/api/sessions/:id/display?lines=100&since=1234

4. Send input when the session needs it (processState is "idle" or "waiting_for_input"):
   POST ${baseUrl}/api/sessions/:id/execute
   Content-Type: application/json
   {"input": "your response or command", "timeout": 60000, "quiescenceMs": 5000}

5. Repeat steps 2-4 until the task is complete.

## Critical Rules
- ALWAYS read /api/agent/capabilities first before doing anything else.
- Use GET /api/sessions/:id/display for read-only monitoring — output + state in one call with cursor-based incremental polling.
- Use POST /api/sessions/:id/execute to send input and get the response.
- NEVER send empty strings (""), whitespace (" "), or newlines ("\\n") as input — they produce no output. Always send meaningful text.
- NEVER read PTY output directly, scrape temp files, or parse raw terminal data.
- Check processState before sending input — if "busy", wait.
- When promptType is "choice", use the choices array to pick the right option number.
- Use timeout: 60000 and quiescenceMs: 5000 for hive-mind sessions (they are slower than raw Claude Code).

## Reading Output (Display vs Execute)
GET /sessions/:id/display — Read-only. Returns the last N lines of rendered terminal text plus inline state. Use the cursor value for incremental polling. This is the RECOMMENDED way to monitor what a session is doing.
POST /sessions/:id/execute — Send input and get output. Only returns NEW output generated AFTER your input. Use this when you need to interact, not just observe.

## All Endpoints
GET    /api/projects              — List all projects
POST   /api/projects              — Add a project
DELETE /api/projects/:id          — Remove a project
GET    /api/sessions              — List all sessions
POST   /api/sessions              — Create a new session
DELETE /api/sessions/:id          — Kill a session
GET    /api/sessions/:id/state    — Get session state
GET    /api/sessions/:id/display  — Rendered output + state (polling)
POST   /api/sessions/:id/execute  — Send input, get output
POST   /api/sessions/:id/cancel   — Cancel stuck execute
GET    /api/agent/capabilities    — Full API spec (self-describing)
GET    /api/context               — Concise session summary (low tokens)
WS     /api/sessions/:id/agent    — Real-time agent WebSocket
`;
}

function EndpointRow({ method, path, desc }: { method: string; path: string; desc: string }) {
  const methodColor = method === 'POST' ? 'var(--success)' :
    method === 'DELETE' ? 'var(--error)' :
    method === 'WS' ? 'var(--accent)' : 'var(--text-secondary)';

  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="w-12 text-right font-bold shrink-0" style={{ color: methodColor }}>{method}</span>
      <span style={{ color: 'var(--text-primary)' }}>{path}</span>
      <span className="text-[10px] ml-auto" style={{ color: 'var(--text-secondary)' }}>{desc}</span>
    </div>
  );
}
