// Estaleiro como aplicação: a janela e a pasta de dados. O resto está em core.js. A app não tem modelo próprio: os
// agentes correm na linha de comandos que o utilizador já tem neste computador (Claude CLI, Copilot CLI).
// (Sem janela: `npm run web` abre a mesma interface no browser, ver web.js.)
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell: electronShell } = require('electron');
const core = require('./core');

const APP_DIR = path.join(__dirname, '..');
// Portátil: a pasta data fica ao lado do exe; em desenvolvimento é a do projeto
// O .exe portátil descompacta a app numa pasta temporária e apaga-a quando a app fecha: a pasta data tem de ficar ao
// lado do .exe verdadeiro, que o lançador indica em PORTABLE_EXECUTABLE_DIR (e não ao lado do programa que corre)
const EXE_DIR = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
const DATA_ENV = process.env.BEEKEEPER_DATA || process.env.ESTALEIRO_DATA; // ESTALEIRO_DATA: o nome antigo, continua a valer
const DATA_DIR = DATA_ENV ? path.resolve(DATA_ENV) : app.isPackaged ? path.join(EXE_DIR, 'data') : path.join(APP_DIR, 'data');
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
    title: 'Beekeeper',
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
