import { app, BrowserWindow, Menu, shell, ipcMain, session } from 'electron';
import * as path from 'path';
import { resolveCliPath, isServerReachable, startServer, waitForServer } from './server-manager';
import { createTray } from './tray';
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
    title: 'HiveCommand',
    icon: path.join(__dirname, '..', 'icons', '128x128.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Security: disable nodeIntegration, enable context isolation
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
  });

  // Handle external links — open in system browser instead of Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost:42010')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Intercept navigation to external URLs
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
    console.error(`[HiveCommand] Renderer process gone: ${details.reason}`);
    if (details.reason !== 'clean-exit') {
      setTimeout(() => mainWindow?.webContents.reload(), 500);
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[HiveCommand] Window became unresponsive, reloading...');
    setTimeout(() => mainWindow?.webContents.reload(), 1000);
  });

  // Close-to-tray: hide window instead of quitting
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
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
});

app.whenReady().then(async () => {
  // Register IPC handlers
  ipcMain.handle('get-version', () => app.getVersion());
  ipcMain.handle('app-quit', () => app.exit(0));
  registerSpeechHandlers();

  // Start server if port 42010 is not reachable (regardless of PID file state)
  let reachable = await isServerReachable();
  if (!reachable) {
    console.log('[HiveCommand] Server not reachable, starting...');
    const started = await startServer(cliPath);
    if (started) {
      console.log('[HiveCommand] Server started, waiting for it to become reachable...');
      reachable = await waitForServer();
      if (reachable) {
        console.log('[HiveCommand] Server is now reachable');
      } else {
        console.warn('[HiveCommand] Server started but not reachable after 10s');
      }
    } else {
      console.warn('[HiveCommand] Failed to start server');
    }
  } else {
    console.log('[HiveCommand] Server already reachable on port 42010');
  }

  createWindow();
  createTray({ cliPath, showWindow });

  // Grant permissions for webview sessions (WebAuthn, notifications, etc.)
  const webpageSession = session.fromPartition('persist:webpages');
  webpageSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(true); // Be permissive — this is the user's chosen page
  });
  webpageSession.setPermissionCheckHandler(() => true);

  // Strip "Electron" from webview session User-Agent so Google doesn't block OAuth.
  // Also strip the app name (hivecommand-desktop) to look like a normal browser.
  const defaultUA = webpageSession.getUserAgent();
  const cleanUA = defaultUA
    .replace(/\s*Electron\/\S+/g, '')
    .replace(/\s*hivecommand-desktop\/\S+/g, '');
  webpageSession.setUserAgent(cleanUA);

  // Fix: Electron webview ERR_FAILED on OAuth callback URLs with large hash fragments.
  //
  // Root cause: Electron's webview GUEST_VIEW_MANAGER can't handle URLs with large
  // hash fragments (>1KB). Supabase implicit OAuth returns tokens via hash fragment.
  //
  // Solution: Intercept OAuth navigation in the webview and open it in a popup
  // BrowserWindow instead. BrowserWindow uses a regular renderer (no GUEST_VIEW_MANAGER)
  // so it can handle the full callback URL with hash. Both share the same session
  // partition ('persist:webpages') so the session cookie set by the SPA's backend
  // is available to the webview after the popup completes the OAuth flow.

  // Webview setup: intercept OAuth navigations, open in popup BrowserWindow
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') {
      // Set dark background to prevent white flash during SPA page transitions.
      // This is the color Chromium shows between page paints.
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

      // Intercept OAuth navigation: open in a popup BrowserWindow instead of webview
      contents.on('will-navigate', (event, url) => {
        // Detect Supabase OAuth authorize URLs
        if (url.includes('/auth/v1/authorize')) {
          event.preventDefault();
          console.log('[WebView Auth] Intercepted OAuth navigation, opening in popup window...');

          // Track the origin of the app that initiated OAuth
          let appOrigin = '';
          let authUrl = url;
          try {
            const parsed = new URL(url);
            const redirectTo = parsed.searchParams.get('redirect_to') || '';
            if (redirectTo) {
              const redirectParsed = new URL(redirectTo);
              appOrigin = redirectParsed.origin;
            }
            // Force Google account picker by adding prompt=select_account
            if (!parsed.searchParams.has('prompt')) {
              parsed.searchParams.set('prompt', 'select_account');
              authUrl = parsed.toString();
            }
          } catch {}

          const authWindow = new BrowserWindow({
            width: 600,
            height: 700,
            parent: mainWindow || undefined,
            modal: true,
            title: 'Sign In',
            webPreferences: {
              partition: 'persist:webpages',
              nodeIntegration: false,
              contextIsolation: true,
            },
          });

          authWindow.loadURL(authUrl);

          let callbackReached = false;
          let authDone = false;

          const finishAuth = (navUrl: string) => {
            if (authDone) return;
            authDone = true;
            console.log(`[WebView Auth] OAuth flow complete, SPA navigated to: ${navUrl}`);
            console.log('[WebView Auth] Closing popup, reloading webview...');
            authWindow.close();
            // Reload the webview — the session cookie is shared via the partition
            // so the SPA's AuthContext will detect the valid session
            contents.loadURL(appOrigin || contents.getURL());
          };

          const checkNav = (_ev: any, navUrl: string) => {
            if (navUrl.includes('/auth/callback')) {
              callbackReached = true;
              return;
            }
            // After callback, any same-origin navigation means OAuth is done
            if (callbackReached && appOrigin && navUrl.startsWith(appOrigin)) {
              finishAuth(navUrl);
            }
          };

          // did-navigate: fires for full page navigations
          authWindow.webContents.on('did-navigate', checkNav);
          // did-navigate-in-page: fires for pushState/replaceState (React Router)
          authWindow.webContents.on('did-navigate-in-page', checkNav);

          // Handle the case where the user closes the popup manually
          authWindow.on('closed', () => {
            if (callbackReached && !authDone) {
              authDone = true;
              contents.loadURL(appOrigin || contents.getURL());
            }
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
