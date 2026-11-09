// Estaleiro como aplicação: a janela e a pasta de dados. O resto está em core.js. A app não tem modelo próprio: os
// agentes correm na linha de comandos que o utilizador já tem neste computador (Claude CLI, Copilot CLI).
// (Sem janela: `npm run web` abre a mesma interface no browser, ver web.js.)
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell: electronShell } = require('electron');
const core = require('./core');

const APP_DIR = path.join(__dirname, '..');
// Portátil: a pasta data fica ao lado do exe; em desenvolvimento é a do projeto
const DATA_DIR = process.env.ESTALEIRO_DATA ? path.resolve(process.env.ESTALEIRO_DATA) : app.isPackaged ? path.join(path.dirname(process.execPath), 'data') : path.join(APP_DIR, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', path.join(DATA_DIR, 'electron'));

let win = null;
const getWindow = () => win;
const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function createWindow() {
  nativeTheme.themeSource = 'light';
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Estaleiro',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  core.registerAll(ipcMain, { dataDir: DATA_DIR, appDir: APP_DIR, send, getWindow, dialog, version: app.getVersion(), mode: 'app', openPath: (p) => electronShell.openPath(p), revealPath: async (p) => { electronShell.showItemInFolder(p); return ''; } });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => core.stopAll());
