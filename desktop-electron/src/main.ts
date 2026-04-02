import { app, BrowserWindow, Menu, shell, ipcMain, session, globalShortcut, dialog } from 'electron';
import * as path from 'path';
import * as http from 'http';
import { resolveCliPath, isServerReachable, startServer, waitForServer } from './server-manager';
import { createTray, destroyTray } from './tray';
import { registerSpeechHandlers } from './speech';

let mainWindow: BrowserWindow | null = null;
const cliPath = resolveCliPath();

function createWindow() {
  // Remove default menu bar (File/Edit/View/Window/Help)
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'OctoAlly',
    icon: path.join(__dirname, '..', 'icons', '128x128.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Security: disable nodeIntegration, enable context isolation
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
  });

  // Handle external links — open in system browser instead of Electron.
  // xterm.js / Claude Code open links via window.open() with no URL first,
  // then set .location.href on the child window. We intercept the child
  // window's navigation to catch the actual URL and open it externally.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost:42010')) {
      return { action: 'allow' };
    }
    // about:blank = xterm.js/Claude Code link pattern — allow window creation
    // so we can intercept the subsequent .location.href navigation
    if (!url || url === 'about:blank') {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Watch for child windows created by window.open('about:blank') — when they
  // navigate to the real URL, open it externally and close the child window
  mainWindow.webContents.on('did-create-window', (childWindow) => {
    let handled = false;
    const openAndClose = (url: string) => {
      if (handled) return;
      handled = true;
      shell.openExternal(url);
      setImmediate(() => childWindow.close());
    };
    childWindow.webContents.on('will-navigate', (event, url) => {
      if (url && url !== 'about:blank' && (url.startsWith('http://') || url.startsWith('https://'))) {
        event.preventDefault();
        openAndClose(url);
      }
    });
    childWindow.webContents.on('did-start-navigation', (_event, url) => {
      if (url && url !== 'about:blank' && (url.startsWith('http://') || url.startsWith('https://'))) {
        openAndClose(url);
      }
    });
  });

  // Intercept navigation to external URLs in the main window
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost:42010')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // In dev mode, load from Vite dev server; in production, load from the server
  const isDev = !!process.env.ELECTRON_ENABLE_LOGGING;
  mainWindow.loadURL(isDev ? 'http://localhost:42011' : 'http://localhost:42010');

  // Recover from renderer crashes — reload the page instead of showing a blank window
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[OctoAlly] Renderer process gone: ${details.reason}`);
    if (details.reason !== 'clean-exit') {
      setTimeout(() => mainWindow?.webContents.reload(), 500);
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[OctoAlly] Window became unresponsive, reloading...');
    setTimeout(() => mainWindow?.webContents.reload(), 1000);
  });

  // Keyboard shortcuts (menu bar is hidden)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // F12 / Ctrl+Shift+I (Linux/Win) / Cmd+Opt+I (macOS): DevTools
    if (input.key === 'F12' || ((input.control || input.meta) && input.shift && input.key === 'I') || (input.meta && input.alt && input.key === 'I')) {
      mainWindow?.webContents.toggleDevTools();
    }
    // F5 / Cmd+R (macOS): refresh
    if (input.type === 'keyDown' && (
      (input.key === 'F5' && !input.control && !input.shift) ||
      (input.meta && !input.shift && input.key.toLowerCase() === 'r')
    )) {
      event.preventDefault();
      mainWindow?.webContents.reload();
    }
    // Ctrl+Shift+R (Linux/Win) / Cmd+Shift+R (macOS): hard refresh (bypass cache)
    if (input.key.toLowerCase() === 'r' && (input.control || input.meta) && input.shift && input.type === 'keyDown') {
      event.preventDefault();
      mainWindow?.webContents.reloadIgnoringCache();
    }
    // Handle paste at the Electron level — synthetic keystrokes from text
    // expanders (espanso/xdotool/TextExpander) don't trigger browser paste events,
    // and navigator.clipboard.readText() rejects without a real user gesture.
    // webContents.paste() fires a proper ClipboardEvent on the focused element.
    // Linux: Ctrl+Shift+V, macOS: Cmd+V
    const isPaste = input.type === 'keyDown' && input.key.toLowerCase() === 'v' && (
      (input.control && input.shift) ||  // Linux: Ctrl+Shift+V
      (input.meta && !input.shift)       // macOS: Cmd+V
    );
    if (isPaste) {
      event.preventDefault();
      mainWindow?.webContents.paste();
    }
  });

  // On close: ask user whether to minimize to tray or quit
  mainWindow.on('close', (event) => {
    if ((app as any).isQuitting) {
      // Force quit after 2s if renderer doesn't cooperate
      setTimeout(() => app.exit(0), 2000);
      return;
    }

    event.preventDefault();

    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'question',
      buttons: ['Minimize to Tray', 'Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'OctoAlly',
      message: 'What would you like to do?',
      detail: 'Minimize to tray keeps the server running in the background.',
    });

    if (choice === 0) {
      // Minimize to tray
      mainWindow?.hide();
    } else if (choice === 1) {
      // Quit
      (app as any).isQuitting = true;
      app.quit();
    }
    // choice === 2 (Cancel): do nothing
  });
}

function showWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
}

// Extend app with custom property for quit tracking
(app as any).isQuitting = false;
app.on('before-quit', () => {
  (app as any).isQuitting = true;
  destroyTray();
});

app.whenReady().then(async () => {
  // Register IPC handlers
  ipcMain.handle('get-version', () => app.getVersion());
  ipcMain.handle('app-quit', () => app.exit(0));
  ipcMain.handle('open-external', (_event, url: string) => {
    if (url && typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      shell.openExternal(url);
    }
  });
  registerSpeechHandlers();

  // Start server if port 42010 is not reachable (regardless of PID file state)
  let reachable = await isServerReachable();
  if (!reachable) {
    console.log('[OctoAlly] Server not reachable, starting...');
    const started = await startServer(cliPath);
    if (started) {
      console.log('[OctoAlly] Server started, waiting for it to become reachable...');
      reachable = await waitForServer();
      if (reachable) {
        console.log('[OctoAlly] Server is now reachable');
      } else {
        console.warn('[OctoAlly] Server started but not reachable after 10s');
      }
    } else {
      console.warn('[OctoAlly] Failed to start server');
    }
  } else {
    console.log('[OctoAlly] Server already reachable on port 42010');
  }

  createWindow();
  createTray({ cliPath, showWindow });

  // Watch for server death and auto-restart it (handles /api/restart and crashes)
  let serverWatchdog: ReturnType<typeof setInterval> | null = null;
  let restarting = false;
  serverWatchdog = setInterval(async () => {
    if (restarting) return;
    const alive = await isServerReachable();
    if (!alive) {
      restarting = true;
      console.log('[OctoAlly] Server not reachable, restarting...');
      await startServer(cliPath);
      const ok = await waitForServer(15000);
      if (ok) {
        console.log('[OctoAlly] Server restarted successfully');
        mainWindow?.webContents.reload();
      } else {
        console.warn('[OctoAlly] Server failed to restart');
      }
      restarting = false;
    }
  }, 3000);

  app.on('before-quit', () => {
    if (serverWatchdog) clearInterval(serverWatchdog);
  });

  // Grant permissions for webview sessions (WebAuthn, notifications, etc.)
  const webpageSession = session.fromPartition('persist:webpages');
  webpageSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(true); // Be permissive — this is the user's chosen page
  });
  webpageSession.setPermissionCheckHandler(() => true);

  // Strip "Electron" and app name from webview session User-Agent.
  const defaultUA = webpageSession.getUserAgent();
  const cleanUA = defaultUA
    .replace(/\s*Electron\/\S+/g, '')
    .replace(/\s*octoally-desktop\/\S+/g, '');
  webpageSession.setUserAgent(cleanUA);

  // OAuth flow: Google blocks ALL embedded browsers (Electron BrowserWindow, webview,
  // etc.) regardless of UA/Client-Hints/CDP spoofing. The only reliable approach is
  // shell.openExternal() to open OAuth in the user's real system browser.
  //
  // Token bridge: Start a temporary localhost HTTP server. Rewrite redirect_to to point
  // to it. After OAuth completes, Supabase redirects to our server with tokens in the
  // hash fragment. Our server serves a small page that reads the hash via JS and POSTs
  // the tokens back. We then inject the tokens into the webview's Supabase session.

  // Webview setup: intercept OAuth navigations, open in system browser
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') {
      // Set dark background to prevent white flash during SPA page transitions.
      contents.setBackgroundThrottling(false);
      contents.on('dom-ready', () => {
        try {
          contents.setBackgroundColor('#0f1117');
        } catch {}
      });

      // Handle window.open() — navigate the webview instead of opening a popup
      contents.setWindowOpenHandler(({ url }) => {
        contents.loadURL(url);
        return { action: 'deny' };
      });

      // Intercept OAuth navigation: open in system browser with token bridge
      contents.on('will-navigate', (event, url) => {
        if (url.includes('/auth/v1/authorize')) {
          event.preventDefault();
          console.log('[WebView Auth] Intercepted OAuth, opening in system browser...');

          let appOrigin = '';
          let originalRedirectTo = '';
          try {
            const parsed = new URL(url);
            const redirectTo = parsed.searchParams.get('redirect_to') || '';
            if (redirectTo) {
              originalRedirectTo = redirectTo;
              appOrigin = new URL(redirectTo).origin;
            }
          } catch {}

          // Start a temporary HTTP server to catch the OAuth callback tokens
          const tokenServer = http.createServer((req, res) => {
            // CORS headers for the POST from our own page
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
              res.writeHead(204);
              res.end();
              return;
            }

            if (req.url === '/auth-callback') {
              // Serve a page that extracts tokens from the hash and sends them back
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`<!DOCTYPE html>
<html><head><title>Sign-in Complete</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; display: flex;
    justify-content: center; align-items: center; height: 100vh;
    background: #0f1117; color: #e4e8f1; }
  .card { text-align: center; padding: 2rem 2.5rem; border-radius: 10px;
    background: #1a1d27; border: 1px solid #2e3340;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4); min-width: 300px; }
  .logo-wrap { margin-bottom: 0.2rem; }
  .logo-wrap img { height: 60px; }
  .logo-fallback { font-size: 0.8rem; font-weight: 700; letter-spacing: 0.05em; color: #e4e8f1; }
  .divider { height: 1px; background: #2e3340; margin: 1.25rem 0; }
  .label { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em;
    text-transform: uppercase; color: #8b92a8; margin-bottom: 0; }
  h2 { font-size: 1.05rem; font-weight: 600; color: #e4e8f1; margin-bottom: 0.4rem; }
  p { font-size: 0.82rem; color: #8b92a8; line-height: 1.5; }
  .spinner { width: 22px; height: 22px; border: 2px solid #2e3340;
    border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.7s linear infinite;
    margin: 1.2rem auto; }
  .check { width: 40px; height: 40px; border-radius: 50%; background: #1e3a5f;
    display: none; align-items: center; justify-content: center; margin: 1rem auto; }
  .check svg { width: 20px; height: 20px; stroke: #3b82f6; stroke-width: 2.5;
    fill: none; stroke-linecap: round; stroke-linejoin: round; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head>
<body><div class="card">
  <div class="logo-wrap">
    <img src="http://localhost:42010/octoally-logo.png" alt="OctoAlly"
         onerror="this.style.display='none';document.querySelector('.logo-fallback').style.display='inline'">
    <span class="logo-fallback" style="display:none">OctoAlly</span>
  </div>
  <div class="label">OAuth Connector</div>
  <div class="divider"></div>
  <div class="spinner" id="spinner"></div>
  <div class="check" id="check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
  <h2 id="title">Signing in...</h2>
  <p id="msg">Returning your session to the app.</p>
</div>
<script>
  const hash = window.location.hash.substring(1);
  if (hash) {
    const params = Object.fromEntries(new URLSearchParams(hash));
    fetch('/receive-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    }).then(() => {
      document.getElementById('spinner').style.display = 'none';
      document.getElementById('check').style.display = 'flex';
      document.getElementById('title').textContent = 'Signed in!';
      document.getElementById('msg').textContent = 'You can close this tab and return to OctoAlly.';
    });
  } else {
    document.getElementById('spinner').style.display = 'none';
    document.getElementById('title').textContent = 'Sign-in failed';
    document.getElementById('msg').textContent = 'No session data received. Please try again.';
  }
</script></body></html>`);
              return;
            }

            if (req.url === '/receive-token' && req.method === 'POST') {
              let body = '';
              req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
              req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');

                try {
                  const tokens = JSON.parse(body);
                  const accessToken = tokens.access_token || '';
                  const refreshToken = tokens.refresh_token || '';
                  const expiresIn = tokens.expires_in || '3600';
                  const tokenType = tokens.token_type || 'bearer';

                  if (accessToken) {
                    console.log('[WebView Auth] Received tokens, forwarding to webview...');
                    // Build the hash fragment with all token params
                    const hashParams = new URLSearchParams();
                    hashParams.set('access_token', accessToken);
                    hashParams.set('refresh_token', refreshToken);
                    hashParams.set('expires_in', expiresIn);
                    hashParams.set('token_type', tokenType);
                    if (tokens.provider_token) hashParams.set('provider_token', tokens.provider_token);
                    if (tokens.provider_refresh_token) hashParams.set('provider_refresh_token', tokens.provider_refresh_token);

                    // Navigate webview to the app's original callback URL with tokens
                    // in the hash fragment — this lets the app's own Supabase client
                    // process the tokens through its normal auth callback handler.
                    const callbackUrl = (originalRedirectTo || appOrigin || contents.getURL())
                      + '#' + hashParams.toString();
                    console.log('[WebView Auth] Navigating webview to callback:', callbackUrl.replace(/access_token=[^&]+/, 'access_token=***'));
                    contents.loadURL(callbackUrl);
                  }
                } catch (err) {
                  console.error('[WebView Auth] Failed to process tokens:', err);
                }

                // Shut down the temp server after a short delay
                setTimeout(() => {
                  tokenServer.close();
                  console.log('[WebView Auth] Token bridge server closed');
                }, 2000);
              });
              return;
            }

            // Anything else — 404
            res.writeHead(404);
            res.end('Not found');
          });

          tokenServer.listen(0, '127.0.0.1', () => {
            const port = (tokenServer.address() as any).port;
            console.log(`[WebView Auth] Token bridge server on port ${port}`);

            // Rewrite the OAuth URL to redirect back to our token bridge
            const parsed = new URL(url);
            parsed.searchParams.set('redirect_to', `http://127.0.0.1:${port}/auth-callback`);
            const authUrl = parsed.toString();

            shell.openExternal(authUrl);

            // Auto-cleanup after 5 minutes in case OAuth is abandoned
            setTimeout(() => {
              tokenServer.close();
            }, 5 * 60 * 1000);
          });
        }
      });
    }
  });
});

// macOS: re-create window when dock icon is clicked
app.on('activate', () => {
  if (mainWindow) {
    showWindow();
  } else {
    createWindow();
  }
});

// Don't quit when all windows are closed (tray keeps app alive)
app.on('window-all-closed', () => {
  // No-op — tray keeps the app running
});
