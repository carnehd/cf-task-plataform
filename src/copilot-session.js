// Uma sessão com o Copilot CLI, pelo Agent Client Protocol (copilot --acp): JSON-RPC 2.0, uma mensagem por linha, por
// stdin e stdout. Dá à plataforma a mesma interface que a sessão do Claude CLI (session.js): o que o agente diz e faz
// chega a onEntry; o que ele quer fazer e o Copilot pergunta (session/request_permission) passa por decide(), que
// permite, recusa ou deixa para a pessoa (pending até answer()); cada pedido (session/prompt) que acaba é uma volta.
//
// Diferenças em relação ao Claude CLI: o Copilot aprova sozinho alguns comandos que considera seguros (um ls não chega
// a ser perguntado), e uma recusa não leva o motivo ao agente: os motivos vão no início da mensagem seguinte.
const { spawn } = require('child_process');
const path = require('path');
const shell = require('./shell');
const { summaryOf } = require('./session');

const BASE_ARGS = ['--acp', '--no-auto-update', '--no-ask-user', '--disable-builtin-mcps', '--no-color'];
const IDLE_MS = 10 * 60 * 1000;
const END_WAIT_MS = 3000;

// O nome que a plataforma dá à ferramenta, pelo tipo que o ACP diz (null: não se mostra)
function toolOf(kind, title) {
  const t = String(title || '');
  switch (kind) {
    case 'read': return 'Read';
    case 'edit': return /^(create|add)/i.test(t) ? 'Write' : 'Edit';
    case 'delete': case 'move': return 'Edit';
    case 'execute': return 'Bash';
    case 'search': return 'Grep';
    case 'fetch': return 'Fetch';
    case 'think': case 'switch_mode': return null;
    default: return t ? t.slice(0, 30) : 'Ferramenta';
  }
}

// Os ficheiros de um patch do Copilot (*** Add File: x, *** Update File: x, *** Delete File: x)
const patchFiles = (text) => [...String(text || '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());

// O que a ferramenta recebe, no formato que a política e o resumo conhecem; uma escrita pode tocar em vários ficheiros
function inputsOf(kind, raw, locations, cwd) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const locs = (Array.isArray(locations) ? locations : []).map((l) => l && l.path).filter(Boolean);
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(cwd, p));
  if (kind === 'execute') return [{ command: String(r.command || '') }];
  if (kind === 'search') return [{ pattern: String(r.pattern || r.query || ''), path: r.path || '' }];
  if (kind === 'read') return [{ file_path: abs(String(r.path || r.file_path || r.fileName || locs[0] || '')) }];
  if (['edit', 'delete', 'move'].includes(kind)) {
    const files = [...new Set([r.fileName, r.path, r.file_path, r.destination, ...patchFiles(typeof raw === 'string' ? raw : r.patch), ...locs].filter(Boolean).map(String))];
    return (files.length ? files : ['']).map((f) => ({ file_path: f ? abs(f) : '' }));
  }
  return [r];
}

const textOf = (content) => (Array.isArray(content) ? content : []).map((c) => (c && c.type === 'content' && c.content && c.content.type === 'text' ? c.content.text : c && c.type === 'text' ? c.text : '')).join('');
// no Windows, um .cmd só arranca por uma shell, que parte os argumentos com espaços: vão entre aspas
const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);

