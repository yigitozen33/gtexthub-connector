/**
 * Electron main process: single instance, tray, window, IPC, auto-start.
 * The connector itself (pairing, heartbeat, poll, sends) lives in core and is
 * driven by ConnectorController.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, safeStorage, shell } from 'electron';
import { API_BASES, defaultDeviceName, detectPlatform, resolveApiBase } from '../core/config';
import { Redactor } from '../core/logger';
import { IPC, type ActionResult, type UiState } from '../shared/ipc';
import { ConnectorController } from './controller';
import { FileLogger } from './logger';

declare const __GTH_ENV__: string;
declare const __GTH_API_BASE__: string;

const isDev = !app.isPackaged;
const APP_TITLE = 'GTextHub Bağlayıcı';

if (isDev) {
  // Keep development data apart from an installed copy (GTH_USER_DATA points it elsewhere).
  app.setPath('userData', process.env.GTH_USER_DATA || path.join(app.getPath('appData'), `${APP_TITLE} (dev)`));
}
fs.mkdirSync(app.getPath('userData'), { recursive: true });

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const userData = app.getPath('userData');
const redactor = new Redactor();
const logger = new FileLogger(path.join(userData, 'logs'), redactor, isDev);

process.on('uncaughtException', (err) => logger.error('uncaughtException', { error: err }));
process.on('unhandledRejection', (err) => logger.error('unhandledRejection', { error: String(err) }));

/** Build-time API base, overridable in development only (env GTH_API_BASE or dev-config.json). */
function apiBase(): string {
  const buildDefault = typeof __GTH_API_BASE__ === 'string' && __GTH_API_BASE__ ? __GTH_API_BASE__ : API_BASES.preview;
  if (!isDev) return resolveApiBase(buildDefault);
  let override = process.env.GTH_API_BASE ?? null;
  if (!override) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'dev-config.json'), 'utf8')) as {
        apiBase?: string;
      };
      override = cfg.apiBase ?? null;
    } catch {
      override = null;
    }
  }
  return resolveApiBase(buildDefault, override);
}

function startedHidden(): boolean {
  if (process.argv.includes('--hidden')) return true;
  if (process.platform === 'darwin') {
    try {
      return app.getLoginItemSettings().wasOpenedAtLogin === true;
    } catch {
      return false;
    }
  }
  return false;
}

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let quitting = false;
let controller: ConnectorController;

function assetPath(name: string): string {
  return isDev ? path.join(app.getAppPath(), 'assets', name) : path.join(process.resourcesPath, 'assets', name);
}

function trayImage(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(assetPath('trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(assetPath('tray.png'));
}

function setDockVisible(visible: boolean): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  if (visible) void app.dock.show();
  else app.dock.hide();
}

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow();
  setDockVisible(true);
  win!.show();
  win!.focus();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 480,
    height: 680,
    minWidth: 400,
    minHeight: 520,
    show: false,
    title: APP_TITLE,
    backgroundColor: '#f6f3fc',
    autoHideMenuBar: true,
    icon: process.platform === 'win32' ? assetPath('icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('preload-error', (_e, preloadPath, error) =>
    logger.error('preload error', { preload: path.basename(preloadPath), error: String(error) }),
  );
  win.webContents.on('render-process-gone', (_e, details) => logger.error('renderer gone', { reason: details.reason }));
  win.webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') {
      logger.warn('renderer console', { level: details.level, message: details.message });
    }
  });
  win.webContents.on('did-finish-load', () => logger.debug('window loaded'));
  win.on('close', (e) => {
    if (!quitting) {
      // Closing keeps the app running in the tray.
      e.preventDefault();
      win?.hide();
      setDockVisible(false);
    }
  });
  win.on('closed', () => {
    win = null;
  });
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function getAutoStart(): boolean {
  try {
    return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin === true;
  } catch {
    return false;
  }
}

function applyAutoStart(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    logger.info('auto-start changed', { enabled });
  } catch (err) {
    logger.warn('auto-start change failed', { error: String(err) });
  }
}

function refreshTray(state: UiState): void {
  if (!tray) return;
  const paired = state.connection !== 'unpaired';
  tray.setToolTip(`${APP_TITLE}: ${state.statusLabel}${state.paused && paired ? ' (gönderim duraklatıldı)' : ''}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Durum: ${state.statusLabel}`, enabled: false },
      ...(state.paused && paired ? [{ label: 'Gönderim duraklatıldı', enabled: false }] : []),
      { type: 'separator' },
      { label: 'Pencereyi aç', click: () => showWindow() },
      {
        label: state.paused ? 'Gönderimi sürdür' : 'Gönderimi duraklat',
        enabled: paired,
        click: () => void controller.setPaused(!state.paused),
      },
      {
        label: 'Bilgisayar açılınca başlat',
        type: 'checkbox',
        checked: state.autoStart,
        click: (item) => void controller.setAutoStart(item.checked),
      },
      { type: 'separator' },
      {
        label: 'Çıkış',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function registerIpc(): void {
  const guard =
    <A extends unknown[]>(fn: (...args: A) => Promise<ActionResult>) =>
    async (_e: Electron.IpcMainInvokeEvent, ...args: A): Promise<ActionResult> => {
      try {
        return await fn(...args);
      } catch (err) {
        logger.error('ipc handler failed', { error: String(err) });
        return { ok: false, message: 'Beklenmeyen bir hata oluştu.' };
      }
    };
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

  ipcMain.handle(IPC.getState, () => controller.state());
  ipcMain.handle(IPC.pair, guard((code: unknown, name: unknown) => controller.pair(str(code, 64), str(name, 64))));
  ipcMain.handle(IPC.unpair, guard(() => controller.unpair()));
  ipcMain.handle(IPC.addAccount, guard((token: unknown) => controller.addAccount(str(token, 500))));
  ipcMain.handle(IPC.removeAccount, guard((id: unknown) => controller.removeAccount(str(id, 32))));
  ipcMain.handle(IPC.setPaused, guard((p: unknown) => controller.setPaused(p === true)));
  ipcMain.handle(IPC.setAutoStart, guard((v: unknown) => controller.setAutoStart(v === true)));
}

app.on('second-instance', () => showWindow());
app.on('window-all-closed', () => {
  // Stay in the tray.
});
app.on('before-quit', () => {
  quitting = true;
  controller?.shutdown();
});
app.on('activate', () => showWindow());

void app.whenReady().then(async () => {
  const environment = typeof __GTH_ENV__ === 'string' ? __GTH_ENV__ : 'preview';
  controller = new ConnectorController({
    dataDir: userData,
    encryptor: {
      isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptStringAsync(plain),
      decrypt: (buf) => safeStorage.decryptStringAsync(buf),
    },
    logger,
    redactor,
    apiBase: apiBase(),
    platform: detectPlatform(),
    defaultDeviceName: defaultDeviceName(),
    version: app.getVersion(),
    environment,
    getAutoStart,
    applyAutoStart,
  });
  registerIpc();
  await controller.init();

  tray = new Tray(trayImage());
  tray.on('click', () => {
    if (process.platform !== 'darwin') showWindow();
  });
  refreshTray(controller.state());
  controller.on('change', (state: UiState) => {
    refreshTray(state);
    if (win && !win.isDestroyed()) win.webContents.send(IPC.stateChanged, state);
  });

  const hidden = startedHidden() && controller.isPaired;
  if (hidden) setDockVisible(false);
  else showWindow();
});
