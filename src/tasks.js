// Tarefas: um requisito ou um defeito, com os documentos de entrada que o descrevem e, passo a passo, o que os
// agentes fizeram. A plataforma não lê os documentos nem o código: guarda uma cópia dos documentos e entrega-os aos
// agentes de cada passo (pipeline.js). Uma pasta por tarefa em data/tasks/<id>:
//   task.json     a tarefa: dados, documentos, estado dos passos, branches criados e linha de tempo
//   documents/    a cópia dos documentos dados (ficheiros, pastas, texto colado)
//   steps/        o que cada agente de cada passo produziu e fez
//   tests/        os testes que o passo de testes escreve
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, newId } = require('./store');
const steps = require('./steps');
const pipeline = require('./pipeline');
const services = require('./services');
const { zip } = require('./zip');

const TYPES = ['requisito', 'defeito'];
const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', '.idea', '.gradle']);
const DOC_NOT_READABLE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|zip|7z|rar|msg|dotx?)$/i;
const FOLDER_FILES_MAX = 300;
const FOLDER_BYTES_MAX = 100 * 1024 * 1024;
const FILE_BYTES_MAX = 30 * 1024 * 1024;
const TEXT_MAX = 200 * 1024;
const MAX_EVENTS = 600;
const ID = /^[a-z0-9]{6,24}$/;

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const now = () => new Date().toISOString();

// -- ficheiros --
const safeName = (name) => String(name || 'documento').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'documento';
function uniqueIn(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let out = name;
  for (let i = 2; fs.existsSync(path.join(dir, out)); i++) out = `${base} (${i})${ext}`;
  return out;
}

// Copia uma pasta de documentos (sem ficheiros escondidos nem pastas de build), e diz o que copiou
function copyFolder(from, to) {
  let files = 0;
  let bytes = 0;
  const list = [];
  const walk = (src, dst, rel) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(path.join(src, e.name), path.join(dst, e.name), `${rel}${e.name}/`);
      } else if (e.isFile()) {
        const size = fs.statSync(path.join(src, e.name)).size;
        if (++files > FOLDER_FILES_MAX) throw new Error(`A pasta tem mais de ${FOLDER_FILES_MAX} ficheiros. Dá uma mais pequena, ou só os ficheiros que contam.`);
        bytes += size;
        if (bytes > FOLDER_BYTES_MAX) throw new Error('A pasta passa os 100 MB. Dá uma mais pequena.');
        fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
        list.push({ path: `${rel}${e.name}`, size, readable: !DOC_NOT_READABLE.test(e.name) });
      }
    }
  };
  walk(from, to, '');
  list.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { files, bytes, list };
}

// Os ficheiros de uma pasta de documentos já copiada (para as que foram juntas antes de se guardar esta lista)
function listCopied(dir) {
  const list = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (list.length >= FOLDER_FILES_MAX || e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
      else if (e.isFile()) list.push({ path: `${rel}${e.name}`, size: fs.statSync(path.join(d, e.name)).size, readable: !DOC_NOT_READABLE.test(e.name) });
    }
  };
  try {
    walk(dir, '');
  } catch {
    // a pasta já não está lá
  }
  return list.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

// O texto de um ficheiro para a pessoa ver: só texto, cortado
function readText(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, TEXT_MAX));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.slice(0, 8192).includes(0)) return { binary: true, size };
    return { text: buf.toString('utf8'), size, truncated: size > TEXT_MAX };
  } finally {
    fs.closeSync(fd);
  }
}

function excerptOf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(600);
    const n = fs.readSync(fd, buf, 0, 600, 0);
    fs.closeSync(fd);
    const text = buf.slice(0, n).toString('utf8');
    return /[\x00-\x08\x0e-\x1f]/.test(text) ? '' : text.replace(/\s+/g, ' ').trim().slice(0, 260);
  } catch {
    return '';
  }
}

