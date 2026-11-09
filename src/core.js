// O que a plataforma faz, sem saber onde a página está: os módulos (agentes, serviços, tarefas) e o que a página
// pergunta à app (versão, o que há neste computador). Quem a arranca dá o que é de cada lado:
//   ipcMain.handle(canal, (evento, ...args) => resposta)   as chamadas da página
//   send(canal, dados)                                       o que a app conta à página
//   dialog.showOpenDialog                                    escolher pastas e ficheiros
//   openPath(caminho)                                        abrir uma pasta no explorador de ficheiros
// A janela Electron (main.js) e o servidor local do browser (web.js) dão cada um os seus.
const shell = require('./shell');
const agents = require('./agents');
const services = require('./services');
const settings = require('./settings');
const tasks = require('./tasks');

function registerAll(ipcMain, ctx) {
  settings.register(ipcMain, ctx);
  agents.register(ipcMain, ctx);
  services.register(ipcMain, ctx);
  tasks.register(ipcMain, ctx);
  ipcMain.handle('app:info', async (_, again) => {
    const fresh = Boolean(again);
    return {
      version: ctx.version,
      dataDir: ctx.dataDir,
      platform: process.platform,
      mode: ctx.mode || 'app',
      // os cinco ao mesmo tempo: cada um é um programa a arrancar (no Windows, o copilot sozinho leva segundos)
      ...(await (async () => {
        const [claude, copilot, docker, podman, git] = await Promise.all(['claude', 'copilot', 'docker', 'podman', 'git'].map((n) => shell.findCli(n, fresh)));
        return { clis: { claude, copilot }, engines: { docker, podman, git } };
      })()),
    };
  });
  ipcMain.handle('app:open-path', async (_, p) => {
    try {
      return { error: (await ctx.openPath(String(p || ''))) || undefined };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  });
}

module.exports = { registerAll, stopAll: tasks.stopAll };
