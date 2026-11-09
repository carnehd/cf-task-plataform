// A sequência de agentes de um passo, numa tarefa. Cada agente corre numa sessão sua (session.js), na pasta raiz dos
// microserviços, com as regras do passo (policy.js); quando termina, começa o seguinte. A plataforma não sabe o que
// cada um faz: dá-lhe os documentos da tarefa e o que os anteriores produziram, e guarda o que ele produz.
//
// Um agente dá o trabalho por terminado escrevendo FEITO.md na sua pasta de resultados. Se parar sem o escrever
// (fez uma pergunta, ou espera uma decisão), a sequência espera pela pessoa, que lhe responde ou o dá por terminado.
// Depois de um agente marcado com pausa, a sequência espera que a pessoa a deixe continuar.
//
// Em data/tasks/<id>/steps/<passo>/<n>-<agente>/: outputs/ (o que o agente produziu) e console.jsonl (o que fez).
// O estado fica em task.pipeline[passo]; os branches criados, em task.git.
const fs = require('fs');
const path = require('path');
const shell = require('./shell');
const git = require('./git');
const steps = require('./steps');
const agents = require('./agents');
const settings = require('./settings');
const services = require('./services');
const { startSession } = require('./session');
const { startCopilotSession, copilotModels } = require('./copilot-session');
const { makePolicy, real, inRepoTests } = require('./policy');
const { newId } = require('./store');

const TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'TodoWrite', 'AskUserQuestion'];
const DONE_FILE = 'FEITO.md';
// os modelos que a pessoa pode escolher ('' é o que o Claude CLI usa por omissão) e os modos de permissão
const MODELS = ['', 'fable', 'opus', 'sonnet', 'haiku'];
const PERMS = ['ask', 'read', 'all', 'plan'];
const TEXT_MAX = 200 * 1024;
const CONSOLE_SHOWN = 1500;
// cada agente corre no CLI de onde veio: o Claude Code ou o Copilot CLI
const CLI = { claude: { name: 'claude', label: 'Claude CLI' }, copilot: { name: 'copilot', label: 'Copilot CLI' } };
const cliOf = (agent) => CLI[agent && (agent.runner || agent.tool) === 'copilot' ? 'copilot' : 'claude'];
// um modelo serve ao CLI do agente? (os do Claude são os nomes curtos; os do Copilot, os nomes do Copilot CLI)
const modelFits = (agent, m) => (cliOf(agent).name === 'copilot' ? m === '' || (COPILOT_MODEL.test(String(m || '')) && !MODELS.includes(m)) : MODELS.includes(m));
// um modelo do Copilot: o nome que o Copilot CLI aceita (ou auto)
const COPILOT_MODEL = /^[a-z0-9][a-z0-9.-]{0,60}$/i;
const active = new Map(); // id da tarefa -> { step, index, session }: só um agente de cada vez por tarefa

const now = () => new Date().toISOString();
const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agente';
const branchFor = (t) => `feature/${t.ref ? String(t.ref).replace(/[^A-Za-z0-9._-]+/g, '-') : slug(t.title)}`;

function filesIn(dir, max = 300) {
  const out = [];
  const walk = (d, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max || e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
      else if (e.isFile()) out.push({ path: `${rel}${e.name}`, size: fs.statSync(path.join(d, e.name)).size });
    }
  };
  walk(dir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

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

// O estado de todos os repositórios Git da pasta raiz: o commit e as alterações por guardar. Com repoTests, as
// alterações nas pastas de testes dos microserviços não contam (o passo pode escrever lá).
async function snapshot(root, repoTests = null) {
  const out = {};
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const dir = path.join(root, e.name);
    if (e.name.startsWith('.') || !e.isDirectory() || !git.isRepo(dir)) continue;
    try {
      let dirty = (await git.dirty(dir)).sort();
      if (repoTests) dirty = dirty.filter((l) => !inRepoTests(dir, path.join(dir, l.slice(3).split(' -> ').pop().replace(/\/$/, ''), '_'), repoTests));
      out[e.name] = { head: await git.head(dir), dirty };
    } catch {
      // um repositório que não responde fica de fora
    }
  }
  return out;
}

