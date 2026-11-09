// Agentes: os que a plataforma usa em cada passo, lidos das pastas onde já existem. Uma pasta pode ser um projeto
// (.claude/agents, .claude/skills, .github/agents, .github/skills) ou um pack com claude/ e copilot/. A plataforma
// lê só ficheiros agents/*.md e SKILL.md, e guarda em data/agents.json o caminho de cada um, o passo onde entra, a
// ordem dentro desse passo e se a sequência pára para aprovação depois dele.
//
// Um passo tem uma sequência de agentes: correm pela ordem, cada um quando o anterior termina. A plataforma não sabe
// o que cada um faz: dá-lhe as instruções do seu ficheiro, os documentos e o que os anteriores produziram.
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, newId } = require('./store');
const steps = require('./steps');

const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', '.idea', '.gradle', '.vscode', 'data']);
const MAX_DEPTH = 5;
const MAX_FILES = 4000;
const MAX_TEXT = 200 * 1024;

const file = (dataDir) => path.join(dataDir, 'agents.json');
const stepOk = (step) => (steps.ids().includes(step) ? step : '');
// o CLI que corre o agente: por omissão o da pasta de onde veio; a pessoa pode trocar (os ficheiros servem aos dois)
const RUNNERS = ['claude', 'copilot'];
const runnerOf = (a) => (RUNNERS.includes(a.runner) ? a.runner : a.tool === 'copilot' ? 'copilot' : 'claude');
const rank = (a) => (a.step ? steps.ids().indexOf(a.step) : 99);

// Todos, pela ordem dos passos e, dentro de cada passo, pela ordem da sequência
function list(dataDir) {
  const agents = readJson(file(dataDir), { agents: [] }).agents.filter((a) => a && a.id);
  return agents
    .map((a) => ({ ...a, step: stepOk(a.step), order: Number.isFinite(a.order) ? a.order : 0, pause: Boolean(a.pause), runner: runnerOf(a) }))
    .sort((a, b) => rank(a) - rank(b) || a.order - b.order || String(a.addedAt).localeCompare(String(b.addedAt)));
}
const saveList = (dataDir, agents) => writeJson(file(dataDir), { agents });
const get = (dataDir, id) => list(dataDir).find((a) => a.id === id) || null;

// A sequência de um passo: os agentes ligados a ele, pela ordem
const sequence = (dataDir, step) => list(dataDir).filter((a) => a.step === step);

// Renumera a ordem dentro de cada passo (0, 1, 2...), pela ordem em que estão na lista
function renumber(agents) {
  const next = {};
  for (const a of agents) {
    const k = a.step || '';
    next[k] = next[k] === undefined ? 0 : next[k] + 1;
    a.order = next[k];
  }
  return agents;
}

// O cabeçalho entre --- de um .md (name, description, tools, model) e o corpo
function frontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const head = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (pair) head[pair[1].toLowerCase()] = pair[2].trim().replace(/^["']|["']$/g, '');
  }
  return { head, body: m ? text.slice(m[0].length) : text };
}

const toolsOf = (head) => String(head.tools || head['allowed-tools'] || '').split(/[,\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 20);
const toolFor = (abs) => (/[\\/](\.github|copilot)[\\/]/i.test(abs) ? 'copilot' : 'claude');

// Percorre a pasta (até 5 níveis) à procura de agents/*.md e de SKILL.md
function scan(folder) {
  const root = path.resolve(String(folder || ''));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('Essa pasta não existe');
  const found = [];
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || seen > MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen++ > MAX_FILES) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const isAgent = /\.md$/i.test(e.name) && path.basename(dir).toLowerCase() === 'agents';
      const isSkill = e.name.toLowerCase() === 'skill.md';
      if (!isAgent && !isSkill) continue;
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8').slice(0, MAX_TEXT);
      } catch {
        continue;
      }
      const { head } = frontmatter(text);
      found.push({
        rel: path.relative(root, abs).replace(/\\/g, '/'),
        abs,
        kind: isAgent ? 'agent' : 'skill',
        name: String(head.name || (isAgent ? e.name.replace(/\.md$/i, '') : path.basename(dir))).slice(0, 80),
        description: String(head.description || '').slice(0, 300),
        tools: toolsOf(head),
        tool: toolFor(abs),
      });
    }
  };
  walk(root, 0);
  found.sort((a, b) => a.rel.localeCompare(b.rel));
  return { folder: root, found };
}

