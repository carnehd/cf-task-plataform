// Uma sessão com o Claude CLI: o processo fica aberto enquanto o agente trabalha, e fala-se com ele nos dois sentidos
// (stream-json à entrada e à saída). O que escreve chega a onEntry à medida que acontece; o que quer fazer passa
// primeiro por decide(), que a plataforma dá: permite, recusa, ou pergunta à pessoa (fica em pending até answer()).
// Quando acaba uma volta (o agente parou de trabalhar: terminou, ou espera uma resposta), chama onTurnEnd.
//
// O protocolo dos pedidos de permissão é o do Agent SDK (control_request can_use_tool / control_response), o mesmo que a
// consola de agente do QuickDeck usa.
const { spawn } = require('child_process');
const path = require('path');
const shell = require('./shell');

const ARGS = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--setting-sources', 'user', '--strict-mcp-config', '--disable-slash-commands'];
// sem nenhum sinal do CLI durante uma volta, está parado (o modelo sem responder, a rede, o computador que adormeceu)
const IDLE_MS = 10 * 60 * 1000;
const END_WAIT_MS = 3000;
const DENIED = 'A pessoa recusou isto na plataforma.';

// Uma linha que descreve o que uma ferramenta vai fazer, com os caminhos relativos ao que a pessoa conhece
function summaryOf(tool, input, show) {
  const rel = (p) => {
    const file = String(p || '');
    for (const { dir, label } of show) {
      // no Windows, a letra da unidade e as pastas podem vir com outras maiúsculas (c:\ e C:\)
      const starts = shell.IS_WIN ? file.toLowerCase().startsWith(String(dir).toLowerCase()) : file.startsWith(dir);
      if (dir && starts) return `${label}${file.slice(dir.length).replace(/^[\\/]+/, '')}`.replace(/\\/g, '/');
    }
    return file.replace(/\\/g, '/');
  };
  const i = input || {};
  if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(tool)) return rel(i.file_path).slice(-160);
  if (tool === 'NotebookEdit') return rel(i.notebook_path).slice(-160);
  if (tool === 'Bash') return String(i.command || '').slice(0, 400);
  if (tool === 'Grep') return `"${String(i.pattern || '').slice(0, 80)}"${i.path ? ` em ${rel(i.path)}` : ''}`;
  if (tool === 'Glob') return String(i.pattern || '').slice(0, 120);
  if (tool === 'AskUserQuestion') return (Array.isArray(i.questions) ? i.questions : []).map((q) => q && q.question).filter(Boolean).join(' · ').slice(0, 300);
  if (tool === 'TodoWrite') return `${(Array.isArray(i.todos) ? i.todos : []).length} tarefas`;
  return '';
}

// As regras que um "permitir nesta tarefa" acrescenta: as que o CLI sugere, só para esta sessão (nunca escritas num
// ficheiro de definições); senão uma para esta ferramenta e, num comando, só para este comando.
function sessionRules(req) {
  const given = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [];
  const rules = given.filter((p) => p && typeof p === 'object' && p.type === 'addRules' && p.behavior === 'allow').map((p) => ({ ...p, destination: 'session' }));
  if (rules.length) return rules;
  const rule = { toolName: String(req.tool_name || '') };
  if (rule.toolName === 'Bash' && req.input && typeof req.input.command === 'string') rule.ruleContent = req.input.command;
  return [{ type: 'addRules', rules: [rule], behavior: 'allow', destination: 'session' }];
}