function startCopilotSession({ file, useShell = false, env, cwd, addDirs = [], resume = '', model = '', show = [], decide, onEntry, onPending, onTurnEnd, onEnd }) {
  const args = [...BASE_ARGS, ...(model ? ['--model', model] : [])];
  for (const d of addDirs) args.push('--add-dir', d);
  const child = spawn(file, useShell ? args.map(quote) : args, { cwd, env: { ...shell.agentEnv(env) }, windowsHide: true, detached: !shell.IS_WIN, shell: Boolean(useShell), stdio: ['pipe', 'pipe', 'pipe'] });
  const s = { sessionId: '', pending: new Map(), turn: false, ready: false, replaying: false, lastSignal: Date.now(), ended: false, reason: '', stderr: '', model, queue: [], notes: [] };
  const waiting = new Map();
  const started = new Map(); // ferramentas a correr: id -> { tool, at, b }
  let nextId = 1;
  let text = '';
  let textId = '';
  const pendingList = () => [...s.pending.values()].map(({ key, tool, summary }) => ({ id: key, tool, summary }));

  const write = (obj) => {
    if (s.ended || !child.stdin.writable) return false;
    child.stdin.write(`${JSON.stringify(obj)}\n`);
    return true;
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    if (!write({ jsonrpc: '2.0', id, method, params })) {
      waiting.delete(id);
      reject(new Error('O agente já não está a correr'));
    }
  });
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  // o texto do agente chega aos bocados: junta-se e entra quando a mensagem muda, começa uma ferramenta, ou a volta acaba
  const flush = () => {
    const t = text.trim();
    text = '';
    if (t) onEntry({ k: 'say', a: t.slice(0, 4000) });
  };

  async function decideAll(tool, inputs) {
    let ask = false;
    let note = '';
    for (const input of inputs) {
      const d = await decide({ tool, input });
      if (d.action === 'deny') return d;
      if (d.action === 'ask') ask = true;
      if (d.note && !note) note = d.note;
    }
    return ask ? { action: 'ask' } : { action: 'allow', note };
  }

  async function onPermission(id, p) {
    const tc = (p && p.toolCall) || {};
    const opts = Array.isArray(p && p.options) ? p.options : [];
    const optionOf = (kind) => (opts.find((o) => o && o.kind === kind) || {}).optionId;
    const tool = toolOf(tc.kind, tc.title) || 'Ferramenta';
    const inputs = inputsOf(tc.kind, tc.rawInput, tc.locations, cwd);
    const summary = inputs.map((i) => summaryOf(tool, i, show)).filter(Boolean).join(', ') || String(tc.title || '').slice(0, 160);
    let d;
    try {
      d = await decideAll(tool, inputs);
    } catch (e) {
      d = { action: 'deny', message: `A plataforma não conseguiu decidir: ${e.message}` };
    }
    if (s.ended) return;
    const reject = () => {
      const opt = optionOf('reject_once') || optionOf('reject_always');
      reply(id, { outcome: opt ? { outcome: 'selected', optionId: opt } : { outcome: 'cancelled' } });
    };
    if (d.action === 'allow') {
      reply(id, { outcome: { outcome: 'selected', optionId: optionOf('allow_once') || optionOf('allow_always') || (opts[0] || {}).optionId } });
      if (d.note) onEntry({ k: 'ok', a: tool, b: d.note });
    } else if (d.action === 'deny') {
      reject();
      onEntry({ k: 'deny', a: tool, b: summary, c: d.message });
      s.notes.push(`${tool} ${summary}: ${d.message}`);
    } else {
      const key = `acp-${id}`;
      s.pending.set(key, { key, id, tool, summary, optionOf });
      onEntry({ k: 'ask', a: tool, b: summary });
      onPending(pendingList());
    }
  }

  function onUpdate(u) {
    if (!u || s.replaying) return; // o histórico que o session/load repete não volta a entrar
    const t = u.sessionUpdate;
    if (t === 'agent_message_chunk') {
      if (u.messageId && u.messageId !== textId) {
        flush();
        textId = u.messageId;
      }
      if (u.content && u.content.type === 'text') text += String(u.content.text || '');
      return;
    }
    if (t === 'tool_call') {
      flush();
      const tool = toolOf(u.kind, u.title);
      if (!tool) return;
      const inputs = inputsOf(u.kind, u.rawInput, u.locations, cwd);
      const b = inputs.map((i) => summaryOf(tool, i, show)).filter(Boolean).join(', ') || String(u.title || '').slice(0, 160);
      started.set(u.toolCallId, { tool, at: Date.now(), b });
      onEntry({ k: 'tool', a: tool, b, id: String(u.toolCallId || '') });
      return;
    }
    if (t === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) {
      const st = started.get(u.toolCallId);
      if (!st) return;
      started.delete(u.toolCallId);
      if (st.tool !== 'Bash') return;
      const raw = textOf(u.content) || (u.rawOutput && u.rawOutput.content) || '';
      const exit = /exit code (\d+)/.exec(raw);
      const lines = String(raw).replace(/\n?<shellId:[^>]*>\s*$/, '').replace(/\s+$/, '').split('\n');
      const shown = lines.length > 40 ? [...lines.slice(0, 40), `… (mais ${lines.length - 40} linhas)`] : lines;
      onEntry({ k: 'result', id: String(u.toolCallId), a: 'Bash', b: shown.join('\n').slice(0, 4000), err: u.status === 'failed' || Boolean(exit && exit[1] !== '0'), ms: Date.now() - st.at });
    }
  }

  const take = (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (m.id !== undefined && m.id !== null && !m.method) {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w.reject(new Error(String(m.error.message || 'erro do Copilot CLI').slice(0, 300)));
      else w.resolve(m.result || {});
      return;
    }
    if (m.method === 'session/update') return onUpdate(m.params && m.params.update);
    if (m.method === 'session/request_permission' && m.id !== undefined) return onPermission(m.id, m.params);
    // pedidos que a plataforma não trata (ler e escrever ficheiros pelo cliente, terminais): não foram anunciados
    if (m.id !== undefined && m.method) write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `A plataforma não trata ${String(m.method).slice(0, 60)}` } });
  };

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    s.lastSignal = Date.now();
    buffer += d;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      take(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { s.stderr = (s.stderr + d).slice(-4000); });
  child.stdin.on('error', () => {});

  // um pedido de cada vez: as mensagens que chegam enquanto o agente trabalha ficam à espera
  function drain() {
    if (!s.ready || s.turn || s.ended || !s.queue.length) return;
    let msg = s.queue.shift();
    if (s.notes.length) {
      msg = `Nota da plataforma: estas ações foram recusadas antes, com estes motivos:\n${s.notes.map((n) => `- ${n}`).join('\n')}\n\n${msg}`;
      s.notes = [];
    }
    s.turn = true;
    s.lastSignal = Date.now();
    request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: msg }] }).then((r) => {
      flush();
      s.turn = false;
      const u = r.usage || {};
      const stop = String(r.stopReason || '');
      onTurnEnd({ isError: !['end_turn', 'cancelled', ''].includes(stop), text: stop === 'end_turn' ? '' : `O Copilot parou: ${stop}`, tokens: Number(u.totalTokens) || 0, sessionId: s.sessionId, model: s.model });
      drain();
    }).catch((e) => {
      flush();
      s.turn = false;
      if (s.ended) return;
      onTurnEnd({ isError: true, text: e.message, tokens: 0, sessionId: s.sessionId, model: s.model });
      drain();
    });
  }

  (async () => {
    try {
      await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (resume) {
        s.replaying = true;
        await request('session/load', { sessionId: resume, cwd, mcpServers: [] });
        s.replaying = false;
        s.sessionId = resume;
      } else {
        const r = await request('session/new', { cwd, mcpServers: [] });
        s.sessionId = String(r.sessionId || '');
      }
      s.ready = true;
      drain();
    } catch (e) {
      s.replaying = false;
      s.reason = /auth|login/i.test(e.message) ? 'O Copilot CLI não tem sessão iniciada neste computador: abre um terminal e corre "copilot login".' : `O Copilot CLI não arrancou: ${e.message}`;
      shell.killTree(child);
    }
  })();

  const watchdog = setInterval(() => {
    if (!s.turn || s.pending.size || Date.now() - s.lastSignal < IDLE_MS) return;
    s.reason = `O Copilot CLI ficou ${IDLE_MS / 60000} minutos sem dar sinal e foi parado.`;
    shell.killTree(child);
  }, 15000);

  const finish = (code, signal, error) => {
    if (s.ended) return;
    if (buffer.trim()) take(buffer);
    flush();
    s.ended = true;
    clearInterval(watchdog);
    s.pending.clear();
    for (const w of waiting.values()) w.reject(new Error('O Copilot CLI terminou'));
    waiting.clear();
    const said = s.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 400);
    const loggedOut = /not (logged|authenticated)|copilot login/i.test(s.stderr);
    onEnd({ code, signal, reason: s.reason || error || (loggedOut ? 'O Copilot CLI não tem sessão iniciada neste computador: abre um terminal e corre "copilot login".' : ''), stderr: said, sessionId: s.sessionId });
  };
  child.on('error', (e) => finish(null, null, `O Copilot CLI não arrancou: ${e.message}`));
  child.on('close', (code, signal) => finish(code, signal, ''));

  return {
    get sessionId() { return s.sessionId; },
    get pending() { return pendingList(); },
    get working() { return s.turn; },
    send(text) {
      if (s.ended) throw new Error('O agente já não está a correr');
      s.queue.push(String(text));
      s.lastSignal = Date.now();
      drain();
    },
    // a resposta da pessoa a um pedido: allow | always | deny
    answer(requestId, choice) {
      const p = s.pending.get(String(requestId));
      if (!p) throw new Error('Esse pedido já não está à espera de resposta');
      s.pending.delete(String(requestId));
      if (choice === 'deny') {
        const opt = p.optionOf('reject_once') || p.optionOf('reject_always');
        reply(p.id, { outcome: opt ? { outcome: 'selected', optionId: opt } : { outcome: 'cancelled' } });
        onEntry({ k: 'deny', a: p.tool, b: p.summary, c: 'Recusado por ti' });
      } else {
        const opt = (choice === 'always' && p.optionOf('allow_always')) || p.optionOf('allow_once') || p.optionOf('allow_always');
        reply(p.id, { outcome: { outcome: 'selected', optionId: opt } });
        onEntry({ k: 'ok', a: p.tool, b: `${p.summary} · ${choice === 'always' ? 'permitido por ti nesta tarefa' : 'permitido por ti'}` });
      }
      onPending(pendingList());
    },
    async end() {
      if (s.ended) return;
      try {
        child.stdin.end();
      } catch {
        // já fechada
      }
      const closed = new Promise((resolve) => child.once('close', resolve));
      const late = new Promise((resolve) => setTimeout(() => resolve('late'), END_WAIT_MS));
      if ((await Promise.race([closed, late])) === 'late') await shell.killTree(child);
    },
    kill(reason) {
      s.reason = reason || s.reason;
      return shell.killTree(child);
    },
  };
}