// Os itens escolhidos de uma leitura tornam-se agentes, no fim da sequência do passo escolhido. Uma skill vai com o
// agente do mesmo pack (<raiz>/agents/x.md e <raiz>/skills/<nome>/SKILL.md); sem agente, cada skill é um por si.
function add(dataDir, { folder, items, step }) {
  const { found } = scan(folder);
  const chosen = found.filter((f) => (items || []).includes(f.rel));
  if (!chosen.length) throw new Error('Escolhe pelo menos um ficheiro');
  const agentsIn = chosen.filter((c) => c.kind === 'agent');
  const skillsIn = chosen.filter((c) => c.kind === 'skill');
  const stepOf = stepOk(step);
  const made = [];
  const entry = (base, agentFile, skillFiles) => ({
    id: newId(),
    name: base.name,
    description: base.description,
    kind: agentFile ? 'agent' : 'skill',
    tool: base.tool,
    tools: base.tools,
    folder: path.resolve(folder),
    agentFile: agentFile || null,
    skillFiles: skillFiles.map((s) => s.abs),
    step: stepOf,
    order: 9999,
    pause: false,
    addedAt: new Date().toISOString(),
  });
  const rootOfAgent = (a) => path.dirname(path.dirname(a.abs));
  const rootOfSkill = (s) => path.dirname(path.dirname(path.dirname(s.abs)));
  const owned = new Set();
  for (const a of agentsIn) {
    const mine = skillsIn.filter((s) => rootOfSkill(s) === rootOfAgent(a));
    mine.forEach((s) => owned.add(s));
    made.push(entry(a, a.abs, mine));
  }
  for (const s of skillsIn) if (!owned.has(s)) made.push(entry(s, null, [s]));
  const all = [...list(dataDir), ...made].sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  saveList(dataDir, renumber(all));
  return made;
}

const isFileAt = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

// Lê de novo a pasta de um agente: o nome, a descrição e as ferramentas do ficheiro do agente (ou da skill), e as
// skills do pack (<raiz>/skills/*/SKILL.md) que nenhum outro agente usa; as que já não estão na pasta saem. As
// referências não se guardam: lêem-se do disco a cada listagem.
function refresh(dataDir, id) {
  const agents = list(dataDir);
  const me = agents.find((a) => a.id === id);
  if (!me) throw new Error('Esse agente já não existe');
  const main = me.agentFile || (me.skillFiles || [])[0];
  if (!main || !isFileAt(main)) throw new Error('O ficheiro do agente já não está na pasta');
  const { head } = frontmatter(fs.readFileSync(main, 'utf8').slice(0, MAX_TEXT));
  if (head.name) me.name = String(head.name).slice(0, 80);
  me.description = String(head.description || '').slice(0, 300);
  me.tools = toolsOf(head);
  const skills = (me.skillFiles || []).filter(isFileAt);
  if (me.agentFile) {
    const packSkills = path.join(path.dirname(path.dirname(me.agentFile)), 'skills');
    const taken = new Set(agents.filter((a) => a.id !== id).flatMap((a) => a.skillFiles || []));
    let entries = [];
    try {
      entries = fs.readdirSync(packSkills, { withFileTypes: true });
    } catch {
      // o pack não tem skills
    }
    for (const e of entries) {
      const f = path.join(packSkills, e.name, 'SKILL.md');
      if (e.isDirectory() && !taken.has(f) && !skills.includes(f) && isFileAt(f)) skills.push(f);
    }
  }
  me.skillFiles = skills;
  saveList(dataDir, agents);
  return { agent: me, files: filesOf(me).files.length };
}

