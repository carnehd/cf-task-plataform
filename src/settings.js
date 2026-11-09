// Definições da plataforma, em data/settings.json: a pasta raiz onde estão todos os microserviços, e o CLI que corre
// todos os agentes (Claude Code ou Copilot CLI), escolhido no topo da página.
// É a partir dela que correm os agentes: cada microserviço é uma subpasta, e um agente que lê um vê os outros ao lado.
const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./store');

const file = (dataDir) => path.join(dataDir, 'settings.json');
const read = (dataDir) => readJson(file(dataDir), {});

// A pasta raiz, quando está definida e ainda existe; senão ''
function rootDir(dataDir) {
  const root = read(dataDir).rootDir;
  try {
    return root && fs.statSync(root).isDirectory() ? root : '';
  } catch {
    return '';
  }
}

function setRoot(dataDir, folder) {
  const root = path.resolve(String(folder || '').trim());
  if (!String(folder || '').trim()) throw new Error('Indica a pasta onde estão os microserviços');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Essa pasta não existe: ${root}`);
  if (path.parse(root).root === root) throw new Error('Essa é a raiz do disco. Escolhe a pasta que tem os microserviços, por exemplo C:\\Projetos');
  writeJson(file(dataDir), { ...read(dataDir), rootDir: root });
  return root;
}

const CLIS = ['claude', 'copilot'];
// O CLI que corre os agentes: o escolhido, ou '' enquanto ninguém escolheu (a app escolhe o que está instalado)
const cli = (dataDir) => {
  const v = read(dataDir).cli;
  return CLIS.includes(v) ? v : '';
};
function setCli(dataDir, value) {
  if (!CLIS.includes(value)) throw new Error('CLI desconhecido');
  writeJson(file(dataDir), { ...read(dataDir), cli: value });
  return value;
}

function register(ipcMain, { dataDir, dialog, getWindow }) {
  const guard = (fn) => async (_, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  };
  ipcMain.handle('settings:get', guard(() => ({ rootDir: read(dataDir).rootDir || '', rootExists: Boolean(rootDir(dataDir)) })));
  ipcMain.handle('settings:set-root', guard((folder) => ({ rootDir: setRoot(dataDir, folder) })));
  ipcMain.handle('settings:set-cli', guard((value) => ({ cli: setCli(dataDir, String(value || '')) })));
  ipcMain.handle('settings:pick-root', guard(async () => {
    const r = await dialog.showOpenDialog(getWindow(), { title: 'Pasta raiz dos microserviços', properties: ['openDirectory'] });
    return { folder: r.canceled ? null : r.filePaths[0] };
  }));
}

module.exports = { register, rootDir, setRoot, cli, setCli };
