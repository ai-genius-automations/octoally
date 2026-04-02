import {
  app,
  Tray,
  Menu,
  nativeImage,
  MenuItemConstructorOptions,
} from 'electron';
import * as path from 'path';
import {
  isServerRunning,
  isServerReachable,
  startServer,
  stopServer,
  stopServerOnPort,
  isServiceInstalled,
  toggleService,
  waitForServer,
} from './server-manager';

let tray: Tray | null = null;

interface TrayOptions {
  cliPath: string;
  showWindow: () => void;
}

export function createTray(opts: TrayOptions): Tray {
  // Destroy existing tray to prevent duplicates on relaunch
  if (tray) {
    tray.destroy();
    tray = null;
  }

  // Resolve icon path — try development location first, then packaged
  const iconPaths = [
    path.join(__dirname, '..', 'icons', 'tray-icon.png'),
    path.join(process.resourcesPath || '', 'icons', 'tray-icon.png'),
  ];

  let icon = nativeImage.createEmpty();
  for (const p of iconPaths) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        icon = img.resize({ width: 32, height: 32 });
        break;
      }
    } catch {}
  }

  tray = new Tray(icon);
  tray.setToolTip('OctoAlly');

  // Build initial menu (async — will set when ready)
  refreshMenu(opts);

  tray.on('click', () => {
    opts.showWindow();
  });

  // Refresh menu on right-click so status is always current when displayed
  tray.on('right-click', () => {
    refreshMenu(opts);
  });

  return tray;
}

async function refreshMenu(opts: TrayOptions) {
  if (!tray) return;

  let reachable = false;
  let cliManaged = false;
  let serviceInstalled = false;
  try {
    reachable = await isServerReachable();
    cliManaged = isServerRunning(opts.cliPath);
    serviceInstalled = isServiceInstalled();
  } catch (err) {
    console.warn('[OctoAlly] Tray menu status check failed:', err);
  }

  let statusLabel = 'Status: Stopped';
  if (reachable && cliManaged) {
    statusLabel = 'Status: Running';
  } else if (reachable && !cliManaged) {
    statusLabel = 'Status: Running (external)';
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Open Dashboard',
      click: () => opts.showWindow(),
    },
    {
      label: statusLabel,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Start Server',
      enabled: !reachable,
      click: async () => {
        await startServer(opts.cliPath);
        await waitForServer(10000);
        refreshMenu(opts);
      },
    },
    {
      label: 'Stop Server',
      enabled: reachable,
      click: async () => {
        if (cliManaged) {
          await stopServer(opts.cliPath);
        } else {
          await stopServerOnPort();
        }
        refreshMenu(opts);
      },
    },
    { type: 'separator' },
    {
      label: serviceInstalled
        ? 'Uninstall Service (auto-start)'
        : 'Install Service (auto-start)',
      click: async () => {
        await toggleService(opts.cliPath);
        refreshMenu(opts);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: async () => {
        if (!isServiceInstalled()) {
          if (cliManaged) {
            console.log('[OctoAlly] Stopping CLI-managed server on quit...');
            await stopServer(opts.cliPath);
          } else if (reachable) {
            console.log('[OctoAlly] Stopping external server on quit...');
            await stopServerOnPort();
          }
        }
        app.exit(0);
      },
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
}

export async function updateTrayMenu(opts: TrayOptions) {
  await refreshMenu(opts);
}

export function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
