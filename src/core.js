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
const { spawn } = require('child_process');
const { copilotAuth } = require('./copilot-session');

// Tem sessão iniciada? Claude: `claude auth status --json`. Copilot: copilotAuth. Guarda-se um minuto (o Copilot leva
// uns segundos a responder); { cli, loggedIn: true | false | null (não se sabe), who, detail }
const authKept = new Map();
const authAsking = new Map(); // o pedido que está a correr, por CLI: quem pergunta entretanto espera por ele
function authOf(cli, fresh) {
  const kept = authKept.get(cli);
  if (!fresh && kept && Date.now() - kept.at < 60000) return Promise.resolve(kept.r);
  if (authAsking.has(cli)) return authAsking.get(cli);
  const asking = askAuth(cli).finally(() => authAsking.delete(cli));
  authAsking.set(cli, asking);
  return asking;
}
async function askAuth(cli) {
  let r;
  if (cli === 'copilot') r = await copilotAuth();
  else {
    const c = await shell.findCli('claude');
    if (!c.found) r = { loggedIn: null, detail: 'o Claude CLI não está neste computador' };
    else {
      const out = await shell.exec(c.file, ['auth', 'status', '--json'], { env: shell.agentEnv(await shell.loginShellEnv()), shell: c.shell, timeout: 20000 });
      const text = out.out || '';
      try {
        const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        r = { loggedIn: Boolean(j.loggedIn), who: j.loggedIn ? String(j.email || j.orgName || '') : '' };
      } catch {
        r = { loggedIn: null, detail: (out.err || text).trim().split('\n').pop() || 'não consegui saber' };
      }
    }
  }
  r = { cli, ...r };
  authKept.set(cli, { at: Date.now(), r });
  return r;
}

// Abre uma janela de terminal com o login do CLI (é ele que abre o browser para entrar na conta)
async function openLogin(cli) {
  const c = await shell.findCli(cli === 'copilot' ? 'copilot' : 'claude');
  if (!c.found) throw new Error(`O ${cli === 'copilot' ? 'Copilot CLI' : 'Claude CLI'} não está neste computador`);
  const args = cli === 'copilot' ? ['login'] : ['auth', 'login'];
  authKept.delete(cli);
  if (process.platform === 'win32') {
    // start "" cmd /k "<programa>" login: uma janela nova que fica aberta para se ver o resultado
    spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', c.file, ...args], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } else if (process.platform === 'darwin') {
    const line = [c.file, ...args].map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ');
    const script = `tell application "Terminal"\nactivate\ndo script "${line.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', c.file, ...args], { detached: true, stdio: 'ignore' }).unref();
  }
  return { ok: true };
}

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
        // o CLI dos agentes: o escolhido no topo; sem escolha, o que está instalado (o Claude, se estão os dois)
        let cli = settings.cli(ctx.dataDir);
        if (!cli) cli = settings.setCli(ctx.dataDir, claude.found || !copilot.found ? 'claude' : 'copilot');
        return { clis: { claude, copilot }, engines: { docker, podman, git }, cli };
      })()),
    };
  });
  ipcMain.handle('app:auth', async (_, cli, fresh) => {
    try {
      return await authOf(cli === 'copilot' ? 'copilot' : 'claude', Boolean(fresh));
    } catch (e) {
      return { cli, loggedIn: null, detail: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('app:login', async (_, cli) => {
    try {
      return await openLogin(cli);
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
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