// Os modelos que o Copilot CLI aceita, lidos da sua própria ajuda (copilot help config), guardados enquanto a
// plataforma corre
let modelsCache = null;
async function copilotModels() {
  if (modelsCache) return modelsCache;
  const c = await shell.findCli('copilot');
  if (!c.found) return [];
  const r = await shell.exec(c.file, ['help', 'config'], { env: await shell.loginShellEnv(), shell: c.shell, timeout: 20000 });
  const text = r.ok ? r.out : '';
  const start = text.search(/^\s*`model`:/m);
  if (start < 0) return [];
  const block = text.slice(start).split(/\n\s*\n/)[0];
  modelsCache = [...block.matchAll(/^\s+- "([^"]+)"/gm)].map((m) => m[1]).slice(0, 60);
  return modelsCache;
}

// O Copilot CLI tem sessão iniciada? Não há um comando de estado: pergunta-se pelo ACP a lista das sessões, que só lê
// e que o Copilot recusa sem sessão iniciada. { loggedIn: true | false | null (não se sabe), detail }
async function copilotAuth() {
  const c = await shell.findCli('copilot');
  if (!c.found) return { loggedIn: null, detail: 'o Copilot CLI não está neste computador' };
  const env = shell.agentEnv(await shell.loginShellEnv());
  return new Promise((resolve) => {
    const args = ['--acp', '--no-auto-update', '--no-color'];
    let child;
    try {
      child = spawn(c.file, c.shell ? args.map(quote) : args, { env, windowsHide: true, detached: !shell.IS_WIN, shell: Boolean(c.shell), stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      resolve({ loggedIn: null, detail: e.message });
      return;
    }
    let done = false;
    let buf = '';
    let next = 0;
    const waiting = new Map();
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      shell.killTree(child);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ loggedIn: null, detail: 'o Copilot CLI não respondeu' }), 30000);
    child.on('error', (e) => finish({ loggedIn: null, detail: e.message }));
    child.on('exit', () => finish({ loggedIn: null, detail: 'o Copilot CLI fechou sem responder' }));
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
        } catch {
          // não é uma resposta
        }
      }
    });
    const request = (method, params) => new Promise((r) => {
      const id = ++next;
      waiting.set(id, r);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    (async () => {
      const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (init.error) return finish({ loggedIn: null, detail: String(init.error.message || '') });
      const list = await request('session/list', {});
      if (!list.error) return finish({ loggedIn: true });
      const why = String(list.error.message || '');
      return finish({ loggedIn: /auth|log ?in|sign.?in|unauthori|credential|token/i.test(why) ? false : null, detail: why.slice(0, 200) });
    })();
  });
}

module.exports = { startCopilotSession, copilotModels, copilotAuth, toolOf, inputsOf };