// Passa um agente para outro passo (ou para nenhum), no fim da sequência desse passo
function setStep(dataDir, id, step) {
  const agents = list(dataDir);
  const me = agents.find((a) => a.id === id);
  if (!me) throw new Error('Esse agente já não existe');
  me.step = stepOk(step);
  me.order = 9999;
  agents.sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  saveList(dataDir, renumber(agents));
  return get(dataDir, id);
}

// Sobe (-1) ou desce (+1) um agente na sequência do seu passo
function move(dataDir, id, dir) {
  const agents = list(dataDir);
  const me = agents.find((a) => a.id === id);
  if (!me || !me.step) throw new Error('Esse agente não está em nenhum passo');
  const same = agents.filter((a) => a.step === me.step);
  const at = same.indexOf(me);
  const to = at + (dir < 0 ? -1 : 1);
  if (to < 0 || to >= same.length) return me;
  [same[at].order, same[to].order] = [same[to].order, same[at].order];
  saveList(dataDir, agents);
  return me;
}

function setPause(dataDir, id, pause) {
  const agents = list(dataDir);
  const me = agents.find((a) => a.id === id);
  if (!me) throw new Error('Esse agente já não existe');
  me.pause = Boolean(pause);
  saveList(dataDir, agents);
  return me;
}

// O modelo e as permissões escolhidos por último para um agente: o ponto de partida numa tarefa nova
function setDefaults(dataDir, id, { model, perm }) {
  const agents = list(dataDir);
  const me = agents.find((a) => a.id === id);
  if (!me) return null;
  me.model = model;
  me.perm = perm;
  saveList(dataDir, agents);
  return me;
}

// Troca o CLI que corre o agente; o modelo volta ao padrão (os nomes dos modelos não são os mesmos nos dois)
function setRunner(dataDir, id, runner) {
  const agents = list(dataDir);
  const me = agents.find((a) => a.id === id);
  if (!me) throw new Error('Esse agente já não existe');
  if (!RUNNERS.includes(runner)) throw new Error('CLI desconhecido');
  if (me.runner !== runner) me.model = '';
  me.runner = runner;
  saveList(dataDir, agents);
  return me;
}

function remove(dataDir, id) {
  saveList(dataDir, renumber(list(dataDir).filter((a) => a.id !== id)));
}

// O que o agente recebe como instruções: o corpo do seu .md e o das suas skills
function instructionsOf(agent) {
  const parts = [];
  const read = (f) => {
    try {
      return frontmatter(fs.readFileSync(f, 'utf8').slice(0, MAX_TEXT)).body.trim();
    } catch {
      return '';
    }
  };
  if (agent.agentFile) {
    const body = read(agent.agentFile);
    if (body) parts.push(`# Agente: ${agent.name}\n\n${body}`);
  }
  for (const s of agent.skillFiles || []) {
    const body = read(s);
    if (body) parts.push(`# Skill (${path.basename(path.dirname(s))})\n\n${body}`);
  }
  return parts.join('\n\n');
}