function register(ipcMain, h) {
  const { dataDir } = h;
  const stepDir = (id, step) => path.join(h.dirOf(id), 'steps', step);
  const linkDir = (id, step, i, link) => path.join(stepDir(id, step), `${i + 1}-${slug(link.name)}`);
  const outputsOf = (id, step, i, link) => path.join(linkDir(id, step, i, link), 'outputs');
  const testsDir = (id) => path.join(h.dirOf(id), 'tests');

  const tell = (payload) => h.send('task-event', payload);
  const log = (id, step, i, link, entry) => {
    const line = { at: now(), ...entry };
    try {
      fs.mkdirSync(linkDir(id, step, i, link), { recursive: true });
      fs.appendFileSync(path.join(linkDir(id, step, i, link), 'console.jsonl'), `${JSON.stringify(line)}\n`);
    } catch {
      // a página recebe na mesma
    }
    tell({ taskId: id, type: 'log', step, index: i, entry: line });
  };
  const saveAndTell = (t) => {
    h.save(t);
    h.changed(t.id);
  };

  // -- o branch da tarefa, num microserviço, antes da primeira escrita do agente nele (um de cada vez por tarefa) --
  const locks = new Map();
  function prepareRepo(id, dir, name) {
    const prev = locks.get(id) || Promise.resolve();
    const next = prev.then(() => prepareNow(id, dir, name), () => prepareNow(id, dir, name));
    locks.set(id, next.catch(() => ''));
    return next;
  }
  // Uma recusa que a pessoa tem de resolver: fica como alerta na tarefa (um por microserviço e motivo, sem repetir
  // quando o agente tenta outra vez), salta na página, e entra na linha de tempo
  function raise(id, alert) {
    const t = h.load(id);
    const a = active.get(id);
    t.alerts = t.alerts || [];
    const same = t.alerts.find((x) => !x.resolved && !x.dismissed && x.repo === alert.repo && x.kind === alert.kind);
    if (same) {
      Object.assign(same, { at: now(), text: alert.text, files: alert.files || same.files, count: (same.count || 1) + 1 });
    } else {
      t.alerts.push({ id: newId(), at: now(), step: a ? a.step : '', index: a ? a.index : null, count: 1, resolved: false, dismissed: false, ...alert });
      h.event(t, 'app', `Recusado: ${alert.text}`);
    }
    if (t.alerts.length > 50) t.alerts.splice(0, t.alerts.length - 50);
    h.save(t);
    tell({ taskId: id, type: 'alert', alert: same || t.alerts[t.alerts.length - 1] });
    h.changed(id);
  }
  const forAgent = (text) => `${text} A plataforma mostrou um alerta à pessoa. Diz-lhe o que aconteceu e espera que te diga para tentar de novo.`;

  // Num passo com o código congelado, a plataforma pode pôr um microserviço no branch da tarefa (para lá escrever os
  // testes): esse novo commit não conta como "o código mudou"
  function noteMoved(id, name, headNow) {
    const a = active.get(id);
    if (!a) return;
    const t = h.load(id);
    const p = t.pipeline && t.pipeline[a.step];
    if (!p || !p.freeze) return;
    p.freeze.moved = { ...(p.freeze.moved || {}), [name]: headNow };
    h.save(t);
  }

  async function prepareNow(id, dir, name) {
    let t = h.load(id);
    const rec = t.git && t.git.repos && t.git.repos[name];
    if (!git.isRepo(dir)) {
      const text = `${name} não é um repositório Git: a plataforma só deixa alterar microserviços com Git, para os poder pôr no branch da tarefa.`;
      raise(id, { repo: name, kind: 'not-git', text });
      return forAgent(text);
    }
    const cur = await git.branch(dir);
    if (rec) {
      if (cur === rec.branch) return '';
      const changed = await git.dirty(dir);
      if (changed.length) {
        const text = `${name} saiu do branch ${rec.branch} (está em ${cur}) e tem ${changed.length} alteração(ões) por guardar.`;
        raise(id, { repo: name, kind: 'moved', text, files: changed.slice(0, 20).map((l) => l.slice(3)) });
        return forAgent(text);
      }
      await git.checkout(dir, rec.branch);
      noteMoved(id, name, await git.head(dir));
      return '';
    }
    const branch = t.branch || branchFor(t);
    const dirty = await git.dirty(dir);
    if (dirty.length) {
      const text = `${name} tem ${dirty.length} alteração(ões) por guardar, no branch ${cur}. A plataforma não mexe no trabalho de ninguém, por isso recusou que o agente o alterasse.`;
      raise(id, { repo: name, kind: 'dirty', text, files: dirty.slice(0, 20).map((l) => l.slice(3)), total: dirty.length });
      return forAgent(text);
    }
    if (await git.branchExists(dir, branch)) {
      const text = `O branch ${branch} já existe em ${name}. Muda o nome do branch da tarefa, ou apaga esse branch.`;
      raise(id, { repo: name, kind: 'branch-exists', text });
      return forAgent(text);
    }
    const base = await git.head(dir);
    await git.createBranch(dir, branch);
    t = h.load(id);
    t.branch = branch;
    t.git = t.git || { repos: {} };
    t.git.repos = t.git.repos || {};
    t.git.repos[name] = { branch, base, from: cur, at: now() };
    h.event(t, 'app', `${name}: branch ${branch} criado a partir de ${cur}`);
    saveAndTell(t);
    return '';
  }

  // -- as entradas de um passo: os documentos que os agentes recebem --
  // Por omissão, todos: os documentos da tarefa e o que os passos anteriores produziram. A pessoa pode tirar e voltar a
  // pôr cada ficheiro (fica em task.inputs[passo].off) e juntar documentos só a este passo (em inputs/<passo>/ da
  // tarefa, fora de steps/, para não irem com uma execução antiga). Cada ficheiro tem uma chave:
  //   doc:<id>[:<caminho na pasta>]   um documento da tarefa
  //   out:<passo>:<n>:<caminho>        um ficheiro produzido pelo agente n de um passo anterior
  //   extra:<id>[:<caminho na pasta>]  um documento junto só a este passo
  const extraDir = (id, step) => path.join(h.dirOf(id), 'inputs', step);
  function inputsOf(id, t, step) {
    const def = steps.get(step);
    const conf = (t.inputs && t.inputs[step]) || {};
    const off = new Set(conf.off || []);
    const item = (key, name, abs, size, readable = true) => ({ key, name, abs, size, readable, on: !off.has(key) });
    const setsOf = (list, base, prefix) => list.map((d) => {
      const dir = path.join(base, d.rel);
      if (d.kind !== 'folder') return { title: null, items: [item(`${prefix}:${d.id}`, d.name, dir, d.size, d.readable !== false)] };
      const files = filesIn(dir, 300);
      return { title: d.name, items: files.map((f) => item(`${prefix}:${d.id}:${f.path}`, f.path, path.join(dir, f.path), f.size, !/\.(docx?|xlsx?|pptx?|odt|ods|odp|zip|7z|rar|msg|dotx?)$/i.test(f.path))) };
    }).filter((s) => s.items.length);
    const groups = [{ kind: 'docs', title: 'Documentos da tarefa', note: 'Do separador Documentos.', sets: setsOf(t.documents || [], path.join(h.dirOf(id), 'documents'), 'doc') }];
    for (const from of def.from) {
      const p = t.pipeline && t.pipeline[from];
      if (!p) continue;
      const sets = p.links.map((l, n) => {
        const dir = outputsOf(id, from, n, l);
        return { title: l.name, items: filesIn(dir, 60).map((f) => item(`out:${from}:${n}:${f.path}`, f.path, path.join(dir, f.path), f.size)) };
      }).filter((s) => s.items.length);
      if (sets.length) groups.push({ kind: 'out', title: `Produzido no passo ${steps.get(from).name}`, note: 'Pelos agentes desse passo.', sets });
    }
    groups.push({ kind: 'extra', title: 'Juntos só a este passo', note: 'Ficheiros ou pastas que só os agentes deste passo recebem.', sets: setsOf(conf.extra || [], extraDir(id, step), 'extra') });
    const all = groups.flatMap((g) => g.sets.flatMap((s) => s.items));
    return { groups, all, on: all.filter((x) => x.on).length, total: all.length };
  }

  // -- o modelo e as permissões de um agente nesta tarefa: os escolhidos aqui, senão os últimos desse agente --
  function settingsFor(t, agentId) {
    const a = agents.get(dataDir, agentId);
    const mine = (t.agentSettings || {})[agentId];
    // um modelo escolhido para o outro CLI (trocou-se o CLI do agente) volta ao padrão
    if (mine) return { model: modelFits(a, mine.model) ? mine.model : '', perm: PERMS.includes(mine.perm) ? mine.perm : 'ask' };
    return { model: a && modelFits(a, a.model) ? a.model || '' : '', perm: a && PERMS.includes(a.perm) ? a.perm : 'ask' };
  }

  // -- o pedido a um agente --
  function promptFor(t, def, i, links, agent, ctx) {
    const lines = [
      agents.instructionsOf(agent),
      '',
      '---',
      '',
      '# O teu trabalho nesta plataforma',
      `Passo «${def.name}» da tarefa «${t.title}» (${t.type === 'defeito' ? 'defeito a corrigir' : 'requisito a implementar'}${t.ref ? `, ${t.ref}` : ''}).`,
      `Neste passo correm ${links.length} agente(s), por esta ordem: ${links.map((l, n) => (n === i ? `**${l.name}** (tu)` : l.name)).join(' → ')}.`,
      '',
      '## O que recebes',
      'Os documentos que a pessoa escolheu para este passo. Trabalha com estes: os que não estão aqui foram tirados de propósito.',
    ];
    for (const g of ctx.inputs.groups) {
      const chosen = g.sets.flatMap((s) => s.items.filter((x) => x.on).map((x) => `  - ${x.abs}${s.title && g.kind === 'out' ? ` (de ${s.title})` : ''}`));
      if (chosen.length) lines.push(`- ${g.title}:`, ...chosen.slice(0, 200));
    }
    if (!ctx.inputs.on) lines.push('- (nenhum documento escolhido)');
    for (const prev of ctx.previous) lines.push(`- O que ${prev.who} produziu, em ${prev.dir}:`, ...(prev.files.length ? prev.files.map((f) => `  - ${f.path}`) : ['  (nada)']));
    lines.push(`- A pasta raiz dos microserviços, onde estás: ${ctx.root}. Cada microserviço é uma subpasta: ${ctx.services.join(', ') || '(nenhum encontrado)'}.`);
    // os microserviços que a pessoa escolheu para a tarefa; sem escolha, nada: o agente decide pela sua skill
    if (ctx.chosen.length) {
      lines.push(
        '',
        '## Microserviços escolhidos pela pessoa',
        `Para esta tarefa, a pessoa escolheu ${ctx.chosen.length === 1 ? 'este microserviço' : 'estes microserviços'}: ${ctx.chosen.map((n) => `${n} (${path.join(ctx.root, n)})`).join(', ')}.`,
        'São estes os microserviços em causa: não precisas de os descobrir. Se achares que falta algum (por exemplo, um que estes chamam e que a tarefa obriga a mudar, levantar ou testar), diz qual e porquê antes de o usar.',
      );
    }
    lines.push('', '## O que podes fazer', '- Ler qualquer ficheiro destas pastas.', `- Escrever o que produzes em ${ctx.outputs}.`);
    if (def.write.includes('projects')) lines.push(`- Alterar os microserviços que a tarefa precisar. Antes da tua primeira escrita num microserviço, a plataforma passa-o para o branch ${ctx.branch}; se ele tiver alterações por guardar, a escrita é recusada e deves dizê-lo à pessoa. Podes fazer git add e commit nesse branch; push, mudar de branch ou mexer na configuração do Git é recusado.`);
    if (def.write.includes('tests')) lines.push(`- Escrever os testes em ${ctx.tests}.`);
    if (def.freeze) lines.push('- Não podes alterar os microserviços: neste passo o código está congelado, e a plataforma confirma no fim que nada mudou.');
    if (def.freeze && def.repoTests) lines.push(`- Exceção: podes escrever testes nas pastas de testes dos microserviços: a pasta onde está o ${def.repoTests.marker} (uma coleção que já existe) ou, se o microserviço não tiver nenhuma, ${'<microserviço>'}/${def.repoTests.dir}/ para a criar. Antes da tua primeira escrita num microserviço, a plataforma passa-o para o branch ${ctx.branch || 'da tarefa'}. Não fazes commit nem mudas de branch.`);
    lines.push(
      ({ ask: '- Cada comando de terminal é autorizado por uma pessoa, um a um: diz porque o precisas.', read: '- Os comandos que só leem correm logo; os outros são autorizados por uma pessoa, um a um: diz porque os precisas.', all: '- Os comandos correm sem pedir autorização, menos os que a plataforma recusa sempre.', plan: '- Estás em modo só planear: não corres comandos nem alteras os microserviços; escreve o teu plano na tua pasta de resultados.' })[ctx.perm] || '',
      '',
      '## Como terminar',
      `1. Só escreves ${path.join(ctx.outputs, DONE_FILE)} quando o trabalho deste passo estiver feito e não precisares de mais nada da pessoa: o que fizeste e onde, o que ficou por fazer, e o que o agente seguinte precisa de saber. É assim que a plataforma sabe que terminaste e passa ao seguinte.`,
      `2. Se acabares com perguntas, com um plano para a pessoa aprovar, ou à espera de um "sim" (por exemplo "diz levanta"), **não escrevas ${DONE_FILE}**: faz as perguntas (podes usar a ferramenta de perguntas) e espera. A pessoa responde nesta conversa e tu continuas. Um plano ainda não é o trabalho feito.`,
    );
    return lines.join('\n');
  }

  // O que os passos e os agentes anteriores produziram: as pastas de resultados, pela ordem
  function previousOf(id, t, def, step, i) {
    const out = [];
    const links = t.pipeline[step].links;
    for (let n = 0; n < i; n++) {
      const dir = outputsOf(id, step, n, links[n]);
      out.push({ who: `${links[n].name} (antes de ti, neste passo)`, dir, files: filesIn(dir, 60) });
    }
    return out;
  }

  // -- correr um agente da sequência --
  async function runLink(id, step, i, { resume = false, message = '' } = {}) {
    const def = steps.get(step);
    const root = settings.rootDir(dataDir);
    const env = await shell.loginShellEnv();
    let t = h.load(id);
    const p = t.pipeline[step];
    const link = p.links[i];
    // ao retomar (também um agente que já tinha terminado), só conta um FEITO.md escrito a partir de agora
    const doneFile = path.join(outputsOf(id, step, i, link), DONE_FILE);
    link.doneMark = resume && fs.existsSync(doneFile) ? fs.statSync(doneFile).mtimeMs : 0;
    const fail = (why) => {
      t = h.load(id);
      Object.assign(t.pipeline[step].links[i], { status: 'failed', error: why, endedAt: now() });
      t.pipeline[step].status = 'failed';
      h.event(t, 'app', `${link.name} não arrancou: ${why}`);
      saveAndTell(t);
    };
    const agent = agents.get(dataDir, link.agentId);
    if (!agent) return fail('o agente já não está na página Agentes');
    const which = cliOf(agent);
    const cli = await shell.findCli(which.name);
    if (!root) return fail('a pasta raiz dos microserviços não está definida');
    if (!cli.found) return fail(`o ${which.label} não está neste computador`);
    const outputs = outputsOf(id, step, i, link);
    fs.mkdirSync(outputs, { recursive: true });
    if (!resume) {
      fs.rmSync(path.join(outputs, DONE_FILE), { force: true });
      try {
        fs.writeFileSync(path.join(linkDir(id, step, i, link), 'console.jsonl'), '');
      } catch {
        // sem escrita
      }
    }
    if (def.write.includes('tests')) fs.mkdirSync(testsDir(id), { recursive: true });
    if (def.branch && !t.branch) t.branch = branchFor(t);
    const ctx = {
      root,
      docsDir: path.join(h.dirOf(id), 'documents'),
      outputs,
      tests: testsDir(id),
      branch: t.branch,
      services: services.list(dataDir).map((s) => s.name).slice(0, 120),
      chosen: (t.chosenServices || []).filter((n) => fs.existsSync(path.join(root, n))),
      previous: previousOf(id, t, def, step, i),
      inputs: inputsOf(id, t, step),
      perm: settingsFor(t, link.agentId).perm,
    };
    const first = resume ? (message || 'Continua o teu trabalho de onde paraste.') : promptFor(t, def, i, p.links, agent, ctx);
    const decide = makePolicy({
      root,
      writeDirs: [outputs, ...(def.write.includes('tests') ? [ctx.tests] : [])],
      repos: def.write.includes('projects'),
      prepareRepo: (dir, name) => prepareRepo(id, dir, name),
      codeFrozen: Boolean(def.freeze),
      repoTests: def.repoTests || null,
      perm: settingsFor(t, link.agentId).perm,
      hidden: ctx.inputs.all.filter((x) => !x.on).map((x) => x.abs),
    });
    const chosen = settingsFor(t, link.agentId);

    Object.assign(link, { status: 'running', startedAt: link.startedAt && resume ? link.startedAt : now(), endedAt: null, error: '', model: chosen.model, perm: chosen.perm });
    p.status = 'running';
    p.current = i;
    h.event(t, link.name, resume ? 'Retomado' : `Começou (${i + 1} de ${p.links.length})`);
    saveAndTell(t);

    link.cli = which.label;
    const session = (which.name === 'copilot' ? startCopilotSession : startSession)({
      file: cli.file,
      useShell: cli.shell,
      env,
      cwd: root,
      addDirs: [h.dirOf(id)],
      tools: TOOLS,
      resume: resume ? link.sessionId || '' : '',
      model: chosen.model,
      denyRead: ctx.inputs.all.filter((x) => !x.on).map((x) => real(x.abs)),
      show: [{ dir: h.dirOf(id), label: 'tarefa/' }, { dir: root, label: '' }],
      decide,
      onEntry: (e) => log(id, step, i, link, e),
      onPending: (pending) => tell({ taskId: id, type: 'pending', step, index: i, pending }),
      onTurnEnd: (r) => turnEnded(id, step, i, r),
      onEnd: (r) => ended(id, step, i, r),
    });
    active.set(id, { step, index: i, session });
    log(id, step, i, link, { k: 'start', a: link.name, b: `${resume ? 'retomado · ' : ''}${which.label} ${cli.version} · ${chosen.model || 'modelo por omissão'} · ${({ ask: 'perguntar cada comando', read: 'comandos de leitura sem perguntar', all: 'tudo sem perguntar', plan: 'só planear' })[chosen.perm]}` });
    if (resume && message) log(id, step, i, link, { k: 'user', a: message });
    session.send(first);
  }

  function turnEnded(id, step, i, r) {
    const a = active.get(id);
    if (!a || a.step !== step || a.index !== i) return;
    const t = h.load(id);
    const link = t.pipeline[step].links[i];
    link.sessionId = r.sessionId || link.sessionId;
    link.tokens = (link.tokens || 0) + (r.tokens || 0);
    if (r.model) link.model = r.model;
    const doneFile = path.join(outputsOf(id, step, i, link), DONE_FILE);
    if (fs.existsSync(doneFile) && fs.statSync(doneFile).mtimeMs > (link.doneMark || 0)) {
      Object.assign(link, { status: 'done', endedAt: now(), error: '', doneMark: 0 });
      h.event(t, link.name, `Terminou${link.tokens ? ` · ${link.tokens.toLocaleString('pt-PT')} tokens` : ''}`);
      log(id, step, i, link, { k: 'ok', a: 'Terminou', b: `${DONE_FILE} escrito` });
      saveAndTell(t);
      a.session.end(); // a sequência continua quando o processo fechar (ended)
      return;
    }
    link.status = 'waiting';
    if (r.isError) link.error = String(r.text || '').slice(0, 400);
    log(id, step, i, link, { k: 'wait', a: 'À tua espera', b: r.isError ? `O agente parou com um erro: ${String(r.text).slice(0, 300)}` : `Parou sem escrever ${DONE_FILE}: responde-lhe, ou dá-o por terminado.` });
    saveAndTell(t);
  }

  function ended(id, step, i, r) {
    const a = active.get(id);
    if (a && a.step === step && a.index === i) active.delete(id);
    let t;
    try {
      t = h.load(id);
    } catch {
      return; // a tarefa foi apagada
    }
    const p = t.pipeline && t.pipeline[step];
    if (!p) return;
    const link = p.links[i];
    if (r.sessionId) link.sessionId = r.sessionId;
    if (link.status === 'done') {
      h.save(t);
      advance(id, step, i);
      return;
    }
    if (link.status === 'stopped') {
      saveAndTell(t);
      return;
    }
    const label = link.cli || 'Claude CLI';
    const why = r.reason || (r.code ? `o ${label} terminou com o código ${r.code}${r.stderr ? `: ${r.stderr}` : ''}` : `o ${label} terminou sem o agente escrever ${DONE_FILE}`);
    Object.assign(link, { status: 'failed', error: why, endedAt: now() });
    p.status = 'failed';
    h.event(t, 'app', `${link.name} parou: ${why}`);
    log(id, step, i, link, { k: 'deny', a: 'Parou', b: why });
    saveAndTell(t);
  }

  async function advance(id, step, i) {
    const t = h.load(id);
    const p = t.pipeline[step];
    const link = p.links[i];
    if (link.pause && !link.approvedAt) {
      p.status = 'paused';
      p.current = i;
      h.event(t, 'app', `Pausa depois de ${link.name}: à espera que a deixes continuar`);
      saveAndTell(t);
      return;
    }
    if (i + 1 < p.links.length) {
      await runLink(id, step, i + 1);
      return;
    }
    p.status = 'done';
    p.endedAt = now();
    p.current = null;
    if (p.freeze) {
      const after = await snapshot(settings.rootDir(dataDir), steps.get(step).repoTests || null);
      const moved = p.freeze.moved || {};
      for (const [k, head] of Object.entries(moved)) if (after[k] && after[k].head === head && p.freeze.before[k]) after[k] = { ...after[k], head: p.freeze.before[k].head };
      const changed = Object.keys({ ...p.freeze.before, ...after }).filter((k) => JSON.stringify(p.freeze.before[k] || null) !== JSON.stringify(after[k] || null));
      p.freeze.checkedAt = now();
      p.freeze.changed = changed;
    }
    h.event(t, 'app', `Passo ${steps.get(step).name} terminado${p.freeze ? (p.freeze.changed.length ? ` · ATENÇÃO: o código mudou em ${p.freeze.changed.join(', ')}` : ' · o código não mudou') : ''}`);
    saveAndTell(t);
  }

  // -- o que a página vê --
  function viewOf(t) {
    const out = {};
    for (const def of steps.STEPS) {
      const p = t.pipeline && t.pipeline[def.id];
      const a = active.get(t.id);
      const mine = a && a.step === def.id;
      if (!p) {
        out[def.id] = { status: 'idle', links: agents.sequence(dataDir, def.id).map((x) => ({ agentId: x.id, name: x.name, pause: x.pause, status: 'pending', settings: settingsFor(t, x.id), tool: cliOf(x).name })), preview: true };
        continue;
      }
      const links = p.links.map((l, n) => ({ ...l, settings: settingsFor(t, l.agentId), tool: cliOf(agents.get(dataDir, l.agentId)).name, status: (l.status === 'running' || l.status === 'waiting') && !(mine && a.index === n) ? 'interrupted' : l.status }));
      const status = (p.status === 'running') && !mine ? 'interrupted' : p.status;
      out[def.id] = { ...p, status, links, pending: mine ? a.session.pending : [], working: mine ? a.session.working : false };
    }
    return out;
  }

  const guard = (fn) => async (_, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  };
  const linkOf = (id, step, i) => {
    const t = h.load(id);
    const p = t.pipeline && t.pipeline[step];
    if (!p || !p.links[i]) throw new Error('Esse agente não correu nesta tarefa');
    return { t, p, link: p.links[Number(i)] };
  };

  ipcMain.handle('pipeline:models', guard(async () => ({ copilot: await copilotModels() })));

  ipcMain.handle('pipeline:start', guard(async (id, step) => {
    const def = steps.get(step);
    if (!def) throw new Error('Passo desconhecido');
    if (active.has(id)) throw new Error('Já há um agente a correr nesta tarefa');
    const t = h.load(id);
    if (!t.documents.length) throw new Error('Junta pelo menos um documento à tarefa');
    const root = settings.rootDir(dataDir);
    if (!root) throw new Error('Define primeiro a pasta raiz dos microserviços, em Definições');
    const seq = agents.sequence(dataDir, step);
    if (!seq.length) throw new Error(`Liga pelo menos um agente ao passo ${def.name}, na página Agentes`);
    for (const which of [...new Set(seq.map(cliOf))]) if (!(await shell.findCli(which.name)).found) throw new Error(`Não encontro o ${which.label} neste computador`);
    // o que um passo já tinha produzido fica guardado à parte, e a nova execução começa limpa
    const dir = stepDir(id, step);
    if (fs.existsSync(dir)) {
      const keep = path.join(h.dirOf(id), 'steps', '_anteriores', `${step}-${now().replace(/[:.]/g, '-')}`);
      fs.mkdirSync(path.dirname(keep), { recursive: true });
      fs.renameSync(dir, keep);
    }
    const fresh = h.load(id);
    fresh.pipeline = fresh.pipeline || {};
    fresh.pipeline[step] = {
      status: 'running',
      startedAt: now(),
      current: 0,
      links: seq.map((a) => ({ agentId: a.id, name: a.name, pause: a.pause, status: 'pending' })),
      freeze: def.freeze ? { before: await snapshot(root, def.repoTests || null) } : null,
    };
    if (def.branch && !fresh.branch) fresh.branch = branchFor(fresh);
    h.event(fresh, 'user', `Começou o passo ${def.name}: ${seq.map((a) => a.name).join(' → ')}`);
    h.save(fresh);
    await runLink(id, step, 0);
    return { ok: true };
  }));

  ipcMain.handle('pipeline:send', guard(async (id, text, step, index) => {
    const message = String(text || '').trim();
    if (!message) throw new Error('Escreve primeiro a mensagem');
    const a = active.get(id);
    if (a) {
      const { t, link } = linkOf(id, a.step, a.index);
      a.session.send(message);
      link.status = 'running';
      log(id, a.step, a.index, link, { k: 'user', a: message });
      saveAndTell(t);
      return { ok: true };
    }
    // sem sessão aberta (a plataforma reiniciou, o agente parou, ou já tinha terminado): retoma a conversa com a mensagem
    const t = h.load(id);
    if (step && t.pipeline && t.pipeline[step] && t.pipeline[step].links[Number(index)]) {
      const link = t.pipeline[step].links[Number(index)];
      if (!link.sessionId) throw new Error('Este agente não tem uma conversa para retomar: repete-o');
      if (link.status === 'done') h.event(t, 'user', `Conversa retomada com ${link.name}, depois de terminado`);
      h.save(t);
      await runLink(id, step, Number(index), { resume: true, message });
      return { ok: true };
    }
    const entry = Object.entries(t.pipeline || {}).find(([, p]) => ['running', 'failed', 'stopped'].includes(p.status) && p.current !== null && p.current !== undefined);
    if (!entry) throw new Error('Não há nenhum agente para continuar');
    const [openStep, p] = entry;
    if (!p.links[p.current].sessionId) throw new Error('Este agente não tem uma conversa para retomar: repete-o');
    await runLink(id, openStep, p.current, { resume: true, message });
    return { ok: true };
  }));

  ipcMain.handle('pipeline:answer', guard((id, requestId, choice, answers) => {
    const a = active.get(id);
    if (!a) throw new Error('O agente já não está a correr');
    a.session.answer(String(requestId), ['allow', 'always', 'deny'].includes(choice) ? choice : 'deny', answers);
    return { ok: true };
  }));

  // A pessoa dá o agente por terminado (com ou sem FEITO.md): a sequência segue
  ipcMain.handle('pipeline:done', guard(async (id, step, i) => {
    const { t, p, link } = linkOf(id, step, i);
    Object.assign(link, { status: 'done', endedAt: now(), error: '', byHand: true });
    h.event(t, 'user', `${link.name} dado por terminado`);
    saveAndTell(t);
    const a = active.get(id);
    if (a && a.step === step && a.index === Number(i)) await a.session.end();
    else if (p.current === Number(i)) await advance(id, step, Number(i));
    return { ok: true };
  }));

  ipcMain.handle('pipeline:stop', guard(async (id) => {
    const a = active.get(id);
    if (!a) return { ok: true };
    const { t, p, link } = linkOf(id, a.step, a.index);
    Object.assign(link, { status: 'stopped', endedAt: now() });
    p.status = 'stopped';
    h.event(t, 'user', `${link.name} parado`);
    log(id, a.step, a.index, link, { k: 'deny', a: 'Parado', b: 'Parado por ti' });
    saveAndTell(t);
    await a.session.kill('Parado por ti');
    return { ok: true };
  }));

  ipcMain.handle('pipeline:continue', guard(async (id, step) => {
    const t = h.load(id);
    const p = t.pipeline && t.pipeline[step];
    if (!p || p.status !== 'paused') throw new Error('Este passo não está em pausa');
    p.links[p.current].approvedAt = now();
    h.event(t, 'user', `Aprovado: a sequência continua depois de ${p.links[p.current].name}`);
    h.save(t);
    await advance(id, step, p.current);
    return { ok: true };
  }));

  // Repete um agente, de novo e sem a conversa anterior; os seguintes voltam a esperar
  ipcMain.handle('pipeline:retry', guard(async (id, step, i) => {
    if (active.has(id)) throw new Error('Já há um agente a correr nesta tarefa');
    const { t, p } = linkOf(id, step, i);
    for (let n = Number(i); n < p.links.length; n++) Object.assign(p.links[n], { status: 'pending', error: '', approvedAt: null, sessionId: n === Number(i) ? p.links[n].sessionId : null });
    p.status = 'running';
    h.save(t);
    await runLink(id, step, Number(i));
    return { ok: true };
  }));

  // Retoma a conversa de um agente que foi interrompido (a plataforma reiniciou, ou parou)
  ipcMain.handle('pipeline:resume', guard(async (id, step, i) => {
    if (active.has(id)) throw new Error('Já há um agente a correr nesta tarefa');
    const { link } = linkOf(id, step, i);
    if (!link.sessionId) throw new Error('Este agente não tem uma conversa para retomar: repete-o');
    await runLink(id, step, Number(i), { resume: true });
    return { ok: true };
  }));

  ipcMain.handle('pipeline:console', guard((id, step, i) => {
    const { link } = linkOf(id, step, i);
    let lines = [];
    try {
      lines = fs.readFileSync(path.join(linkDir(id, step, Number(i), link), 'console.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-CONSOLE_SHOWN);
    } catch {
      // ainda sem consola
    }
    return { entries: lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) };
  }));

  // As entradas de um passo, para a página (sem os caminhos completos)
  ipcMain.handle('pipeline:inputs', guard((id, step) => {
    if (!steps.get(step)) throw new Error('Passo desconhecido');
    const t = h.load(id);
    const r = inputsOf(id, t, step);
    const strip = (x) => ({ key: x.key, name: x.name, size: x.size, readable: x.readable, on: x.on });
    const p = t.pipeline && t.pipeline[step];
    return { groups: r.groups.map((g) => ({ ...g, sets: g.sets.map((s) => ({ ...s, items: s.items.map(strip) })) })), on: r.on, total: r.total, editable: !active.has(id), used: p && p.startedAt ? p.startedAt : null };
  }));

  // Tira (on=false) ou volta a pôr (on=true) ficheiros nas entradas de um passo
  ipcMain.handle('pipeline:set-inputs', guard((id, step, keys, on) => {
    if (!steps.get(step)) throw new Error('Passo desconhecido');
    if (active.has(id)) throw new Error('Espera que o agente acabe (ou pára-o) para mudar as entradas');
    const t = h.load(id);
    t.inputs = t.inputs || {};
    const conf = t.inputs[step] = t.inputs[step] || { off: [], extra: [] };
    const off = new Set(conf.off || []);
    for (const k of (Array.isArray(keys) ? keys : []).slice(0, 2000).map(String)) if (on) off.delete(k); else off.add(k);
    conf.off = [...off].slice(0, 5000);
    h.save(t);
    const r = inputsOf(id, t, step);
    return { on: r.on, total: r.total };
  }));

  // O texto de uma entrada, para a pessoa ver
  ipcMain.handle('pipeline:read-input', guard((id, step, key) => {
    if (!steps.get(step)) throw new Error('Passo desconhecido');
    const x = inputsOf(id, h.load(id), step).all.find((y) => y.key === String(key));
    if (!x || !fs.existsSync(x.abs)) throw new Error('Esse documento já não existe');
    return { name: x.name, ...readText(x.abs) };
  }));

  ipcMain.handle('pipeline:outputs', guard((id, step, i) => {
    const { link } = linkOf(id, step, i);
    return { files: filesIn(outputsOf(id, step, Number(i), link)) };
  }));

  ipcMain.handle('pipeline:read-output', guard((id, step, i, rel) => {
    const { link } = linkOf(id, step, i);
    const base = outputsOf(id, step, Number(i), link);
    const file = path.resolve(base, String(rel || ''));
    if (!file.startsWith(base + path.sep)) throw new Error('Esse ficheiro não é deste agente');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Esse ficheiro já não existe');
    return { name: `${link.name}/${rel}`, ...readText(file) };
  }));

  // O que mudou em cada microserviço onde a tarefa criou o seu branch
  ipcMain.handle('pipeline:changes', guard(async (id) => {
    const t = h.load(id);
    const root = settings.rootDir(dataDir);
    const out = [];
    for (const [name, rec] of Object.entries((t.git && t.git.repos) || {})) {
      const dir = path.join(root, name);
      if (!fs.existsSync(dir)) { out.push({ name, ...rec, missing: true }); continue; }
      out.push({ name, ...rec, current: await git.branch(dir), ...(await git.changes(dir, rec.base)) });
    }
    // os repositórios da pasta raiz com alterações por guardar (fora dos que a tarefa já pôs no seu branch)
    const dirty = [];
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      // sem pasta raiz
    }
    for (const e of entries) {
      const dir = path.join(root, e.name);
      if (e.name.startsWith('.') || !e.isDirectory() || !git.isRepo(dir) || (t.git && t.git.repos && t.git.repos[e.name])) continue;
      try {
        const lines = await git.dirty(dir);
        if (lines.length) dirty.push({ name: e.name, count: lines.length, branch: await git.branch(dir) });
      } catch {
        // um repositório que não responde fica de fora
      }
    }
    return { branch: t.branch || branchFor(t), repos: out, dirty };
  }));

  // "Já resolvi": confirma que o microserviço ficou como devia, fecha o alerta e diz ao agente para tentar de novo
  ipcMain.handle('pipeline:alert-resolve', guard(async (id, alertId) => {
    const t = h.load(id);
    const al = (t.alerts || []).find((x) => x.id === alertId);
    if (!al) throw new Error('Esse alerta já não existe');
    const dir = path.join(settings.rootDir(dataDir), al.repo);
    if (al.kind === 'dirty' || al.kind === 'moved') {
      const left = await git.dirty(dir);
      if (left.length) throw new Error(`${al.repo} ainda tem ${left.length} alteração(ões) por guardar. Guarda-as (commit ou stash) e tenta de novo.`);
    }
    if (al.kind === 'branch-exists' && await git.branchExists(dir, t.branch || branchFor(t))) throw new Error(`O branch ${t.branch || branchFor(t)} ainda existe em ${al.repo}`);
    if (al.kind === 'not-git' && !git.isRepo(dir)) throw new Error(`${al.repo} continua a não ser um repositório Git`);
    al.resolved = true;
    al.resolvedAt = now();
    h.event(t, 'user', `Resolvido: ${al.repo}`);
    h.save(t);
    const a = active.get(id);
    if (a) {
      const message = `Já resolvi o problema em ${al.repo}. Tenta de novo.`;
      const fresh = h.load(id);
      const link = fresh.pipeline[a.step].links[a.index];
      a.session.send(message);
      link.status = 'running';
      log(id, a.step, a.index, link, { k: 'user', a: message });
      h.save(fresh);
    }
    h.changed(id);
    return { ok: true, told: Boolean(a) };
  }));

  ipcMain.handle('pipeline:alert-dismiss', guard((id, alertId) => {
    const t = h.load(id);
    const al = (t.alerts || []).find((x) => x.id === alertId);
    if (al) al.dismissed = true;
    saveAndTell(t);
    return { ok: true };
  }));

  // O diff de um ficheiro de um microserviço onde a tarefa criou o seu branch
  ipcMain.handle('pipeline:file-diff', guard(async (id, repo, file, full) => {
    const t = h.load(id);
    const rec = t.git && t.git.repos && t.git.repos[String(repo)];
    if (!rec) throw new Error('A tarefa não alterou esse microserviço');
    const dir = path.join(settings.rootDir(dataDir), String(repo));
    return { repo, file, base: rec.base, ...(await git.fileDiff(dir, rec.base, String(file), Boolean(full))) };
  }));

  // O modelo e as permissões de um agente nesta tarefa (e o ponto de partida desse agente nas tarefas seguintes)
  ipcMain.handle('pipeline:set-agent-settings', guard((id, agentId, given) => {
    const t = h.load(id);
    const g = given && typeof given === 'object' ? given : {};
    const cur = settingsFor(t, String(agentId));
    const who = agents.get(dataDir, String(agentId));
    const okModel = (m) => typeof m === 'string' && modelFits(who, m);
    const next = { model: okModel(g.model) ? g.model : cur.model, perm: PERMS.includes(g.perm) ? g.perm : cur.perm };
    t.agentSettings = t.agentSettings || {};
    t.agentSettings[String(agentId)] = next;
    agents.setDefaults(dataDir, String(agentId), next);
    saveAndTell(t);
    return { settings: next };
  }));

  ipcMain.handle('pipeline:set-branch', guard((id, name) => {
    const t = h.load(id);
    const branch = String(name || '').trim();
    if (!git.BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/')) throw new Error('Esse nome de branch não é válido');
    if (t.git && t.git.repos && Object.keys(t.git.repos).length) throw new Error('O branch já foi criado em microserviços desta tarefa: já não se muda o nome');
    t.branch = branch;
    h.event(t, 'user', `Branch da tarefa: ${branch}`);
    saveAndTell(t);
    return { ok: true };
  }));

  return { viewOf, branchFor, extraDir };
}

const stopAll = () => {
  for (const a of active.values()) a.session.kill('A plataforma fechou');
};
const isRunning = (id) => active.has(id);

module.exports = { register, stopAll, isRunning };