// O estado da tarefa numa frase, a partir dos passos
function statusOf(t, flow) {
  const open = (t.alerts || []).filter((a) => !a.resolved && !a.dismissed);
  if (open.length) return { tone: 'bad', text: `Atenção: ${open[open.length - 1].repo} ${open[open.length - 1].kind === 'dirty' ? 'tem alterações por guardar' : 'precisa de ti'}` };
  if (!t.documents.length) return { tone: '', text: 'Sem documentos' };
  for (const def of steps.STEPS) {
    const p = flow[def.id];
    const cur = p.links && p.current !== null && p.current !== undefined ? p.links[p.current] : null;
    if (p.status === 'running') return cur && cur.status === 'waiting' ? { tone: 'warn', text: `${def.name}: ${cur.name} à tua espera` } : { tone: 'accent', text: `${def.name}: ${cur ? cur.name : 'a correr'}`, live: true };
    if (p.status === 'paused') return { tone: 'warn', text: `${def.name}: pausa para aprovares` };
    if (p.status === 'failed') return { tone: 'bad', text: `${def.name}: um agente parou` };
    if (p.status === 'interrupted') return { tone: 'warn', text: `${def.name}: interrompido` };
    if (p.status === 'stopped') return { tone: 'warn', text: `${def.name}: parado` };
  }
  const done = steps.STEPS.filter((d) => flow[d.id].status === 'done');
  if (done.length === steps.STEPS.length) return { tone: 'good', text: 'Concluída' };
  if (done.length) return { tone: '', text: `${done.map((d) => d.name).join(', ')} feito` };
  return { tone: '', text: 'Pronta para começar' };
}