// Os ficheiros de um agente, para a página: o .md do agente, cada SKILL.md e o resto da pasta da skill (referências,
// modelos...), com o caminho relativo à pasta comum a todos eles
function filesOf(a) {
  const out = [];
  const isFile = (f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  };
  if (a.agentFile) out.push({ kind: 'agent', path: a.agentFile, missing: !isFile(a.agentFile) });
  for (const s of a.skillFiles || []) {
    out.push({ kind: 'skill', path: s, missing: !isFile(s) });
    const walk = (d, depth) => {
      if (depth > 3) return;
      let entries = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((x, y) => (x.isDirectory() - y.isDirectory()) || x.name.localeCompare(y.name, undefined, { numeric: true }));
      for (const e of entries) {
        if (e.name.startsWith('.') || SKIP.has(e.name) || out.length >= 80) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && p !== s) out.push({ kind: 'ref', path: p });
      }
    };
    walk(path.dirname(s), 0);
  }
  let base = null;
  for (const f of out) {
    const parts = path.dirname(f.path).split(path.sep);
    if (!base) { base = parts; continue; }
    let k = 0;
    while (k < base.length && k < parts.length && base[k] === parts[k]) k++;
    base = base.slice(0, k);
  }
  const baseDir = base && base.length ? base.join(path.sep) || path.sep : (a.folder || '');
  return { base: baseDir, files: out.map((f) => ({ ...f, rel: path.relative(baseDir, f.path).replace(/\\/g, '/') })) };
}

// Um ficheiro deste agente (ou a pasta comum), e só esses
function fileOf(dataDir, id, file) {
  const a = get(dataDir, String(id));
  if (!a) throw new Error('Esse agente já não existe');
  const f = filesOf(a);
  const want = String(file || '');
  if (want === f.base) return { a, path: f.base, rel: '' };
  const hit = f.files.find((x) => x.path === want);
  if (!hit) throw new Error('Esse ficheiro não é deste agente');
  return { a, path: hit.path, rel: hit.rel };
}

function register(ipcMain, { dataDir, dialog, getWindow, revealPath }) {
  const guard = (fn) => async (_, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  };
  // light: sem os ficheiros de cada agente (percorrer as pastas leva tempo; só a página Agentes os mostra)
  ipcMain.handle('agents:list', guard((light) => ({ agents: list(dataDir).map((a) => (light ? { ...a } : { ...a, ...filesOf(a) })), steps: steps.STEPS.map((s) => ({ id: s.id, name: s.name })) })));
  ipcMain.handle('agents:read-file', guard((id, file) => {
    const f = fileOf(dataDir, id, file);
    if (!f.rel) throw new Error('Isso é uma pasta');
    const size = fs.statSync(f.path).size;
    const buf = fs.readFileSync(f.path).slice(0, MAX_TEXT);
    if (buf.slice(0, 8192).includes(0)) return { name: f.rel, binary: true, size };
    return { name: f.rel, text: buf.toString('utf8'), size, truncated: size > MAX_TEXT };
  }));
  ipcMain.handle('agents:reveal', guard(async (id, file) => {
    const f = fileOf(dataDir, id, file);
    if (!fs.existsSync(f.path)) throw new Error('Já não existe');
    const why = await revealPath(f.path);
    if (why) throw new Error(why);
    return { ok: true };
  }));
  ipcMain.handle('agents:pick-folder', guard(async () => {
    const r = await dialog.showOpenDialog(getWindow(), { title: 'Pasta com agentes ou skills', properties: ['openDirectory'] });
    return { folder: r.canceled ? null : r.filePaths[0] };
  }));
  ipcMain.handle('agents:scan', guard((folder) => scan(folder)));
  ipcMain.handle('agents:add', guard((payload) => ({ added: add(dataDir, payload || {}) })));
  ipcMain.handle('agents:set-step', guard((id, step) => ({ agent: setStep(dataDir, String(id), String(step || '')) })));
  ipcMain.handle('agents:move', guard((id, dir) => ({ agent: move(dataDir, String(id), Number(dir)) })));
  ipcMain.handle('agents:set-pause', guard((id, pause) => ({ agent: setPause(dataDir, String(id), Boolean(pause)) })));
  ipcMain.handle('agents:remove', guard((id) => { remove(dataDir, String(id)); return { ok: true }; }));
  ipcMain.handle('agents:set-runner', guard((id, runner) => ({ agent: setRunner(dataDir, String(id), String(runner || '')) })));
  ipcMain.handle('agents:refresh', guard((id) => refresh(dataDir, String(id))));
}

module.exports = { register, list, get, sequence, setDefaults, instructionsOf, frontmatter, scan };
