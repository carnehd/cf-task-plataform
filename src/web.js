// Estaleiro no browser: `npm run web`. Um servidor local (só em 127.0.0.1) que serve a mesma página e responde às
// mesmas chamadas que a janela Electron. Corre só com o Node, sem Electron.
//
// O que protege este servidor, que lê pastas e arranca agentes: ouve só neste computador; só responde a pedidos cujo
// Host seja o dele (contra DNS rebinding); a página e as chamadas levam um segredo (data/web-token, criado na primeira
// vez e igual daí em diante) que um site aberto no mesmo browser não conhece; e não permite pedidos de outras origens.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const core = require('./core');

const APP_DIR = path.join(__dirname, '..');
const DATA_DIR = process.env.ESTALEIRO_DATA ? path.resolve(process.env.ESTALEIRO_DATA) : path.join(APP_DIR, 'data');
const RENDERER = path.join(__dirname, 'renderer');
const PORT = Number(process.env.PORT) || 5810;
const HOST = '127.0.0.1';
const MAX_BODY = 160 * 1024 * 1024; // documentos arrastados chegam em base64
const JS = 'text/javascript; charset=utf-8';
// o escritório (office.js) e o three.js só se carregam quando se abre o escritório de um passo
const FILES = { 'styles.css': 'text/css; charset=utf-8', 'app.js': JS, 'bridge.js': JS, 'office.js': JS, 'vendor/three/three.module.js': JS, 'vendor/three/OrbitControls.js': JS };

fs.mkdirSync(DATA_DIR, { recursive: true });
const tokenFile = path.join(DATA_DIR, 'web-token');
let TOKEN = '';
try {
  TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
} catch {
  // primeira vez
}
if (!/^[a-f0-9]{36}$/.test(TOKEN)) {
  TOKEN = crypto.randomBytes(18).toString('hex');
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
}

// o que a janela Electron tem e aqui se faz de outra forma
const handlers = new Map();
const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
const clients = new Set();
const send = (channel, payload) => {
  const chunk = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(chunk);
};
// as pastas e ficheiros escolhem-se na própria página (bridge.js, com fs:list): não há diálogo do sistema
const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
const openPath = (p) => new Promise((resolve) => {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [p]] : process.platform === 'win32' ? ['explorer', [p]] : ['xdg-open', [p]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => resolve(`Não consegui abrir ${p}: ${e.message}`));
    child.unref();
    setTimeout(() => resolve(''), 300);
  } catch (e) {
    resolve(`Não consegui abrir ${p}: ${e.message}`);
  }
});

// Mostra um ficheiro no explorador de ficheiros, com ele escolhido
const revealPath = (p) => new Promise((resolve) => {
  const [cmd, args] = process.platform === 'darwin' ? ['open', ['-R', p]] : process.platform === 'win32' ? ['explorer', [`/select,${p}`]] : ['xdg-open', [path.dirname(p)]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => resolve(`Não consegui mostrar ${p}: ${e.message}`));
    child.unref();
    setTimeout(() => resolve(''), 300);
  } catch (e) {
    resolve(`Não consegui mostrar ${p}: ${e.message}`);
  }
});

core.registerAll(ipcMain, { dataDir: DATA_DIR, appDir: APP_DIR, send, getWindow: () => null, dialog, version: require('../package.json').version, mode: 'web', openPath, revealPath });

// Só no browser: o que há numa pasta, para a página escolher pastas e ficheiros
ipcMain.handle('fs:list', async (_, where) => {
  try {
    let dir = path.resolve(String(where || os.homedir()));
    if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
    if (!fs.existsSync(dir)) return { error: `A pasta não existe: ${dir}` };
    const entries = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = fs.statSync(full).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir || e.isFile() || e.isSymbolicLink()) entries.push({ name: e.name, full, dir: isDir });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
    const parent = path.dirname(dir);
    return { path: dir, parent: parent === dir ? null : parent, home: os.homedir(), entries: entries.slice(0, 600), more: entries.length > 600 };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});

const okHost = (host) => host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
const plain = (res, code, text) => {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
};
const sameToken = (t) => {
  const a = Buffer.from(String(t || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const server = http.createServer((req, res) => {
  if (!okHost(req.headers.host || '')) return plain(res, 403, 'Host não permitido');
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (!sameToken(url.searchParams.get('t'))) return plain(res, 403, `Abre o endereço completo que o servidor mostrou ao arrancar: http://${HOST}:${PORT}/?t=<segredo>\nO segredo está em ${tokenFile}`);
    const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8').replace('</head>', `<meta name="estaleiro-token" content="${TOKEN}">\n</head>`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
    return res.end(html);
  }

  if (req.method === 'GET' && FILES[url.pathname.slice(1)]) {
    res.writeHead(200, { 'content-type': FILES[url.pathname.slice(1)], 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(RENDERER, url.pathname.slice(1))));
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    if (!sameToken(url.searchParams.get('t'))) return plain(res, 403, 'Segredo inválido');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': ligado\n\n');
    clients.add(res);
    const beat = setInterval(() => res.write(': ainda aqui\n\n'), 25000);
    req.on('close', () => { clearInterval(beat); clients.delete(res); });
    return undefined;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (!sameToken(req.headers['x-token'])) return plain(res, 403, 'Segredo inválido');
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return plain(res, 403, 'Origem não permitida');
    const channel = decodeURIComponent(url.pathname.slice(5));
    const fn = handlers.get(channel);
    if (!fn) return plain(res, 404, 'Chamada desconhecida');
    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
    });
    req.on('end', async () => {
      if (tooBig) return;
      let args = [];
      try {
        args = JSON.parse(body || '{}').args || [];
      } catch {
        return plain(res, 400, 'JSON inválido');
      }
      let out;
      const t0 = Date.now();
      try {
        out = await fn(null, ...args);
      } catch (e) {
        out = { error: String((e && e.message) || e) };
      }
      // um registo de cada chamada (só o canal e o resultado, nunca o conteúdo): para saber o que a página pediu
      console.log(`${new Date().toTimeString().slice(0, 8)} ${channel} ${Date.now() - t0} ms${out && out.error ? ` ERRO: ${String(out.error).slice(0, 160)}` : ''}`);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out === undefined ? {} : out));
    });
    return undefined;
  }

  return plain(res, 404, 'Não existe');
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `A porta ${PORT} já está em uso. Corre com outra: PORT=5811 npm run web` : `O servidor não arrancou: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Estaleiro a correr. Abre no browser:\n\n  http://${HOST}:${PORT}/?t=${TOKEN}\n\nDados em ${DATA_DIR}. Ctrl+C para parar.`);
});

const stop = () => {
  core.stopAll();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