function register(ipcMain, ctx) {
  const { dataDir, send, getWindow, dialog } = ctx;
  const tasksDir = path.join(dataDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const dirOf = (id) => {
    if (!ID.test(String(id))) throw new Error('Tarefa desconhecida');
    return path.join(tasksDir, String(id));
  };
  const load = (id) => {
    const t = readJson(path.join(dirOf(id), 'task.json'), null);
    if (!t) throw new Error('Essa tarefa já não existe');
    t.documents = t.documents || [];
    t.events = t.events || [];
    return t;
  };
  const save = (t) => {
    t.updatedAt = now();
    writeJson(path.join(dirOf(t.id), 'task.json'), t);
  };
  const changed = (id) => send('task-event', { taskId: id, type: 'task' });
  const event = (t, who, text) => {
    t.events.push({ at: now(), who, text: clip(text, 500) });
    if (t.events.length > MAX_EVENTS) t.events.splice(0, t.events.length - MAX_EVENTS);
  };

  const flow = pipeline.register(ipcMain, { dataDir, send, load, save, event, changed, dirOf });

  // Os documentos da tarefa que uma consola leu. As consolas só crescem: lê-se cada uma uma vez e, de cada vez que se
  // volta a perguntar, só o que lhe foi acrescentado (uma consola nova no mesmo sítio, de um passo corrido de novo,
  // lê-se do princípio).
  const readsCache = new Map();
  function readsOf(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return [];
    }
    const c = readsCache.get(file);
    if (c && c.ino === st.ino && c.size === st.size) return c.reads;
    const from = c && c.ino === st.ino && st.size > c.size ? c.size : 0;
    const reads = new Set(from ? c.reads : []);
    let text = '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(st.size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return c ? c.reads : [];
    }
    // só as linhas inteiras: a última pode estar a meio de ser escrita
    const end = text.lastIndexOf('\n') + 1;
    for (const line of text.slice(0, end).split('\n')) {
      if (!line.includes('"Read"') || !line.includes('tarefa/documents/')) continue;
      try {
        const e = JSON.parse(line);
        if (e.k === 'tool' && e.a === 'Read' && String(e.b).startsWith('tarefa/documents/')) reads.add(String(e.b).slice('tarefa/documents/'.length));
      } catch {
        // uma linha estragada não conta
      }
    }
    const done = { ino: st.ino, size: from + Buffer.byteLength(text.slice(0, end)), reads: [...reads] };
    readsCache.set(file, done);
    return done.reads;
  }

  // Que agentes leram cada documento: tirado das consolas dos agentes (cada Read de tarefa/documents/...), sem
  // abrir os documentos. { 'requisitos/RQ-002.md': ['implementador-ms', ...] }
  function usageOf(t) {
    const out = {};
    const stepsDir = path.join(dirOf(t.id), 'steps');
    for (const [step, p] of Object.entries(t.pipeline || {})) {
      let dirs = [];
      try {
        dirs = fs.readdirSync(path.join(stepsDir, step)).filter((d) => /^\d+-/.test(d));
      } catch {
        continue;
      }
      for (const d of dirs) {
        const link = (p.links || [])[Number(d.split('-')[0]) - 1];
        if (!link) continue;
        for (const rel of readsOf(path.join(stepsDir, step, d, 'console.jsonl'))) {
          out[rel] = out[rel] || [];
          if (!out[rel].includes(link.name)) out[rel].push(link.name);
        }
      }
    }
    return out;
  }

  // O ficheiro de um documento (ou de um ficheiro dentro de uma pasta de documentos), só dentro da cópia da tarefa
  function docFile(id, d, rel) {
    const base = path.join(dirOf(id), 'documents', d.rel);
    if (d.kind !== 'folder') return base;
    const file = path.resolve(base, String(rel || ''));
    if (file !== base && !file.startsWith(base + path.sep)) throw new Error('Esse ficheiro não está nesta pasta');
    return file;
  }

  // light: para a lista de tarefas, sem o que só a página de uma tarefa mostra (o uso dos documentos, os ficheiros das pastas)
  const view = (t, light = false) => {
    const f = flow.viewOf(t);
    return {
      ...t,
      documents: light ? t.documents : t.documents.map((d) => (d.kind === 'folder' && !d.files ? { ...d, files: listCopied(path.join(dirOf(t.id), 'documents', d.rel)) } : d)),
      flow: f,
      stepDefs: steps.STEPS.map((s) => ({ id: s.id, name: s.name, summary: s.summary, branch: Boolean(s.branch), freeze: Boolean(s.freeze), runnable: s.runnable })),
      branch: t.branch || flow.branchFor(t),
      docsDir: path.join(dirOf(t.id), 'documents'),
      docUsage: light ? {} : usageOf(t),
      status: statusOf(t, f),
      running: pipeline.isRunning(t.id),
    };
  };

  // -- documentos --
  // dest: para onde vão (por omissão, os documentos da tarefa; ou os juntos só a um passo, stepDest)
  const taskDest = (t) => ({ dir: path.join(dirOf(t.id), 'documents'), list: t.documents, label: 'Documento junto' });
  function stepDest(t, step) {
    const def = steps.get(step);
    if (!def) throw new Error('Passo desconhecido');
    t.inputs = t.inputs || {};
    t.inputs[step] = t.inputs[step] || { off: [], extra: [] };
    t.inputs[step].extra = t.inputs[step].extra || [];
    return { dir: flow.extraDir(t.id, step), list: t.inputs[step].extra, label: `Junto ao passo ${def.name}` };
  }
  function addDocuments(t, { files = [], folders = [], text = null }, dest = taskDest(t)) {
    const docsDir = dest.dir;
    fs.mkdirSync(docsDir, { recursive: true });
    const added = [];
    for (const f of files) {
      const stat = fs.statSync(String(f));
      if (!stat.isFile()) throw new Error(`${path.basename(String(f))} não é um ficheiro`);
      if (stat.size > FILE_BYTES_MAX) throw new Error(`${path.basename(String(f))} passa os 30 MB`);
      const name = uniqueIn(docsDir, safeName(path.basename(String(f))));
      fs.copyFileSync(String(f), path.join(docsDir, name));
      added.push({ id: newId(), kind: 'file', name, rel: name, size: stat.size, readable: !DOC_NOT_READABLE.test(name), excerpt: excerptOf(path.join(docsDir, name)), addedAt: now() });
    }
    for (const f of folders) {
      if (!fs.statSync(String(f)).isDirectory()) throw new Error(`${path.basename(String(f))} não é uma pasta`);
      const name = uniqueIn(docsDir, safeName(path.basename(String(f))));
      const { files: n, bytes, list } = copyFolder(String(f), path.join(docsDir, name));
      added.push({ id: newId(), kind: 'folder', name: `${name}/`, rel: name, size: bytes, count: n, files: list, readable: true, excerpt: '', addedAt: now() });
    }
    if (text && clip(text.content, 1)) {
      const name = uniqueIn(docsDir, `${safeName(text.name || 'texto colado').replace(/\.md$/i, '')}.md`);
      const content = String(text.content).slice(0, TEXT_MAX);
      fs.writeFileSync(path.join(docsDir, name), content);
      added.push({ id: newId(), kind: 'text', name, rel: name, size: Buffer.byteLength(content), readable: true, excerpt: clip(content.replace(/\s+/g, ' '), 260), addedAt: now() });
    }
    dest.list.push(...added);
    for (const d of added) event(t, 'user', `${dest.label}: ${d.name}${d.readable ? '' : ' (o agente não lê este formato)'}`);
    return added;
  }

  // Documentos que chegam com o conteúdo e não com um caminho: arrastados ou colados na página (o browser não dá o
  // caminho de um ficheiro, só o que tem). files: [{ name, data }]; folders: [{ name, files: [{ path, data }] }];
  // data em base64. As mesmas regras que ao copiar do disco: sem ficheiros escondidos nem pastas de build, com limites.
  function addUploaded(t, { files = [], folders = [] }, dest = taskDest(t)) {
    const docsDir = dest.dir;
    fs.mkdirSync(docsDir, { recursive: true });
    const added = [];
    const bytesOf = (f) => Buffer.from(String((f && f.data) || ''), 'base64');
    for (const f of files.slice(0, 50)) {
      const buf = bytesOf(f);
      if (buf.length > FILE_BYTES_MAX) throw new Error(`${f.name} passa os 30 MB`);
      const name = uniqueIn(docsDir, safeName(f.name));
      fs.writeFileSync(path.join(docsDir, name), buf);
      added.push({ id: newId(), kind: 'file', name, rel: name, size: buf.length, readable: !DOC_NOT_READABLE.test(name), excerpt: excerptOf(path.join(docsDir, name)), addedAt: now() });
    }
    for (const folder of folders.slice(0, 10)) {
      const name = uniqueIn(docsDir, safeName(folder.name));
      const base = path.join(docsDir, name);
      const list = [];
      let bytes = 0;
      for (const f of (folder.files || [])) {
        // o caminho dentro da pasta, só com nomes limpos: nada de .., nada escondido, nada de pastas de build
        const parts = String(f.path || '').split(/[\\/]+/).filter(Boolean);
        if (!parts.length || parts.some((p) => p === '..' || p.startsWith('.') || SKIP.has(p))) continue;
        if (list.length >= FOLDER_FILES_MAX) throw new Error(`A pasta ${folder.name} tem mais de ${FOLDER_FILES_MAX} ficheiros`);
        const buf = bytesOf(f);
        bytes += buf.length;
        if (bytes > FOLDER_BYTES_MAX) throw new Error(`A pasta ${folder.name} passa os 100 MB`);
        const rel = parts.map(safeName);
        fs.mkdirSync(path.join(base, ...rel.slice(0, -1)), { recursive: true });
        fs.writeFileSync(path.join(base, ...rel), buf);
        list.push({ path: rel.join('/'), size: buf.length, readable: !DOC_NOT_READABLE.test(rel[rel.length - 1]) });
      }
      if (!list.length) continue;
      list.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
      added.push({ id: newId(), kind: 'folder', name: `${name}/`, rel: name, size: bytes, count: list.length, files: list, readable: true, excerpt: '', addedAt: now() });
    }
    dest.list.push(...added);
    for (const d of added) event(t, 'user', `${dest.label}: ${d.name}${d.readable ? '' : ' (o agente não lê este formato)'}`);
    return added;
  }

  const guard = (fn) => async (_, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  };
  const notWhileRunning = (id) => {
    if (pipeline.isRunning(id)) throw new Error('Espera que o agente acabe (ou pára-o) para mudar os documentos');
  };

  ipcMain.handle('tasks:list', guard(() => {
    const out = [];
    for (const name of fs.readdirSync(tasksDir)) {
      if (!ID.test(name)) continue;
      const t = readJson(path.join(tasksDir, name, 'task.json'), null);
      if (!t) continue;
      t.documents = t.documents || [];
      t.events = t.events || [];
      const v = view(t, true);
      out.push({ id: v.id, ref: v.ref, title: v.title, type: v.type, documents: v.documents.length, updatedAt: v.updatedAt, status: v.status, steps: Object.fromEntries(Object.entries(v.flow).map(([k, p]) => [k, p.status])), docsOk: v.documents.length > 0 });
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { tasks: out };
  }));

  ipcMain.handle('tasks:get', guard((id) => ({ task: view(load(id)) })));

  ipcMain.handle('tasks:create', guard((p) => {
    const given = p && typeof p === 'object' ? p : {};
    const title = clip(given.title, 200);
    if (!title) throw new Error('Dá um título à tarefa');
    const id = newId();
    fs.mkdirSync(dirOf(id), { recursive: true });
    const t = { id, ref: clip(given.ref, 40), title, type: TYPES.includes(given.type) ? given.type : 'requisito', createdAt: now(), updatedAt: now(), documents: [], pipeline: {}, events: [] };
    event(t, 'user', `Tarefa criada${t.ref ? ` (${t.ref})` : ''}`);
    try {
      addDocuments(t, { files: given.files || [], folders: given.folders || [], text: given.text || null });
    } catch (e) {
      fs.rmSync(dirOf(id), { recursive: true, force: true });
      throw e;
    }
    save(t);
    return { task: view(t) };
  }));

  ipcMain.handle('tasks:pick-files', guard(async () => {
    const r = await dialog.showOpenDialog(getWindow(), { title: 'Documentos da tarefa', properties: ['openFile', 'multiSelections'] });
    return { files: r.canceled ? [] : r.filePaths };
  }));
  ipcMain.handle('tasks:pick-folder', guard(async () => {
    const r = await dialog.showOpenDialog(getWindow(), { title: 'Pasta de documentos', properties: ['openDirectory'] });
    return { folder: r.canceled ? null : r.filePaths[0] };
  }));

  ipcMain.handle('tasks:add-documents', guard((id, p) => {
    notWhileRunning(id);
    const t = load(id);
    const given = p && typeof p === 'object' ? p : {};
    addDocuments(t, { files: given.files || [], folders: given.folders || [], text: given.text || null });
    save(t);
    changed(id);
    return { task: view(t) };
  }));

  ipcMain.handle('tasks:upload-documents', guard((id, p) => {
    notWhileRunning(id);
    const t = load(id);
    const given = p && typeof p === 'object' ? p : {};
    const added = [...addUploaded(t, { files: given.files || [], folders: given.folders || [] }), ...addDocuments(t, { text: given.text || null })];
    if (!added.length) throw new Error('Não havia nada para juntar');
    save(t);
    changed(id);
    return { task: view(t), added: added.map((d) => d.name) };
  }));

  // Documentos juntos só a um passo: do disco (caminhos) ou arrastados e colados (conteúdo)
  ipcMain.handle('tasks:add-step-inputs', guard((id, step, p) => {
    notWhileRunning(id);
    const t = load(id);
    const given = p && typeof p === 'object' ? p : {};
    const added = addDocuments(t, { files: given.files || [], folders: given.folders || [], text: given.text || null }, stepDest(t, String(step)));
    save(t);
    changed(id);
    return { added: added.map((d) => d.name) };
  }));
  ipcMain.handle('tasks:upload-step-inputs', guard((id, step, p) => {
    notWhileRunning(id);
    const t = load(id);
    const given = p && typeof p === 'object' ? p : {};
    const dest = stepDest(t, String(step));
    const added = [...addUploaded(t, { files: given.files || [], folders: given.folders || [] }, dest), ...addDocuments(t, { text: given.text || null }, dest)];
    if (!added.length) throw new Error('Não havia nada para juntar');
    save(t);
    changed(id);
    return { added: added.map((d) => d.name) };
  }));
  ipcMain.handle('tasks:remove-step-input', guard((id, step, extraId) => {
    notWhileRunning(id);
    const t = load(id);
    const dest = stepDest(t, String(step));
    const d = dest.list.find((x) => x.id === extraId);
    if (!d) throw new Error('Esse documento já não existe');
    fs.rmSync(path.join(dest.dir, d.rel), { recursive: true, force: true });
    t.inputs[step].extra = dest.list.filter((x) => x.id !== extraId);
    t.inputs[step].off = (t.inputs[step].off || []).filter((k) => k !== `extra:${extraId}` && !k.startsWith(`extra:${extraId}:`));
    event(t, 'user', `Tirado do passo ${steps.get(step).name}: ${d.name}`);
    save(t);
    changed(id);
    return { ok: true };
  }));

  // Os microserviços escolhidos para a tarefa (o passo Microserviços): vão no pedido a cada agente. Vazio: os agentes
  // decidem sozinhos, como as skills dizem.
  ipcMain.handle('tasks:set-services', guard((id, names) => {
    notWhileRunning(id);
    const t = load(id);
    const known = new Set(services.list(dataDir).map((s) => s.name));
    const before = t.chosenServices || [];
    const given = [...new Set((Array.isArray(names) ? names : []).map(String))].filter((n) => known.has(n) || before.includes(n)).slice(0, 200);
    t.chosenServices = given.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    event(t, 'user', t.chosenServices.length ? `Microserviços escolhidos: ${t.chosenServices.join(', ')}` : 'Sem microserviços escolhidos: os agentes decidem');
    save(t); // sem avisar: a página que o mudou já o mostra
    return { chosenServices: t.chosenServices };
  }));

  ipcMain.handle('tasks:remove-document', guard((id, docId) => {
    notWhileRunning(id);
    const t = load(id);
    const d = t.documents.find((x) => x.id === docId);
    if (!d) throw new Error('Esse documento já não existe');
    fs.rmSync(path.join(dirOf(id), 'documents', d.rel), { recursive: true, force: true });
    t.documents = t.documents.filter((x) => x.id !== docId);
    event(t, 'user', `Documento tirado: ${d.name}`);
    save(t);
    changed(id);
    return { task: view(t) };
  }));

  // O texto de um documento, ou de um ficheiro dentro de uma pasta de documentos, para a pessoa o ver
  ipcMain.handle('tasks:read-document', guard((id, docId, rel) => {
    const t = load(id);
    const d = t.documents.find((x) => x.id === docId);
    if (!d) throw new Error('Esse documento já não existe');
    const base = path.join(dirOf(id), 'documents', d.rel);
    const file = d.kind === 'folder' ? path.resolve(base, String(rel || '')) : base;
    if (d.kind === 'folder' && file !== base && !file.startsWith(base + path.sep)) throw new Error('Esse ficheiro não está nesta pasta');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Esse ficheiro já não existe');
    return { name: d.kind === 'folder' ? `${d.name}${String(rel)}` : d.name, ...readText(file) };
  }));

  // Tira um ficheiro de uma pasta de documentos: só da cópia da plataforma (o original fica onde estava). Uma pasta que
  // fica sem ficheiros sai da tarefa.
  ipcMain.handle('tasks:remove-document-file', guard((id, docId, rel) => {
    notWhileRunning(id);
    const t = load(id);
    const d = t.documents.find((x) => x.id === docId);
    if (!d || d.kind !== 'folder') throw new Error('Essa pasta já não existe');
    const base = path.join(dirOf(id), 'documents', d.rel);
    const file = path.resolve(base, String(rel || ''));
    if (!file.startsWith(base + path.sep)) throw new Error('Esse ficheiro não está nesta pasta');
    const files = d.files || listCopied(base);
    const entry = files.find((f) => f.path === String(rel));
    if (!entry) throw new Error('Esse ficheiro já não está na pasta');
    fs.rmSync(file, { force: true });
    d.files = files.filter((f) => f !== entry);
    d.count = d.files.length;
    d.size = Math.max(0, d.size - entry.size);
    if (!d.files.length) {
      fs.rmSync(base, { recursive: true, force: true });
      t.documents = t.documents.filter((x) => x.id !== docId);
      event(t, 'user', `Ficheiro tirado: ${d.name}${entry.path}. A pasta ${d.name} ficou vazia e saiu da tarefa`);
    } else {
      event(t, 'user', `Ficheiro tirado: ${d.name}${entry.path}`);
    }
    save(t);
    changed(id);
    return { task: view(t) };
  }));

  // Mostra a cópia de um documento no Finder (no Explorador, no Windows)
  ipcMain.handle('tasks:reveal-document', guard(async (id, docId, rel) => {
    const t = load(id);
    const d = t.documents.find((x) => x.id === docId);
    if (!d) throw new Error('Esse documento já não existe');
    const file = docFile(id, d, rel);
    if (!fs.existsSync(file)) throw new Error('Esse ficheiro já não existe');
    const why = await ctx.revealPath(file);
    if (why) throw new Error(why);
    return { ok: true };
  }));

  // O conteúdo de um documento para descarregar: um ficheiro tal como está, ou uma pasta num zip
  ipcMain.handle('tasks:document-bytes', guard((id, docId, rel) => {
    const t = load(id);
    const d = t.documents.find((x) => x.id === docId);
    if (!d) throw new Error('Esse documento já não existe');
    if (d.kind === 'folder' && !rel) {
      const base = path.join(dirOf(id), 'documents', d.rel);
      const files = (d.files || listCopied(base));
      const top = d.name.replace(/\/$/, '');
      const entries = files.map((f) => ({ name: `${top}/${f.path}`, data: fs.readFileSync(path.join(base, ...f.path.split('/'))) }));
      return { name: `${top}.zip`, type: 'application/zip', data: zip(entries).toString('base64') };
    }
    const file = docFile(id, d, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Esse ficheiro já não existe');
    return { name: path.basename(file), type: 'application/octet-stream', data: fs.readFileSync(file).toString('base64') };
  }));

  // Substitui um documento (ou um ficheiro de uma pasta) por uma versão nova, com o mesmo nome
  ipcMain.handle('tasks:replace-document', guard((id, docId, rel, p) => {
    notWhileRunning(id);
    const t = load(id);
    const d = t.documents.find((x) => x.id === docId);
    if (!d) throw new Error('Esse documento já não existe');
    const buf = Buffer.from(String((p && p.data) || ''), 'base64');
    if (!buf.length) throw new Error('O ficheiro novo está vazio');
    if (buf.length > FILE_BYTES_MAX) throw new Error('O ficheiro novo passa os 30 MB');
    const file = docFile(id, d, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Esse ficheiro já não existe');
    const before = fs.statSync(file).size;
    fs.writeFileSync(file, buf);
    if (d.kind === 'folder') {
      const files = d.files || listCopied(path.join(dirOf(id), 'documents', d.rel));
      const entry = files.find((f) => f.path === String(rel));
      if (entry) entry.size = buf.length;
      d.files = files;
      d.size = Math.max(0, d.size - before + buf.length);
    } else {
      d.size = buf.length;
      d.excerpt = excerptOf(file);
    }
    d.replacedAt = now();
    event(t, 'user', `Documento substituído por uma versão nova: ${d.kind === 'folder' ? `${d.name}${rel}` : d.name}`);
    save(t);
    changed(id);
    return { task: view(t) };
  }));

  // Junta ficheiros a uma pasta que já está na tarefa (no topo da pasta)
  ipcMain.handle('tasks:add-to-folder', guard((id, docId, files) => {
    notWhileRunning(id);
    const t = load(id);
    const d = t.documents.find((x) => x.id === docId);
    if (!d || d.kind !== 'folder') throw new Error('Essa pasta já não existe');
    const base = path.join(dirOf(id), 'documents', d.rel);
    const list = d.files || listCopied(base);
    const added = [];
    for (const f of (Array.isArray(files) ? files : []).slice(0, 50)) {
      const buf = Buffer.from(String((f && f.data) || ''), 'base64');
      if (buf.length > FILE_BYTES_MAX) throw new Error(`${f.name} passa os 30 MB`);
      if (list.length >= FOLDER_FILES_MAX) throw new Error(`A pasta passa os ${FOLDER_FILES_MAX} ficheiros`);
      const name = uniqueIn(base, safeName(f.name));
      fs.writeFileSync(path.join(base, name), buf);
      list.push({ path: name, size: buf.length, readable: !DOC_NOT_READABLE.test(name) });
      d.size += buf.length;
      added.push(name);
    }
    if (!added.length) throw new Error('Não havia nada para juntar');
    list.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    d.files = list;
    d.count = list.length;
    event(t, 'user', `Ficheiros juntos a ${d.name}: ${added.join(', ')}`);
    save(t);
    changed(id);
    return { task: view(t), added };
  }));

  // Mudar o nome da tarefa: só o título (a referência e o tipo ficam). Não com um agente a trabalhar: a sequência
  // guarda a tarefa enquanto corre e podia repor o nome antigo.
  ipcMain.handle('tasks:rename', guard((id, title) => {
    if (pipeline.isRunning(String(id))) throw new Error('Espera que o agente acabe (ou pára-o) para mudar o nome');
    const t = load(id);
    const next = clip(title, 200);
    if (!next) throw new Error('Dá um nome à tarefa');
    if (next !== t.title) {
      event(t, 'user', `Nome mudado: ${t.title} → ${next}`);
      t.title = next;
      save(t); // sem avisar: a página que o mudou já o mostra
    }
    return { title: t.title };
  }));

  ipcMain.handle('tasks:remove', guard((id) => {
    if (pipeline.isRunning(String(id))) throw new Error('Pára primeiro o agente que está a correr nesta tarefa');
    fs.rmSync(dirOf(id), { recursive: true, force: true });
    return { ok: true };
  }));
}

module.exports = { register, stopAll: pipeline.stopAll };
