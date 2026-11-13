// Os mock servers: respondem aos pedidos dos microserviços com respostas guardadas em ficheiros numa pasta. Todos os
// mocks correm num só processo, `java MockServer.java --controlo` (src/mock/MockServer.java: só o JDK, sem compilar nem
// descarregar nada), cada um na sua porta e com a sua pasta. A plataforma guarda a lista (nome, porta, pasta, serviço a gravar), arranca e pára cada um, junta os pedidos que
// ele recebe e mostra os ficheiros das respostas, que se criam, editam e apagam na página.
//   data/mocks.json       a lista
//   data/mocks/<nome>/    a pasta de um mock, quando não se escolhe outra
//   data/mock-server/     a cópia do MockServer.java que corre (o java não lê de dentro do pacote da app)
// A pasta de um mock: <MÉTODO>/<caminho>.<extensão>, como o MockServer.java a lê (ver o cabeçalho dele).
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const shell = require('./shell');
const { readJson, writeJson, newId } = require('./store');

const SOURCE = path.join(__dirname, 'mock', 'MockServer.java');
const LOG_MAX = 400; // pedidos guardados por mock (em memória)
const FILE_MAX = 512 * 1024; // o tamanho de uma resposta que se mostra e edita
const LIST_MAX = 3000;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY'];
const EXTS = ['json', 'xml', 'txt', 'html', 'csv', 'yaml', 'yml', 'pdf', 'png', 'jpg', 'bin'];
const TEXT = new Set(['json', 'xml', 'txt', 'html', 'csv', 'yaml', 'yml']);
const NAME = /^(.+?)(?:\.([1-5][0-9]{2}))?\.([A-Za-z0-9]+)$/;
// uma linha da consola do MockServer.java: [10:21:07] GET /x?y=1  ->  200  GET/x.json  (1 ms)
const LINE = /^\[(\d\d:\d\d:\d\d)\] (\S+) (\S+) {2}-> {2}(\d{3}) {2}(.*) {2}\((\d+) ms\)$/;
const BODY = /^\s+corpo: (.*)$/;

const now = () => new Date().toISOString();
const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mock';
const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
// um nome de pasta ou ficheiro que também serve no Windows (as chavetas ficam: {id})
const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+$/, '_');

const procs = new Map(); // id → { status: 'starting'|'running'|'stopped'|'failed', error, startedAt, log, recording, stopping, port }
let current = null; // o processo Java que serve os mocks: { child, alive, closing, ports: porta → id, errTail, exited }
let hostStarting = null; // a promessa desse processo (enquanto arranca, e depois)

// O ficheiro de uma resposta, lido pelo nome: a que pedido responde. kind: response | headers | other
function describe(rel) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const file = parts.pop() || '';
  if (!file || file.startsWith('.')) return { kind: 'other' };
  if (file.endsWith('.headers')) return { kind: 'headers', of: [...parts, file.slice(0, -'.headers'.length)].join('/') };
  const m = NAME.exec(file);
  if (!m || !EXTS.includes(m[3].toLowerCase()) || !parts.length || !METHODS.includes(parts[0])) return { kind: 'other' };
  let base = m[1];
  let query = '';
  const at = base.indexOf('@');
  if (at >= 0) {
    query = base.slice(at + 1);
    base = base.slice(0, at);
  }
  const segs = [...parts.slice(1), base];
  if (segs[segs.length - 1] === 'index') segs.pop();
  return { kind: 'response', method: parts[0], route: `/${segs.join('/')}`, query, status: m[2] ? Number(m[2]) : 200, ext: m[3].toLowerCase() };
}

function walk(dir, max = LIST_MAX) {
  const out = [];
  const go = (d, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= max || e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) go(path.join(d, e.name), r);
      else if (e.isFile()) {
        let st = null;
        try {
          st = fs.statSync(path.join(d, e.name));
        } catch {
          continue;
        }
        out.push({ rel: r, size: st.size, mtime: st.mtime.toISOString(), ...describe(r) });
      }
    }
  };
  go(dir, '');
  return out;
}

// A porta está livre? Tenta-se escutar nela, em 127.0.0.1 (onde chegam os microserviços deste computador) e em todas as
// interfaces: no macOS, o java consegue escutar em todas mesmo com outro programa em 127.0.0.1, e os pedidos a
// localhost iam para esse outro
const tryListen = (port, host) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
});
const portFree = async (port) => (await tryListen(port, '127.0.0.1')) && (await tryListen(port, '0.0.0.0'));