// denyRead: ficheiros que o agente não pode ler (regras de recusa do próprio CLI, porque ele lê as pastas que conhece
// sem pedir autorização). Vão em --settings, em JSON, para os caminhos com espaços não se partirem.
const readRule = (p) => `Read(/${String(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`).replace(/[*?[\]]/g, '\\$&')})`;
function startSession({ file, env, cwd, addDirs = [], tools, resume = '', model = '', show = [], denyRead = [], decide, onEntry, onPending, onTurnEnd, onEnd }) {
  const args = [...ARGS, '--tools', tools.join(','), ...(model ? ['--model', model] : []), ...(resume ? ['--resume', resume] : [])];
  for (const d of addDirs) args.push('--add-dir', d);
  if (denyRead.length) args.push('--settings', JSON.stringify({ permissions: { deny: denyRead.slice(0, 2000).map(readRule) } }));
  const child = spawn(file, args, { cwd, env: { ...shell.agentEnv(env) }, windowsHide: true, detached: !shell.IS_WIN, stdio: ['pipe', 'pipe', 'pipe'] });
  const s = { sessionId: resume || '', pending: new Map(), turn: false, lastSignal: Date.now(), ended: false, reason: '', stderr: '', model: '' };
  const started = new Map(); // id da ferramenta -> { name, at }: para dizer quanto demorou cada comando
  const pendingList = () => [...s.pending.values()].map(({ id, tool, summary, input }) => ({ id, tool, summary, input: tool === 'AskUserQuestion' ? input : undefined }));

  const write = (obj) => {
    if (s.ended || !child.stdin.writable) return false;
    child.stdin.write(`${JSON.stringify(obj)}\n`);
    return true;
  };
  const respond = (requestId, response) => write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });

  async function onRequest(id, req) {
    const tool = String(req.tool_name || '');
    const input = req.input && typeof req.input === 'object' ? req.input : {};
    const summary = summaryOf(tool, input, show);
    let d;
    try {
      d = await decide({ tool, input });
    } catch (e) {
      d = { action: 'deny', message: `A plataforma não conseguiu decidir: ${e.message}` };
    }
    if (s.ended) return;
    if (d.action === 'allow') {
      respond(id, { behavior: 'allow', updatedInput: input });
      if (d.note) onEntry({ k: 'ok', a: tool, b: d.note });
    } else if (d.action === 'deny') {
      respond(id, { behavior: 'deny', message: d.message });
      onEntry({ k: 'deny', a: tool, b: summary, c: d.message });
    } else {
      s.pending.set(id, { id, tool, summary, input, req });
      onEntry({ k: 'ask', a: tool, b: summary });
      onPending(pendingList());
    }
  }

  const take = (line) => {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (!e || typeof e !== 'object') return;
    if (e.type === 'system' && e.subtype === 'init') {
      if (typeof e.session_id === 'string') s.sessionId = e.session_id;
      if (typeof e.model === 'string') s.model = e.model;
    }
    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      for (const block of e.message.content) {
        if (block.type === 'text' && String(block.text || '').trim()) onEntry({ k: 'say', a: String(block.text).trim().slice(0, 4000) });
        else if (block.type === 'tool_use' && block.name !== 'AskUserQuestion') {
          const b = summaryOf(block.name, block.input, show);
          started.set(block.id, { name: block.name, at: Date.now(), b });
          onEntry({ k: 'tool', a: String(block.name).slice(0, 30), b, id: String(block.id || '') });
        }
      }
    }
    // o que um comando de terminal devolveu, e quanto demorou
    if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const block of e.message.content) {
        if (block.type !== 'tool_result') continue;
        const t = started.get(block.tool_use_id);
        if (!t) continue;
        started.delete(block.tool_use_id);
        const raw = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '';
        // uma leitura recusada pelas regras do CLI (um documento tirado das entradas): a plataforma não a decidiu, mas mostra-a
        if (t.name === 'Read' && block.is_error && /denied|permission/i.test(raw)) onEntry({ k: 'deny', a: 'Read', b: t.b, c: 'Recusado: este documento foi tirado das entradas deste passo.' });
        if (t.name !== 'Bash') continue;
        const lines = String(raw).replace(/\s+$/, '').split('\n');
        const shown = lines.length > 40 ? [...lines.slice(0, 40), `… (mais ${lines.length - 40} linhas)`] : lines;
        onEntry({ k: 'result', id: String(block.tool_use_id), a: 'Bash', b: shown.join('\n').slice(0, 4000), err: Boolean(block.is_error), ms: Date.now() - t.at });
      }
    }
    if (e.type === 'result') {
      s.turn = false;
      if (typeof e.session_id === 'string') s.sessionId = e.session_id;
      const u = e.usage || {};
      const tokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].reduce((n, k) => n + (Number(u[k]) || 0), 0);
      onTurnEnd({ isError: Boolean(e.is_error), text: String(e.result || ''), tokens, sessionId: s.sessionId, model: s.model });
    }
    if (e.type === 'control_request' && e.request && typeof e.request_id === 'string') {
      if (e.request.subtype === 'can_use_tool') onRequest(e.request_id, e.request);
      else write({ type: 'control_response', response: { subtype: 'error', request_id: e.request_id, error: `A plataforma não trata ${String(e.request.subtype).slice(0, 60)}` } });
    }
    if (e.type === 'control_cancel_request' && typeof e.request_id === 'string' && s.pending.delete(e.request_id)) onPending(pendingList());
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

  const watchdog = setInterval(() => {
    // à espera de uma resposta da pessoa não conta: só quando o agente está a trabalhar e não diz nada
    if (!s.turn || s.pending.size || Date.now() - s.lastSignal < IDLE_MS) return;
    s.reason = `O Claude CLI ficou ${IDLE_MS / 60000} minutos sem dar sinal e foi parado.`;
    shell.killTree(child);
  }, 15000);

  const finish = (code, signal, error) => {
    if (s.ended) return;
    if (buffer.trim()) take(buffer);
    s.ended = true;
    clearInterval(watchdog);
    s.pending.clear();
    const said = s.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 400);
    const loggedOut = /not logged in|\/login/i.test(s.stderr);
    onEnd({ code, signal, reason: s.reason || error || (loggedOut ? 'O Claude CLI não tem sessão iniciada neste computador: abre um terminal, corre "claude" e faz /login.' : ''), stderr: said, sessionId: s.sessionId });
  };
  child.on('error', (e) => finish(null, null, `O Claude CLI não arrancou: ${e.message}`));
  child.on('close', (code, signal) => finish(code, signal, ''));

  return {
    get sessionId() { return s.sessionId; },
    get pending() { return pendingList(); },
    get working() { return s.turn; },
    // uma mensagem da pessoa (a primeira é o pedido do passo)
    send(text) {
      if (!write({ type: 'user', message: { role: 'user', content: String(text) }, parent_tool_use_id: null, session_id: s.sessionId || '' })) throw new Error('O agente já não está a correr');
      s.turn = true;
      s.lastSignal = Date.now();
    },
    // a resposta a um pedido: allow | always | deny; answers: as respostas a uma pergunta (AskUserQuestion)
    answer(requestId, choice, answers) {
      const p = s.pending.get(String(requestId));
      if (!p) throw new Error('Esse pedido já não está à espera de resposta');
      s.pending.delete(String(requestId));
      if (choice === 'deny') {
        respond(p.id, { behavior: 'deny', message: DENIED });
        onEntry({ k: 'deny', a: p.tool, b: p.summary, c: 'Recusado por ti' });
      } else if (p.tool === 'AskUserQuestion') {
        const given = {};
        for (const [q, a] of Object.entries(answers && typeof answers === 'object' ? answers : {})) {
          const v = Array.isArray(a) ? a.map((x) => String(x).slice(0, 2000)).join(', ') : String(a ?? '').slice(0, 2000);
          if (v) given[String(q).slice(0, 2000)] = v;
        }
        respond(p.id, { behavior: 'allow', updatedInput: { ...p.input, answers: given } });
        onEntry({ k: 'user', a: Object.entries(given).map(([q, a]) => `${q} → ${a}`).join('\n') || '(sem resposta)' });
      } else {
        const out = { behavior: 'allow', updatedInput: p.input };
        if (choice === 'always' && !p.req.suppress_always_allow_rule) out.updatedPermissions = sessionRules(p.req);
        respond(p.id, out);
        onEntry({ k: 'ok', a: p.tool, b: `${p.summary} · ${choice === 'always' ? 'permitido por ti nesta tarefa' : 'permitido por ti'}` });
      }
      onPending(pendingList());
    },
    // termina: a entrada fecha (o CLI acaba a volta e sai), à força passados uns segundos
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

module.exports = { readRule, startSession, summaryOf };