async function findJava() {
  const j = await shell.findCli('java');
  if (j.found) return j;
  const env = await shell.loginShellEnv();
  const home = env.JAVA_HOME || process.env.JAVA_HOME;
  const file = home && path.join(home, 'bin', shell.IS_WIN ? 'java.exe' : 'java');
  if (file && fs.existsSync(file)) return { name: 'java', found: true, file, version: '', shell: false };
  return j;
}

function register(ipcMain, ctx) {
  const { dataDir } = ctx;
  const listFile = path.join(dataDir, 'mocks.json');
  const load = () => {
    const l = readJson(listFile, []);
    return Array.isArray(l) ? l.filter((m) => m && m.id && m.name && m.port) : [];
  };
  const save = (list) => writeJson(listFile, list);
  const dirOf = (m) => (m.dir ? path.resolve(m.dir) : path.join(dataDir, 'mocks', slug(m.name)));
  const get = (id) => {
    const m = load().find((x) => x.id === String(id));
    if (!m) throw new Error('Esse mock já não existe');
    return m;
  };
  const emit = (payload) => ctx.send('task-event', { type: 'mock', ...payload });
  const busy = (id) => {
    const p = procs.get(id);
    return Boolean(p && (p.status === 'running' || p.status === 'starting'));
  };
  const view = (m) => {
    const p = procs.get(m.id);
    const dir = dirOf(m);
    const files = fs.existsSync(dir) ? walk(dir) : [];
    return {
      ...m,
      dir,
      dirDefault: !m.dir,
      url: `http://localhost:${m.port}`,
      status: p ? p.status : 'stopped',
      error: p ? p.error : '',
      startedAt: p ? p.startedAt : null,
      recording: p ? p.recording : false,
      responses: files.filter((f) => f.kind === 'response').length,
    };
  };
  // a cópia do MockServer.java que corre: o java precisa de um ficheiro verdadeiro, e a app empacotada não o tem
  const runnable = () => {
    const target = path.join(dataDir, 'mock-server', 'MockServer.java');
    const src = fs.readFileSync(SOURCE, 'utf8');
    let cur = '';
    try {
      cur = fs.readFileSync(target, 'utf8');
    } catch {
      // ainda não existe
    }
    if (cur !== src) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, src);
    }
    return target;
  };
  // o caminho de um ficheiro dentro da pasta de um mock (recusa o que sai dela)
  const fileIn = (m, rel) => {
    const dir = dirOf(m);
    const file = path.resolve(dir, String(rel || ''));
    if (!inside(dir, file)) throw new Error('Esse ficheiro não é da pasta deste mock');
    return { dir, file };
  };

  const setStatus = (id, p, status, error = '') => {
    p.status = status;
    p.error = error;
    emit({ id, kind: 'status', status, error });
  };
  const note = (id, p, text, err = false) => {
    const entry = { text, err };
    p.log.push(entry);
    if (p.log.length > LOG_MAX) p.log.splice(0, p.log.length - LOG_MAX);
    emit({ id, kind: 'log', entry });
  };

  // uma linha de um mock: um pedido (e o corpo dele, na linha seguinte) ou uma nota
  function addLine(id, p, line) {
    const body = BODY.exec(line);
    const last = p.log[p.log.length - 1];
    if (body && last && last.method) {
      last.body = body[1].slice(0, 600);
      emit({ id, kind: 'log', entry: last, replaceLast: true });
      return;
    }
    const m = LINE.exec(line);
    let entry;
    if (m) {
      const sug = /sem mock · cria (\S+)/.exec(m[5]);
      entry = { at: m[1], method: m[2], path: m[3], status: Number(m[4]), what: m[5], ms: Number(m[6]), suggest: sug ? sug[1] : '' };
    } else {
      entry = { text: line.slice(0, 600), err: false };
    }
    p.log.push(entry);
    if (p.log.length > LOG_MAX) p.log.splice(0, p.log.length - LOG_MAX);
    emit({ id, kind: 'log', entry });
  }

  // -- o processo Java: um só para todos os mocks (MockServer.java --controlo). Arranca com o primeiro mock e termina
  // quando já não há nenhum a correr; cada mock inicia e pára por um comando (uma linha, com os campos separados por tabs).
  // Uma linha da consola que começa por @<porta> é desse mock; as outras são do processo. --
  function hostLine(h, raw, err) {
    const line = String(raw).replace(/\r$/, '');
    if (!line.trim()) return;
    if (!err && line === 'PRONTO') {
      h.ready();
      return;
    }
    const m = /^@(\d+) (.*)$/.exec(line);
    if (!m) {
      h.errTail = [...h.errTail, line].slice(-12);
      return;
    }
    const port = Number(m[1]);
    const rest = m[2];
    const id = h.ports.get(port);
    const p = id ? procs.get(id) : null;
    const ended = rest === 'parado' || rest.startsWith('ERRO ');
    if (ended) h.ports.delete(port);
    if (p) {
      if (/^Mock server em /.test(rest)) {
        addLine(id, p, rest);
        if (p.status === 'starting') setStatus(id, p, 'running');
      } else if (rest.startsWith('ERRO ')) {
        note(id, p, `— ${rest.slice(5)} —`, true);
        setStatus(id, p, 'failed', rest.slice(5));
      } else if (rest === 'parado') {
        note(id, p, '— parado —');
        setStatus(id, p, 'stopped');
      } else {
        addLine(id, p, rest);
      }
    }
    if (ended) idle(h);
  }

  // sem mocks a correr, o processo termina: fecha-se a entrada dele (e, se não fechar, mata-se)
  function idle(h) {
    if (h.ports.size || !h.alive || h.closing) return;
    h.closing = true;
    try {
      h.child.stdin.end();
    } catch {
      // já fechada
    }
    setTimeout(() => { if (h.alive) shell.killTree(h.child); }, 3000);
  }

  // O motivo de o processo parar sem ninguém o pedir, dito para uma pessoa
  function whyHostFailed(h, code) {
    const tail = h.errTail.join('\n');
    if (/Could not find or load main class|UnsupportedClassVersionError|invalid source release|class file version|Unrecognized option/i.test(tail)) return 'O Java deste computador é antigo: o mock server precisa do Java 11 ou mais recente.';
    const lines = h.errTail.filter((l) => l.trim() && !/^\s+at /.test(l));
    return lines.length ? lines.slice(-3).join(' · ').slice(0, 400) : `O mock server parou (código ${code}).`;
  }

  function host() {
    if (hostStarting) return hostStarting;
    hostStarting = (async () => {
      const java = await findJava();
      if (!java.found) throw new Error('Não encontro o Java neste computador: o mock server precisa do Java 11 ou mais recente (o mesmo dos microserviços).');
      const env = await shell.loginShellEnv();
      const child = spawn(java.file, [runnable(), '--controlo'], { cwd: dataDir, env, windowsHide: true });
      const h = { child, alive: true, closing: false, ports: new Map(), errTail: [] };
      const ready = new Promise((resolve, reject) => { h.ready = resolve; h.fail = reject; });
      h.exited = new Promise((resolve) => child.on('exit', resolve));
      current = h;
      const lines = (stream, err) => {
        let rest = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          const parts = (rest + chunk).split('\n');
          rest = parts.pop();
          for (const l of parts) hostLine(h, l, err);
        });
        stream.on('end', () => { if (rest) hostLine(h, rest, err); });
      };
      lines(child.stdout, false);
      lines(child.stderr, true);
      child.stdin.on('error', () => {}); // escrever num processo que já fechou
      child.on('error', (e) => {
        h.alive = false;
        h.fail(new Error(`Não consegui arrancar o Java: ${e.message}`));
      });
      child.on('exit', (code) => {
        h.alive = false;
        if (current === h) {
          current = null;
          hostStarting = null;
        }
        const why = whyHostFailed(h, code);
        h.fail(new Error(why));
        for (const [, id] of h.ports) {
          const p = procs.get(id);
          if (!p) continue;
          if (p.stopping || h.closing) {
            note(id, p, '— parado —');
            setStatus(id, p, 'stopped');
          } else {
            note(id, p, `— parou: ${why} —`, true);
            setStatus(id, p, 'failed', why);
          }
        }
        h.ports.clear();
      });
      await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('O Java do mock server não respondeu em 60 segundos')), 60000))]);
      return h;
    })();
    hostStarting.catch(() => { hostStarting = null; });
    return hostStarting;
  }

  async function start(m) {
    if (busy(m.id)) return;
    if (!(await portFree(m.port))) throw new Error(`A porta ${m.port} já está em uso: há outro programa (ou outro mock) a escutar nela. Muda a porta deste mock ou pára o outro.`);
    const dir = dirOf(m);
    fs.mkdirSync(dir, { recursive: true });
    const before = procs.get(m.id);
    const p = { status: 'starting', error: '', startedAt: now(), log: before ? before.log : [], recording: Boolean(m.recordFrom), stopping: false, port: m.port };
    procs.set(m.id, p);
    note(m.id, p, `— a arrancar na porta ${m.port}${m.recordFrom ? `, a gravar de ${m.recordFrom}` : ''} —`);
    setStatus(m.id, p, 'starting');
    let h;
    try {
      h = await host();
      // o processo estava a terminar (o último mock acabou de parar): espera-se e arranca-se outro
      if (h.closing || !h.alive) {
        await h.exited;
        h = await host();
      }
    } catch (e) {
      note(m.id, p, `— ${e.message} —`, true);
      setStatus(m.id, p, 'failed', e.message);
      throw e;
    }
    h.ports.set(m.port, m.id);
    h.child.stdin.write(`${['iniciar', m.port, dir, m.recordFrom ? `gravar=${m.recordFrom}` : ''].join('\t')}\n`);
  }

  async function stop(id) {
    const p = procs.get(id);
    if (!p || !busy(id)) return;
    p.stopping = true;
    const h = current;
    if (!h || !h.alive || !h.ports.has(p.port)) {
      note(id, p, '— parado —');
      setStatus(id, p, 'stopped');
      return;
    }
    h.child.stdin.write(`parar\t${p.port}\n`);
  }

  const guard = (fn) => async (_, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  };

  ipcMain.handle('mocks:list', guard(async () => {
    const java = await findJava();
    return { java: { found: java.found, version: java.version || '', file: java.file || '' }, mocks: load().map(view), dataDir };
  }));

  // criar (sem id) ou mudar um mock: nome, porta, pasta (vazia: data/mocks/<nome>) e o serviço a gravar (opcional)
  ipcMain.handle('mocks:save', guard((input) => {
    const g = input && typeof input === 'object' ? input : {};
    const list = load();
    const id = g.id ? String(g.id) : '';
    const name = String(g.name || '').trim().slice(0, 60);
    if (!name) throw new Error('Dá um nome ao mock');
    const port = Number(g.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('A porta tem de ser um número entre 1024 e 65535');
    const dir = String(g.dir || '').trim();
    const recordFrom = String(g.recordFrom || '').trim().replace(/\/+$/, '');
    if (recordFrom && !/^https?:\/\/\S+$/i.test(recordFrom)) throw new Error('O serviço a gravar tem de ser um endereço http:// ou https://');
    const samePort = list.find((x) => x.port === port && x.id !== id);
    if (samePort) throw new Error(`A porta ${port} já é do mock ${samePort.name}`);
    const target = dir ? path.resolve(dir) : path.join(dataDir, 'mocks', slug(name));
    const sameDir = list.find((x) => x.id !== id && dirOf(x) === target);
    if (sameDir) throw new Error(`Essa pasta já é do mock ${sameDir.name}`);
    let m;
    if (id) {
      m = list.find((x) => x.id === id);
      if (!m) throw new Error('Esse mock já não existe');
      if (busy(id)) throw new Error('Pára o mock antes de o mudar');
      Object.assign(m, { name, port, dir, recordFrom });
    } else {
      m = { id: newId(), name, port, dir, recordFrom, createdAt: now() };
      list.push(m);
    }
    save(list);
    // uma pasta nova (ou vazia) começa com um exemplo, para se ver o formato
    let empty = true;
    try {
      empty = !fs.readdirSync(target).some((n) => !n.startsWith('.'));
    } catch {
      // ainda não existe
    }
    if (empty) {
      fs.mkdirSync(path.join(target, 'GET'), { recursive: true });
      fs.writeFileSync(path.join(target, 'GET', 'ping.json'), `{\n  "ok": true,\n  "mock": ${JSON.stringify(name)},\n  "agora": "{{agora}}"\n}\n`);
    }
    return { mock: view(m) };
  }));

  ipcMain.handle('mocks:remove', guard(async (id) => {
    await stop(String(id));
    procs.delete(String(id));
    save(load().filter((x) => x.id !== String(id)));
    return { ok: true };
  }));

  ipcMain.handle('mocks:start', guard(async (id) => {
    await start(get(id));
    return { ok: true };
  }));
  ipcMain.handle('mocks:stop', guard(async (id) => {
    await stop(String(id));
    return { ok: true };
  }));

  ipcMain.handle('mocks:log', guard((id) => ({ entries: (procs.get(String(id)) || { log: [] }).log })));
  ipcMain.handle('mocks:clear-log', guard((id) => {
    const p = procs.get(String(id));
    if (p) p.log = [];
    return { ok: true };
  }));

  ipcMain.handle('mocks:files', guard((id) => {
    const m = get(id);
    const dir = dirOf(m);
    const files = fs.existsSync(dir) ? walk(dir) : [];
    return { dir, files, truncated: files.length >= LIST_MAX };
  }));

  ipcMain.handle('mocks:read', guard((id, rel) => {
    const { file } = fileIn(get(id), rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Esse ficheiro já não existe');
    const d = describe(String(rel));
    const size = fs.statSync(file).size;
    const ext = path.extname(file).slice(1).toLowerCase();
    if (d.kind === 'response' && !TEXT.has(ext)) return { rel, size, binary: true, describe: d };
    if (size > FILE_MAX) return { rel, size, tooBig: true, describe: d };
    return { rel, size, text: fs.readFileSync(file, 'utf8'), describe: d };
  }));

  // guardar o texto de uma resposta (ou dos cabeçalhos dela): só ficheiros que o mock lê
  ipcMain.handle('mocks:write', guard((id, rel, text) => {
    const { file } = fileIn(get(id), rel);
    const d = describe(String(rel));
    if (d.kind === 'other') throw new Error('Só se guardam respostas (<MÉTODO>/<caminho>.json, .xml, .txt...) e ficheiros .headers');
    if (d.kind === 'response' && !TEXT.has(d.ext)) throw new Error('Esta resposta não é texto');
    const content = String(text == null ? '' : text);
    if (Buffer.byteLength(content) > FILE_MAX) throw new Error('A resposta é demasiado grande para editar aqui');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return { ok: true, rel: String(rel), describe: d };
  }));

  // uma resposta nova a partir do pedido: GET /utilizadores/{id} ?estado=ATIVO, 404, json → GET/utilizadores/{id}@estado=ATIVO.404.json
  ipcMain.handle('mocks:create-file', guard((id, given) => {
    const m = get(id);
    const g = given && typeof given === 'object' ? given : {};
    const method = String(g.method || 'GET').toUpperCase();
    if (!METHODS.includes(method)) throw new Error('Método desconhecido');
    const raw = String(g.path || '').trim();
    const [p, q0] = raw.split('?');
    const segs = p.split('/').filter(Boolean).map((s) => safe(decodeURIComponent(s)));
    if (!segs.length) segs.push('index');
    const query = String(g.query || q0 || '').trim().replace(/^\?/, '').split('&').filter(Boolean).map((pair) => safe(decodeURIComponent(pair))).join('&');
    const status = Number(g.status || 200);
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('O código de resposta tem de estar entre 100 e 599');
    const ext = EXTS.includes(String(g.ext || 'json')) && TEXT.has(String(g.ext || 'json')) ? String(g.ext || 'json') : 'json';
    const name = `${segs[segs.length - 1]}${query ? `@${query}` : ''}${status !== 200 ? `.${status}` : ''}.${ext}`;
    const rel = [method, ...segs.slice(0, -1), name].join('/');
    const { file } = fileIn(m, rel);
    if (fs.existsSync(file)) throw new Error(`Já existe: ${rel}`);
    const body = typeof g.body === 'string' ? g.body
      : ext === 'json' ? `{\n  "ok": true\n}\n` : ext === 'xml' ? '<resposta>\n  <ok>true</ok>\n</resposta>\n' : '';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return { rel, describe: describe(rel) };
  }));

  ipcMain.handle('mocks:delete-file', guard((id, rel) => {
    const { file } = fileIn(get(id), rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Esse ficheiro já não existe');
    fs.rmSync(file);
    return { ok: true };
  }));

  // mostrar a pasta (ou um ficheiro dela) no gestor de ficheiros
  ipcMain.handle('mocks:reveal', guard(async (id, rel) => {
    const m = get(id);
    const dir = dirOf(m);
    fs.mkdirSync(dir, { recursive: true });
    if (!rel) return { error: (await ctx.openPath(dir)) || undefined };
    const { file } = fileIn(m, rel);
    return { error: (await ctx.revealPath(file)) || undefined };
  }));

  ipcMain.handle('mocks:pick-folder', guard(async () => {
    const r = await ctx.dialog.showOpenDialog(ctx.getWindow(), { title: 'Pasta das respostas do mock', properties: ['openDirectory', 'createDirectory'] });
    return { folder: r.canceled ? null : r.filePaths[0] };
  }));
}

// Ao fechar a plataforma: o processo dos mocks também pára
function stopAll() {
  const h = current;
  if (!h || !h.alive) return;
  h.closing = true;
  try {
    h.child.stdin.end();
    h.child.kill();
  } catch {
    // já tinha parado
  }
}

module.exports = { register, stopAll, describe };
