// A página: só mostra o que o processo principal lhe diz (window.estaleiro) e pede o que a pessoa escolhe. Nada
// do Node chega aqui. Tudo o que vem de fora (documentos, o que os agentes escrevem) entra no HTML por esc().
(function () {
  const api = window.estaleiro;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rich = (s) => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }) : '');
  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const same = d.toDateString() === new Date().toDateString();
    return same ? `hoje, ${hm(iso)}` : d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' }) + `, ${hm(iso)}`;
  };
  const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
  const tokens = (n) => (n ? `${Number(n).toLocaleString('pt-PT')} tokens` : '');

  // o estado de um passo ou de um agente, em palavras e na cor de um selo
  const STATUS = {
    idle: ['', 'por começar'], pending: ['', 'à espera da vez'], running: ['accent', 'a trabalhar'], waiting: ['warn', 'à tua espera'],
    paused: ['warn', 'pausa: aprova para seguir'], done: ['good', 'terminado'], failed: ['bad', 'parou'], stopped: ['warn', 'parado'],
    interrupted: ['warn', 'interrompido'],
  };
  const statusPill = (s, extra = '') => {
    const [tone, text] = STATUS[s] || ['', s];
    return `<span class="pill ${tone}">${s === 'running' ? '<span class="dot accent live"></span>' : ''}${esc(text)}${extra}</span>`;
  };

  const state = {
    view: 'tarefas',
    info: null,
    tasks: [],
    agents: [],
    stepList: [],
    services: [],
    root: '',
    task: null,
    tab: 'documentos',
    tabOf: {},
    sel: {}, // passo -> índice do agente mostrado
    mode: {}, // passo -> conversa | produzido | alteracoes
    diffSel: {}, // passo -> { repo, path } do ficheiro mostrado
    diffMode: 'split', // lado a lado, ou numa coluna
    diff: null,
    outputsAll: [],
    inputs: null, // as entradas do passo mostrado
    diffOpen: null, // o ficheiro na janela das diferenças
    entries: [], // a consola do agente mostrado
    loaded: null, // de onde são as entradas e a consola à vista: { task, step, sel }
    outputs: [],
    changes: null,
    newTask: { files: [], folders: [], type: 'requisito' },
    scan: null,
  };

  // -- avisos e confirmação --
  function toast(text, bad) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' bad' : ''}`;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), bad ? 7000 : 3500);
  }
  async function call(promise) {
    const r = await promise;
    if (r && r.error) {
      toast(r.error, true);
      return null;
    }
    return r;
  }
  function confirmBox(title, text, yes) {
    return new Promise((resolve) => {
      $('#mc-title').textContent = title;
      $('#mc-text').textContent = text;
      $('#mc-yes').textContent = yes || 'Apagar';
      const modal = $('#modal-confirm');
      const done = (v) => {
        modal.classList.remove('open');
        $('#mc-yes').onclick = null;
        $('#mc-no').onclick = null;
        resolve(v);
      };
      $('#mc-yes').onclick = () => done(true);
      $('#mc-no').onclick = () => done(false);
      modal.classList.add('open');
    });
  }
  // Ver um ficheiro. Um .md pode ver-se formatado (Documento) ou como está (Texto), como a pré-visualização do VS Code;
  // a escolha fica para a próxima vez.
  let mvMode = 'doc';
  try { mvMode = localStorage.getItem('estaleiro.mdView') || 'doc'; } catch { /* sem armazenamento */ }
  function viewText(title, meta, text, html) {
    $('#mv-title').textContent = title;
    $('#mv-meta').textContent = meta || '';
    if (html) $('#mv-text').innerHTML = html; else $('#mv-text').textContent = text;
    const name = String(title || '');
    const isMd = !html && /\.(md|markdown)$/i.test(name) && typeof text === 'string';
    // um .json: um relatório do Bruno vê-se como relatório; os outros, indentados
    let report = null;
    if (!html && /\.json$/i.test(name) && typeof text === 'string') {
      try {
        const d = JSON.parse(text);
        if (isBrunoReport(d)) report = d; else $('#mv-text').textContent = JSON.stringify(d, null, 2);
      } catch { /* não é JSON inteiro: mostra-se como está */ }
    }
    const rich = isMd || Boolean(report);
    $('#mv-mode').hidden = !rich;
    $('#mv-mode [data-mv=doc]').textContent = report ? 'Relatório' : 'Documento';
    $('#mv-doc').classList.toggle('rep-view', Boolean(report));
    $('#mv-doc').innerHTML = isMd ? mdToHtml(text) : report ? brunoReport(report) : '';
    paintViewMode(rich);
    $('#modal-view').classList.add('open');
    $('#mv-doc').scrollTop = 0;
    $('#mv-text').scrollTop = 0;
  }
  function paintViewMode(isMd) {
    const doc = isMd && mvMode === 'doc';
    $('#mv-doc').hidden = !doc;
    $('#mv-text').hidden = doc;
    $$('#mv-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mv === (doc ? 'doc' : 'text')));
  }

  // ---- O relatório de uma execução do Bruno (bru run --reporter-json), para ler ----
  const isBrunoReport = (d) => (Array.isArray(d) ? d : [d]).every((it) => it && typeof it === 'object' && Array.isArray(it.results) && it.summary && typeof it.summary === 'object') && (Array.isArray(d) ? d.length > 0 : true);
  // tokens, palavras-passe e afins não se mostram, nem nos cabeçalhos nem nos corpos
  const SECRET = /authorization|cookie|token|password|passwd|secret|senha|api[-_]?key/i;
  const hideSecrets = (o, depth = 0) => {
    if (depth > 12 || o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map((x) => hideSecrets(x, depth + 1));
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SECRET.test(k) ? '(escondido)' : hideSecrets(v, depth + 1)]));
  };
  const prettyBody = (b) => {
    if (b === undefined || b === null || b === '') return '';
    let v = b;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return v.slice(0, 20000); } }
    return JSON.stringify(hideSecrets(v), null, 2).slice(0, 20000);
  };
  function brunoReport(d) {
    const iters = Array.isArray(d) ? d : [d];
    return iters.map((it, n) => {
      const s = it.summary || {};
      const results = it.results || [];
      const dur = results.reduce((t, r) => t + (Number(r.runDuration) || 0), 0);
      const bad = results.filter((r) => r.status !== 'pass').length;
      const card = (label, ok, total, failed) => `<div class="rep-card ${total ? (failed ? 'bad' : 'good') : ''}"><b>${ok ?? 0}<span>/${total ?? 0}</span></b><span>${label}</span>${failed ? `<small>${failed} falhara${failed === 1 ? 'm' : 'm'}</small>` : ''}</div>`;
      const count = (list) => (list.length ? `${list.filter((x) => x.status === 'pass').length}/${list.length}` : '');
      const rows = results.map((r) => {
        const ok = r.status === 'pass';
        const req = r.request || {};
        const res = r.response || {};
        const asr = r.assertionResults || [];
        const tst = [...(r.preRequestTestResults || []), ...(r.testResults || []), ...(r.postResponseTestResults || [])];
        let path = req.url || '';
        try { const u = new URL(req.url); path = u.pathname + u.search; } catch { /* fica o endereço */ }
        const code = res.status;
        const codeCls = !code ? '' : code < 300 ? 'c2' : code < 400 ? 'c3' : code < 500 ? 'c4' : 'c5';
        const mark = (x) => `<span class="rep-mark ${x.status === 'pass' ? 'ok' : 'bad'}">${x.status === 'pass' ? '✓' : '✗'}</span>`;
        const headers = (h) => Object.entries(hideSecrets(h || {})).map(([k, v]) => `${esc(k)}: ${esc(typeof v === 'string' ? v : JSON.stringify(v))}`).join('\n');
        const reqBody = prettyBody(req.data);
        const resBody = prettyBody(res.data);
        return `<details class="rep-row${ok ? '' : ' failed'}"${ok ? '' : ' open'}>
          <summary><span class="rep-mark ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span><span class="rep-name">${esc(r.name || r.path || '')}</span>
            <span class="rep-req"><span class="rep-m m-${esc(req.method || '')}">${esc(req.method || '')}</span><span class="rep-path" title="${esc(req.url || '')}">${esc(path)}</span></span>
            <span class="rep-code ${codeCls}">${esc(code ?? '—')}</span><span class="rep-ms">${res.responseTime != null ? `${esc(res.responseTime)} ms` : ''}</span>
            <span class="rep-counts">${count(tst) ? `testes ${count(tst)}` : ''}${count(tst) && count(asr) ? ' · ' : ''}${count(asr) ? `asserções ${count(asr)}` : ''}</span></summary>
          <div class="rep-body">
            ${r.error ? `<div class="rep-error">${esc(typeof r.error === 'string' ? r.error : JSON.stringify(r.error))}</div>` : ''}
            ${tst.length ? `<h4>Testes</h4><ul class="rep-checks">${tst.map((x) => `<li>${mark(x)}<span>${esc(x.description || '')}${x.error ? `<small>${esc(x.error)}</small>` : ''}</span></li>`).join('')}</ul>` : ''}
            ${asr.length ? `<h4>Asserções</h4><ul class="rep-checks">${asr.map((x) => `<li>${mark(x)}<span><code>${esc(x.lhsExpr || '')}</code> ${esc(x.rhsExpr || '')}${x.error ? `<small>${esc(x.error)}</small>` : ''}</span></li>`).join('')}</ul>` : ''}
            <div class="rep-io">
              <div><h4>Pedido</h4><pre>${esc(`${req.method || ''} ${req.url || ''}`)}${req.headers && Object.keys(req.headers).length ? `\n${headers(req.headers)}` : ''}${reqBody ? `\n\n${esc(reqBody)}` : ''}</pre></div>
              <div><h4>Resposta</h4><pre>${esc(`${code ?? ''} ${res.statusText || ''}`.trim())}${resBody ? `\n\n${esc(resBody)}` : ''}</pre></div>
            </div>
            ${r.test && r.test.filename ? `<p class="rep-file">${esc(r.test.filename)}</p>` : ''}
          </div></details>`;
      }).join('');
      return `${iters.length > 1 ? `<h2>Iteração ${n + 1}</h2>` : ''}
        <div class="rep-head"><span class="rep-verdict ${bad ? 'bad' : 'good'}">${bad ? `${bad} pedido${bad === 1 ? '' : 's'} com falhas` : 'Tudo passou'}</span>
          ${bad ? '<label class="rep-filter"><input type="checkbox" data-rep-only-bad> Só os que falharam</label>' : ''}</div>
        <div class="rep-cards">${card('pedidos', s.passedRequests, s.totalRequests, (s.failedRequests || 0) + (s.errorRequests || 0))}${card('testes', s.passedTests, s.totalTests, s.failedTests)}${card('asserções', s.passedAssertions, s.totalAssertions, s.failedAssertions)}<div class="rep-card"><b>${dur < 60 ? `${dur.toFixed(1)} s` : `${Math.floor(dur / 60)} min ${Math.round(dur % 60)} s`}</b><span>duração</span></div></div>
        <div class="rep-list">${rows}</div>`;
    }).join('');
  }

  // Markdown para HTML, para ler: títulos, parágrafos, listas (com níveis e caixas de tarefa), tabelas, código, citações,
  // linhas, negrito, itálico, riscado e ligações. Todo o texto é escapado primeiro: nenhum HTML do ficheiro passa.
  function mdInline(s) {
    const codes = [];
    let h = String(s).replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => { codes.push(code.trim()); return `\u0000${codes.length - 1}\u0000`; });
    h = esc(h)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, alt) => `<span class="md-img">[imagem${alt ? `: ${alt}` : ''}]</span>`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, url) => (/^(https?:|mailto:)/i.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : `<span class="md-link" title="${url}">${label}</span>`))
      .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__([^_]+?)__(?=[^\w]|$)/g, '$1<strong>$2</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_([^_\s][^_]*?)_(?=[^\w]|$)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+?)~~/g, '<del>$1</del>');
    return h.replace(/\u0000(\d+)\u0000/g, (m, n) => `<code>${esc(codes[Number(n)])}</code>`);
  }
  function mdToHtml(src) {
    // o cabeçalho entre --- no início (name, description, tools...): uma tabela pequena, como no GitHub
    const front = /^\uFEFF?---\n([\s\S]*?)\n---\n?/.exec(String(src || '').replace(/\r\n?/g, '\n'));
    if (front) {
      const rows = front[1].split('\n').map((l) => /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(l)).filter(Boolean);
      const rest = String(src).replace(/\r\n?/g, '\n').slice(front[0].length);
      if (rows.length) return `<table class="md-front"><tbody>${rows.map((m) => `<tr><th>${esc(m[1])}</th><td>${mdInline(m[2].replace(/^["']|["']$/g, ''))}</td></tr>`).join('')}</tbody></table>\n${mdToHtml(rest)}`;
    }
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/;
    const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
    const HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
    const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
    const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    const isTable = (k) => lines[k].includes('|') && k + 1 < lines.length && SEP.test(lines[k + 1]) && lines[k + 1].includes('-');
    const startsBlock = (k) => FENCE.test(lines[k]) || HEAD.test(lines[k]) || HR.test(lines[k]) || /^\s*>/.test(lines[k]) || LIST.test(lines[k]) || isTable(k);
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = FENCE.exec(line);
      if (fence) {
        const close = new RegExp(`^\\s*${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
        const code = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push(`<pre class="md-code">${fence[2] ? `<span class="md-lang">${esc(fence[2])}</span>` : ''}<code>${esc(code.join('\n'))}</code></pre>`);
        continue;
      }
      const head = HEAD.exec(line);
      if (head) { out.push(`<h${head[1].length}>${mdInline(head[2])}</h${head[1].length}>`); i++; continue; }
      if (HR.test(line)) { out.push('<hr>'); i++; continue; }
      if (isTable(i)) {
        const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
        const th = cells(line).map((c, n) => `<th${align[n] ? ` style="text-align:${align[n]}"` : ''}>${mdInline(c)}</th>`).join('');
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(`<tr>${cells(lines[i]).map((c, n) => `<td${align[n] ? ` style="text-align:${align[n]}"` : ''}>${mdInline(c)}</td>`).join('')}</tr>`);
          i++;
        }
        out.push(`<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && lines[i].trim() && (/^\s*>/.test(lines[i]) || !startsBlock(i))) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${mdToHtml(quote.join('\n'))}</blockquote>`);
        continue;
      }
      if (LIST.test(line)) {
        const items = [];
        while (i < lines.length) {
          const m = LIST.exec(lines[i]);
          if (m) { items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), num: parseInt(m[2], 10), text: m[3] }); i++; continue; }
          if (!lines[i].trim()) {
            let k = i;
            while (k < lines.length && !lines[k].trim()) k++;
            if (k < lines.length && (LIST.test(lines[k]) || /^\s{2,}\S/.test(lines[k]))) { i = k; continue; }
            break;
          }
          if (/^\s{2,}\S/.test(lines[i]) || !startsBlock(i)) { items[items.length - 1].text += ` ${lines[i].trim()}`; i++; continue; }
          break;
        }
        let html = '';
        const stack = [];
        for (const it of items) {
          while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
          // ao mesmo nível, uma lista numerada a seguir a uma de pontos (ou o contrário) é outra lista
          if (stack.length && it.indent === stack[stack.length - 1].indent && stack[stack.length - 1].tag !== (it.ordered ? 'ol' : 'ul')) html += `</li></${stack.pop().tag}>`;
          const top = stack[stack.length - 1];
          if (!top || it.indent > top.indent) {
            const tag = it.ordered ? 'ol' : 'ul';
            stack.push({ indent: it.indent, tag });
            html += `<${tag}${it.ordered && it.num !== 1 ? ` start="${it.num}"` : ''}>`;
          } else html += '</li>';
          const task = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
          html += task ? `<li class="task"><input type="checkbox" disabled ${task[1] === ' ' ? '' : 'checked'}> ${mdInline(task[2])}` : `<li>${mdInline(it.text)}`;
        }
        while (stack.length) html += `</li></${stack.pop().tag}>`;
        out.push(html);
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !startsBlock(i)) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      out.push(`<p>${para.map((l, n) => mdInline(l.trim()) + (n < para.length - 1 ? (/ {2,}$/.test(l) ? '<br>' : ' ') : '')).join('')}</p>`);
    }
    return out.join('\n');
  }

  // -- dados --
  async function loadInfo(again) {
    const r = await call(api.app.info(again));
    if (r) state.info = r;
    renderRailFoot();
    syncCliPick();
    checkAuth(Boolean(again));
    $('#version-badge').textContent = state.info ? `v${state.info.version}` : '';
  }
  // light: só para contar (no arranque); a página Agentes pede a lista com os ficheiros de cada agente
  async function loadAgents(light = false) {
    const r = await call(api.agents.list(light));
    if (r) { state.agents = r.agents; state.stepList = r.steps || []; }
    $('#count-agentes').textContent = String(state.agents.length);
  }
  async function loadServices() {
    const r = await call(api.services.list());
    if (r) { state.services = r.services; state.root = r.root || ''; }
    $('#count-servicos').textContent = String(state.services.length);
  }
  async function loadTasks() {
    const r = await call(api.tasks.list());
    if (r) state.tasks = r.tasks;
    $('#count-tarefas').textContent = String(state.tasks.length);
  }
  let taskAskedAt = 0; // quando se pediu a tarefa pela última vez (os eventos que chegaram antes já vêm nela)
  async function loadTask(id) {
    taskAskedAt = Date.now();
    const r = await call(api.tasks.get(id));
    if (!r) return false;
    state.task = r.task;
    return true;
  }

  // -- o CLI que corre todos os agentes, no topo: o escolhido, e o que não está instalado assinalado --
  const CLI_NAME = { claude: 'Claude Code', copilot: 'Copilot CLI' };
  const cliNow = () => (state.info && state.info.cli) || 'claude';
  const cliFound = (c) => !state.info || Boolean(state.info.clis[c] && state.info.clis[c].found);
  function syncCliPick() {
    const sel = $('#cli-pick');
    if (!sel || !state.info) return;
    for (const o of sel.options) o.textContent = `${CLI_NAME[o.value]}${cliFound(o.value) ? '' : ' (não instalado)'}`;
    sel.value = cliNow();
    sel.closest('.cli-pick').classList.toggle('missing', !cliFound(cliNow()));
  }
  // -- a sessão no CLI escolhido: iniciada, ou não (com o botão para a iniciar) --
  state.auth = null; // { cli, loggedIn: true | false | null, who, detail }
  let authAsking = null;
  function paintAuth() {
    const el = $('#cli-auth');
    if (!el) return;
    const a = state.auth;
    const name = CLI_NAME[cliNow()];
    if (!cliFound(cliNow())) { el.innerHTML = ''; return; }
    if (!a || a.cli !== cliNow()) { el.className = 'cli-auth'; el.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>a ver a sessão…</span>'; return; }
    if (a.loggedIn) {
      el.className = 'cli-auth ok';
      el.innerHTML = `<span class="dot good" aria-hidden="true"></span><span title="${esc(a.who ? `Sessão iniciada no ${name}: ${a.who}` : `Sessão iniciada no ${name}`)}">sessão iniciada</span>`;
    } else if (a.loggedIn === false) {
      el.className = 'cli-auth off';
      el.innerHTML = `<span class="dot bad" aria-hidden="true"></span><span>sem sessão</span><button class="ib" type="button" data-act="cli-login" data-tip="Iniciar sessão no ${esc(name)}" aria-label="Iniciar sessão no ${esc(name)}">${icon('login')}</button>`;
    } else {
      el.className = 'cli-auth unknown';
      el.innerHTML = `<span class="dot" aria-hidden="true"></span><span title="${esc(a.detail || 'Não consegui saber')}">sessão?</span><button class="ib" type="button" data-act="cli-recheck" data-tip="Ver outra vez" aria-label="Ver outra vez a sessão">${icon('refresh')}</button><button class="ib" type="button" data-act="cli-login" data-tip="Iniciar sessão no ${esc(name)}" aria-label="Iniciar sessão no ${esc(name)}">${icon('login')}</button>`;
    }
  }
  async function checkAuth(fresh = false) {
    const cli = cliNow();
    if (!cliFound(cli)) { state.auth = null; paintAuth(); return; }
    if (!state.auth || state.auth.cli !== cli) { state.auth = null; paintAuth(); }
    const asked = (authAsking = call(api.app.auth(cli, fresh)));
    const r = await asked;
    if (asked !== authAsking || cli !== cliNow()) return; // entretanto mudou o CLI, ou já se perguntou de novo
    const before = state.auth && state.auth.cli === cli ? state.auth.loggedIn : undefined;
    state.auth = r || { cli, loggedIn: null };
    paintAuth();
    // o passo só muda (o botão de começar) se a sessão mudou; redesenhar levava a conversa ao topo
    if (before !== state.auth.loggedIn && state.view === 'tarefa' && state.task && currentDef()) showStep();
  }
  // quem foi iniciar sessão volta à janela: vê-se outra vez (só se ainda não estava iniciada)
  let authFocusAt = 0;
  addEventListener('focus', () => {
    if (!state.auth || state.auth.loggedIn === true || Date.now() - authFocusAt < 20000) return;
    authFocusAt = Date.now();
    checkAuth(true);
  });

  // -- a barra de estado da barra lateral --
  function renderRailFoot() {
    const i = state.info;
    if (!i) return;
    const dot = (ok) => `<span class="dot ${ok ? 'good' : 'warn'}"></span>`;
    const engine = i.engines.docker.found ? 'Docker' : i.engines.podman.found ? 'Podman' : '';
    $('#rail-foot').innerHTML = [
      [i.clis.claude.found, i.clis.claude.found ? `Claude CLI ${esc(i.clis.claude.version)}` : 'Claude CLI não encontrado'],
      [i.clis.copilot.found, i.clis.copilot.found ? `Copilot CLI ${esc(i.clis.copilot.version)}` : 'Copilot CLI não encontrado'],
      [Boolean(engine), engine ? `${engine} instalado` : 'Sem Docker nem Podman'],
    ].map(([ok, text]) => `<div class="r" title="${text}">${dot(ok)}<span>${text}</span></div>`).join('');
  }

  // -- vistas --
  const CRUMBS = { tarefas: 'Tarefas', agentes: 'Agentes', servicos: 'Serviços', definicoes: 'Definições', tarefa: 'Tarefas' };

  function setView(view) {
    state.view = view;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    const navOf = view === 'tarefa' ? 'tarefas' : view;
    $$('.rail-btn').forEach((a) => a.classList.toggle('active', a.dataset.view === navOf));
    $('#crumb-mode').textContent = CRUMBS[view];
    const ctx = view === 'tarefa' && state.task ? `${state.task.ref ? `${state.task.ref} · ` : ''}${state.task.title}` : '';
    $('#crumb-ctx').textContent = ctx;
    $('#crumb-sep').hidden = !ctx;
    const busy = view === 'tarefa' && state.task && state.task.running;
    $('#crumb-busy').hidden = !busy;
    if (busy) $('#crumb-busy-text').textContent = 'agente a trabalhar';
    syncOffice();
  }

  async function route() {
    const [view, id] = location.hash.slice(1).split('/');
    if (view === 'tarefa' && id) {
      if (!state.task || state.task.id !== id) {
        if (!(await loadTask(id))) { location.hash = 'tarefas'; return; }
        state.tab = state.tabOf[id] || 'documentos';
        state.sel = {};
      }
      await renderTask();
      setView('tarefa');
      return;
    }
    state.task = null;
    if (view === 'agentes') { await loadAgents(); renderAgents(); setView('agentes'); return; }
    if (view === 'servicos') { await loadServices(); renderServices(); setView('servicos'); return; }
    if (view === 'definicoes') { await Promise.all([loadInfo(), loadServices()]); renderSettings(); setView('definicoes'); return; }
    await loadTasks();
    renderTasks();
    setView('tarefas');
  }

  // ===== Tarefas =====
  const miniStep = (s) => ({ done: 'done', running: 'run', waiting: 'wait', paused: 'wait', interrupted: 'wait', stopped: 'wait', failed: 'bad' }[s] || '');
  const pill = (s) => `<span class="pill ${esc(s.tone)}">${s.live ? '<span class="dot accent live"></span>' : ''}${esc(s.text)}</span>`;

  function renderTasks() {
    const rows = state.tasks.map((t) => `
      <tr class="task-row" data-go="tarefa/${esc(t.id)}">
        <td>${t.ref ? `<span class="key">${esc(t.ref)}</span>` : ''}${esc(t.title)}</td>
        <td><span class="pill ${t.type === 'defeito' ? 'bad' : 'accent'}">${t.type === 'defeito' ? 'Defeito' : 'Requisito'}</span></td>
        <td>${t.documents}</td>
        <td><span class="mini-steps"><i class="${t.docsOk ? 'done' : ''}"></i>${Object.values(t.steps).map((s) => `<i class="${miniStep(s)}"></i>`).join('')}</span></td>
        <td>${pill(t.status)}</td>
        <td class="muted">${esc(when(t.updatedAt))}</td>
      </tr>`).join('');
    $('#view-tarefas').innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>Tarefas</h1><p class="sub">Um requisito ou um defeito: os documentos de entrada e, passo a passo, o que os agentes fazem com eles.</p></div>
        <button class="btn primary" data-act="new-task" type="button">Nova tarefa</button>
      </div>
      <div class="scroll">${state.root ? '' : '<div class="banner warn"><div class="grow"><b>Falta a pasta raiz dos microserviços.</b> É a partir dela que correm os agentes.</div><a class="btn small" href="#definicoes">Definir</a></div>'}${state.tasks.length ? `
        <div class="card"><table>
          <thead><tr><th>Tarefa</th><th>Tipo</th><th>Documentos</th><th>Passos</th><th>Estado</th><th>Atividade</th></tr></thead>
          <tbody>${rows}</tbody></table></div>` : `
        <div class="empty-state">
          <h2>Ainda não há tarefas</h2>
          <p>Uma tarefa começa com os documentos que descrevem o requisito ou o defeito. Depois, em cada passo, os agentes que ligaste a esse passo trabalham com eles, um a seguir ao outro.</p>
          <button class="btn primary" data-act="new-task" type="button">Nova tarefa</button>
        </div>`}</div>`;
  }

  // ===== Uma tarefa =====
  const stepClass = (s) => ({ done: 'done', running: 'running', waiting: 'waiting', paused: 'waiting', interrupted: 'waiting', stopped: 'waiting', failed: 'failed' }[s] || '');

  // o cabeçalho de uma tarefa, numa linha: voltar, nome, tipo · documentos · data, estado; à direita Editar nome e Apagar
  function taskHead(t) {
    const busy = t.running ? ' disabled title="Não se muda o nome com um agente a trabalhar"' : ' title="Mudar o nome da tarefa"';
    return `<div class="page-head task-head">
        <a class="btn small" href="#tarefas">← Tarefas</a>
        <h1 id="task-title" title="${esc(t.title)}">${t.ref ? `<span class="mono dim" style="font-weight:400">${esc(t.ref)}</span> ` : ''}${esc(t.title)}</h1>
        <span class="sub">${t.type === 'defeito' ? 'Defeito' : 'Requisito'} · ${t.documents.length} documento${t.documents.length === 1 ? '' : 's'} · criada ${esc(when(t.createdAt))}</span>
        ${pill(t.status)}
        <span class="spacer"></span>
        <button class="btn" data-act="rename-task" type="button"${busy}>Editar nome</button>
        <button class="btn bad" data-act="delete-task" type="button">Apagar</button>
      </div>`;
  }
  // volta a desenhar só o cabeçalho (e o caminho no topo), depois de mudar o nome
  function repaintHead() {
    const head = $('.task-head');
    if (head && state.task) head.outerHTML = taskHead(state.task);
    if (state.view === 'tarefa') setView('tarefa');
  }

  // Uma seta da barra dos passos: o ícone, o nome e a marca do estado; a cor diz o estado e a escolhida fica azul.
  // O pormenor (documentos, agentes, estado) fica na dica.
  const STEP_ICON = { documentos: 'doc', microservicos: 'nodes', implementacao: 'code', ambiente: 'server', testes: 'flask' };
  const STEP_MARK = { done: 'check', waiting: 'pause', failed: 'alert' };
  function stepArrow(id, name, cls, tip) {
    const on = state.tab === id;
    const mark = cls === 'running' ? '<span class="sa-live" aria-hidden="true"></span>' : STEP_MARK[cls] ? `<span class="sa-mark">${icon(STEP_MARK[cls])}</span>` : '';
    return `<button class="step-arrow ${cls}${on ? ' active' : ''}" data-tab="${esc(id)}" type="button" role="tab" aria-selected="${on}" title="${esc(tip)}">${icon(STEP_ICON[id] || 'doc')}<span class="sa-name">${esc(name)}</span>${mark}</button>`;
  }

  async function renderTask(opts = {}) {
    const t = state.task;
    if (!t) return;
    const nDocs = t.documents.length;
    const nSvc = (t.chosenServices || []).length;
    const tabs = [
      stepArrow('documentos', 'Documentos', nDocs ? 'done' : '', `Documentos · ${nDocs} documento${nDocs === 1 ? '' : 's'}`),
      stepArrow('microservicos', 'Microserviços', nSvc ? 'done' : '', `Microserviços · ${nSvc ? `${nSvc} escolhido${nSvc === 1 ? '' : 's'}` : 'nenhum escolhido (os agentes decidem)'}`),
    ].concat(t.stepDefs.map((s) => {
      const f = t.flow[s.id];
      const tip = f.status === 'idle' ? `${f.links.length} agente${f.links.length === 1 ? '' : 's'}, por começar` : (STATUS[f.status] || ['', f.status])[1];
      return stepArrow(s.id, s.name, stepClass(f.status), `${s.name} · ${tip}`);
    })).join('');
    $('#view-tarefa').innerHTML = `
      ${taskHead(t)}
      <div class="task">
        <div class="center">
          <div class="steps-bar" role="tablist" aria-label="Passos da tarefa">${tabs}</div>
          <div class="panel active" id="panel"></div>
        </div>
      </div>`;
    await renderPanel(opts);
    $('#crumb-busy').hidden = !t.running;
  }

  // desenha o passo outra vez com o que já se leu (sem voltar a pedir nada)
  function repaintStep() {
    const t = state.task;
    const def = currentDef();
    const el = $('#panel');
    if (!t || !def || !el) return;
    el.innerHTML = stepPanel(t, def);
    afterPaint();
  }
  const afterPaint = () => $$('input[data-indet]').forEach((x) => { x.indeterminate = true; });

  // light: um evento durante uma execução (sem voltar a pedir as entradas nem a consola, que os eventos mantêm em dia)
  async function renderPanel(opts = {}) {
    const t = state.task;
    const el = $('#panel');
    if (!t || !el) return;
    if (state.tab === 'documentos') { el.innerHTML = documentsPanel(t); return; }
    if (state.tab === 'microservicos') { if (!opts.light || !state.services.length) await loadServices(); el.innerHTML = servicesPanel(t); filterServices(); return; }
    const def = t.stepDefs.find((s) => s.id === state.tab);
    if (!def) { el.innerHTML = ''; return; }
    await loadStepData(t, def, opts);
    el.innerHTML = stepPanel(t, def);
    afterPaint();
    const body = $('#console-body');
    if (body) body.scrollTop = body.scrollHeight;
    // um pedido que ainda não tinhas visto (abriste a tarefa com o agente à espera): vai ter com ele
    const pend = (t.flow[def.id] && t.flow[def.id].pending) || [];
    if ($('#pending-box .perm') && pend.some((p) => !seenPending.has(p.id))) { pend.forEach((p) => seenPending.add(p.id)); focusPending(); }
  }

  // ---- Microserviços: os que a tarefa toca, escolhidos pela pessoa (vão no pedido a cada agente) ----
  function servicesPanel(t) {
    const chosen = new Set(t.chosenServices || []);
    const ed = !t.running;
    const names = new Set(state.services.map((s) => s.name));
    const missing = [...chosen].filter((n) => !names.has(n));
    // só o nome; os escolhidos ficam no topo (e os escolhidos que já não estão na pasta raiz, assinalados)
    const row = (name, gone = false) => `<label class="svc-row${chosen.has(name) ? ' on' : ''}${gone ? ' missing' : ''}" data-name="${esc(name.toLowerCase())}">
        <input type="checkbox" data-svc="${esc(name)}" ${chosen.has(name) ? 'checked' : ''} ${ed ? '' : 'disabled'}>
        <span class="svc-main"><b>${esc(name)}</b>${gone ? '<span class="hint">já não está na pasta raiz</span>' : ''}</span></label>`;
    const byName = (x, y) => x.localeCompare(y, undefined, { numeric: true });
    const all = state.services.map((s) => s.name).sort(byName);
    const list = [...all.filter((n) => chosen.has(n)).map((n) => row(n)), ...missing.sort(byName).map((n) => row(n, true)), ...all.filter((n) => !chosen.has(n)).map((n) => row(n))].join('');
    const picked = [...chosen];
    return `<div class="svc-step">
      <div class="card"><div class="card-head"><h2>Microserviços da tarefa</h2><span class="pill ${picked.length ? 'good' : ''}">${picked.length} de ${state.services.length}</span>
        ${ed ? `<span class="row" style="margin-left:auto"><button class="btn small" data-act="svc-all" type="button">Escolher os que se veem</button><button class="btn small" data-act="svc-none" type="button" ${picked.length ? '' : 'disabled'}>Limpar</button></span>` : ''}</div>
        <div class="card-body">
          <p class="hint">Escolhe os microserviços em que esta tarefa mexe. A escolha vai no pedido a cada agente (Implementação, Ambiente, Testes). <b>Se não escolheres nenhum</b>, os agentes descobrem sozinhos, como as suas skills dizem.</p>
          ${ed ? '' : '<div class="banner warn mt"><div class="grow">Há um agente a correr nesta tarefa: a escolha só muda quando acabar (ou se o parares).</div></div>'}
          ${state.root ? `<input type="search" id="svc-filter" class="svc-filter" placeholder="Procurar microserviço…" value="${esc(state.svcFilter || '')}" autocomplete="off" spellcheck="false">
          <div class="svc-list">${list || '<p class="muted">Não encontrei microserviços na pasta raiz.</p>'}</div>` : '<p class="muted mt">Define primeiro a pasta raiz dos microserviços, nas Definições.</p>'}
        </div></div>
      <div class="card"><div class="card-head"><h2>O que os agentes recebem</h2></div><div class="card-body">
        ${picked.length ? `<p>Cada agente recebe, no seu pedido:</p><blockquote class="svc-quote">Para esta tarefa, a pessoa escolheu ${picked.length === 1 ? 'este microserviço' : 'estes microserviços'}: ${picked.map((n) => `<b>${esc(n)}</b>`).join(', ')}. São estes os microserviços em causa: não precisas de os descobrir. Se achares que falta algum, diz qual e porquê antes de o usar.</blockquote>`
          : '<p class="muted">Nada sobre microserviços: cada agente decide pela sua skill (o de ambiente, por exemplo, segue a documentação e as chamadas entre serviços).</p>'}
      </div></div></div>`;
  }
  function filterServices() {
    const q = String(state.svcFilter || '').trim().toLowerCase();
    $$('.svc-row').forEach((r) => { r.hidden = Boolean(q) && !r.dataset.name.includes(q); });
  }
  async function saveServices(names) {
    const r = await call(api.tasks.setServices(taskId(), names));
    if (!r) return;
    state.task.chosenServices = r.chosenServices;
    await renderTask({ light: true }); // a lista de microserviços já cá está
  }

  // ---- Documentos (a lista limpa) ----
  // o explorador de ficheiros deste sistema, para os botões "Mostrar no ..."
  const FINDER = /Windows/i.test(navigator.userAgent) ? 'Explorador' : /Mac/i.test(navigator.userAgent) ? 'Finder' : 'gestor de ficheiros';
  const ICONS = {
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    finder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 7v11a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L22 12H8.2a2 2 0 0 0-1.9 1.4L4 20"/>',
    download: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
    replace: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15"/><path d="M4 20v-5h5"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    fileUp: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 17v-6"/><path d="M9.5 13.5L12 11l2.5 2.5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
    up: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    upload: '<path d="M12 16V5"/><path d="M7 10l5-5 5 5"/><path d="M5 20h14"/>',
    folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
    nodes: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v10M11 11.5L6.2 17.4M13 11.5l4.8 5.9"/>',
    code: '<path d="M8 8l-4 4 4 4"/><path d="M16 8l4 4-4 4"/><path d="M14 5l-4 14"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    flask: '<path d="M9 3h6"/><path d="M10 3v6l-5.6 9.5A1.7 1.7 0 0 0 5.9 21h12.2a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7.2 15h9.6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.4A8 8 0 1 1 21 12z"/>',
    fileCheck: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 14.5l2 2 4-4"/>',
    diff: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 10.5v5M9.5 13h5"/><path d="M9.5 18h5"/>',
    pause: '<path d="M9 6v12M15 6v12"/>',
    alert: '<path d="M12 6v8"/><path d="M12 18h.01"/>',
    paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 11h6M9 15h4"/>',
  };
  const icon = (n) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;
  const iconBtn = (n, tip, act, data, disabled) => `<button class="ib${n === 'trash' ? ' bad' : ''}" type="button" data-act="${act}" data-tip="${esc(tip)}" aria-label="${esc(tip)}" ${data} ${disabled ? 'disabled' : ''}>${icon(n)}</button>`;
  // o tipo de um ficheiro, pela extensão: a etiqueta e a cor
  const typeOf = (name) => {
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    if (['md', 'markdown', 'txt', 'rst', 'adoc'].includes(ext)) return ['t-md', ext === 'markdown' ? 'MD' : ext.toUpperCase()];
    if (['yaml', 'yml', 'json', 'xml', 'csv', 'sql', 'properties', 'toml'].includes(ext)) return ['t-yaml', ext === 'yml' ? 'YAML' : ext.toUpperCase().slice(0, 4)];
    if (ext === 'pdf') return ['t-pdf', 'PDF'];
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return ['t-img', ext === 'jpeg' ? 'JPG' : ext.toUpperCase()];
    if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt'].includes(ext)) return ['t-office', ext.toUpperCase().slice(0, 4)];
    return ['t-other', (ext || 'FICH').toUpperCase().slice(0, 4)];
  };
  const typeBadge = (d, small) => {
    if (d.kind === 'folder') return `<span class="dtype t-folder${small ? ' small' : ''}">PASTA</span>`;
    if (d.kind === 'text') return `<span class="dtype t-md${small ? ' small' : ''}">TEXTO</span>`;
    const [cls, lab] = typeOf(d.name);
    return `<span class="dtype ${cls}${small ? ' small' : ''}">${esc(lab)}</span>`;
  };
  // os agentes que já leram um documento: uma bolinha por agente, com a inicial
  const agentColor = (name) => {
    const colors = ['#2563eb', '#0d9488', '#ea580c', '#7c3aed', '#16a34a', '#db2777', '#b45309'];
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return colors[h % colors.length];
  };
  const readBy = (list) => (list && list.length ? `<span class="agents" title="Lido por: ${esc(list.join(', '))}">${list.map((n) => `<span class="agent-dot" style="background:${agentColor(n)}" title="${esc(n)}">${esc(n[0].toUpperCase())}</span>`).join('')}</span>` : '');

  function documentsPanel(t) {
    const usage = t.docUsage || {};
    const busy = t.running;
    const fileActs = (d, rel) => {
      const data = `data-id="${esc(d.id)}" data-rel="${esc(rel || '')}"`;
      return [
        iconBtn('eye', 'Ver', 'view-doc', data),
        iconBtn('copy', 'Copiar caminho', 'copy-doc-path', data),
        iconBtn('finder', `Mostrar no ${FINDER}`, 'reveal-doc', data),
        iconBtn('download', 'Descarregar', 'download-doc', data),
        iconBtn('fileUp', 'Substituir por outro ficheiro…', 'replace-doc', data, busy),
        '<span class="sep"></span>',
        iconBtn('trash', 'Tirar da tarefa', rel ? 'rm-doc-file' : 'rm-doc', data, busy),
      ].join('');
    };
    const folderActs = (d) => {
      const data = `data-id="${esc(d.id)}" data-rel=""`;
      return [
        iconBtn('plus', 'Juntar ficheiros a esta pasta', 'add-to-folder', data, busy),
        iconBtn('finder', `Mostrar no ${FINDER}`, 'reveal-doc', data),
        iconBtn('download', 'Descarregar a pasta (zip)', 'download-doc', data),
        '<span class="sep"></span>',
        iconBtn('trash', 'Tirar a pasta da tarefa', 'rm-doc', data, busy),
      ].join('');
    };
    const rows = t.documents.map((d) => {
      if (d.kind === 'folder') {
        const files = d.files || [];
        return `<div class="drow">${typeBadge(d)}<div class="dmain"><div class="dname">${esc(d.name)}<small>${files.length} ficheiro${files.length === 1 ? '' : 's'} · ${esc(size(d.size))} · ${esc(when(d.addedAt))}</small></div></div><span></span><span class="actions">${folderActs(d)}</span></div>
          ${files.length ? `<div class="dsub">${files.map((f) => `<div class="drow">${typeBadge({ kind: 'file', name: f.path }, true)}<span class="dfile" title="${esc(f.path)}">${esc(f.path)}${f.readable ? '' : ' <span class="pill warn">o agente não lê</span>'}</span><span class="dim dsize">${esc(size(f.size))}</span><span class="actions">${readBy(usage[`${d.rel}/${f.path}`])}${usage[`${d.rel}/${f.path}`] ? '<span class="sep"></span>' : ''}${fileActs(d, f.path)}</span></div>`).join('')}</div>` : ''}`;
      }
      return `<div class="drow">${typeBadge(d)}<div class="dmain"><div class="dname">${esc(d.name)}<small>${esc(size(d.size))} · ${esc(when(d.addedAt))}${d.replacedAt ? ` · substituído ${esc(when(d.replacedAt))}` : ''}</small>${d.readable ? '' : ' <span class="pill warn">o agente não lê este formato</span>'}</div>${d.excerpt ? `<div class="dexcerpt">${esc(d.excerpt)}</div>` : ''}${d.readable ? '' : '<div class="dexcerpt">Exporta-o para PDF ou Markdown, ou cola o texto, para o agente o usar.</div>'}</div>${readBy(usage[d.rel]) || '<span></span>'}<span class="actions">${fileActs(d, '')}</span></div>`;
    }).join('');
    const key = navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl';
    return `<div class="card docs-card">
        <div class="docs-head"><h2>Documentos de entrada</h2>
          <button class="btn" data-act="add-files" type="button">${icon('upload')}Ficheiros…</button><button class="btn" data-act="add-folder" type="button">${icon('folderPlus')}Pasta…</button><button class="btn" data-act="add-text" type="button">${icon('paste')}Colar texto</button></div>
        ${rows || '<div class="card-body muted">Ainda não há documentos. Junta o requisito ou a descrição do defeito.</div>'}
        <div class="docs-drop">${icon('upload')}<span><b>Arrasta ficheiros ou pastas para aqui</b>, ou cola com ${key}+V (texto, ficheiros copiados, capturas de ecrã).</span></div>
      </div>
      <p class="hint mt">Os agentes de cada passo recebem estes documentos tal como estão: a plataforma não os lê nem os interpreta. As bolinhas mostram que agentes já leram cada um.</p>`;
  }

  const seenPending = new Set(); // os pedidos dos agentes que a página já mostrou

  // ---- Um passo: a sequência de agentes, com conversa, produzido e alterações ----
  const MODEL_OPTS = [['', 'Padrão do Claude CLI'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
  const PERM_OPTS = [
    ['ask', 'Perguntar sempre', 'Cada comando de terminal pede-te autorização. O agente só escreve onde o passo deixa.'],
    ['read', 'Leitura sem perguntar', 'git status, diff e log, ls, cat, grep, find e afins correm logo; os outros perguntam.'],
    ['all', 'Tudo sem perguntar', 'Corre qualquer comando, menos os que a plataforma recusa sempre (push, sudo, mudar de branch…).'],
    ['plan', 'Só planear', 'Lê tudo, mas só escreve na sua pasta de resultados: não altera os microserviços nem corre comandos.'],
  ];
  const modelOpts = (tool) => (tool === 'copilot' ? [['', 'Padrão do Copilot CLI'], ['auto', 'Auto'], ...(state.copilotModels || []).map((m) => [m, m])] : MODEL_OPTS);
  const modelName = (m, tool) => (modelOpts(tool).find((o) => o[0] === m) || [m, m || modelOpts(tool)[0][1]])[1];
  const permName = (p) => (PERM_OPTS.find((o) => o[0] === p) || PERM_OPTS[0])[1];
  const permHelp = (p) => (PERM_OPTS.find((o) => o[0] === p) || PERM_OPTS[0])[2];
  const ms = (n) => (n == null ? '' : n < 1000 ? `${n} ms` : n < 60000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n / 60000)} min`);

  const selOf = (t, def) => {
    const f = t.flow[def.id];
    if (state.sel[def.id] !== undefined && f.links[state.sel[def.id]]) return state.sel[def.id];
    if (f.current !== null && f.current !== undefined && f.links[f.current]) return f.current;
    const lastRun = f.links.map((l) => l.status).lastIndexOf('done');
    return lastRun >= 0 ? lastRun : 0;
  };
  const modeOf = (def) => {
    const f = state.task && state.task.flow[def.id];
    const m = state.mode[def.id] || (f && f.status === 'idle' ? 'entradas' : 'conversa');
    return m === 'alteracoes' && !def.branch ? 'conversa' : m;
  };
  const allFiles = () => ((state.changes && state.changes.repos) || []).flatMap((r) => (r.files || []).map((f) => ({ repo: r.name, ...f })));

  // Os dados do passo à vista. Pede-se só o que pode ter mudado:
  // - as entradas e a consola, ao chegar ao passo ou a outro agente (com light, num evento, ficam: a consola mantém-se
  //   em dia com os eventos, e as entradas só mudam quando as mudas);
  // - as alterações (vários comandos git por repositório), só no separador Alterações;
  // - o que cada agente produziu, sempre (é pouco, e muda com o trabalho).
  async function loadStepData(t, def, { light = false } = {}) {
    const f = t.flow[def.id];
    if (!state.copilotModels && f.links.some((l) => l.tool === 'copilot')) {
      const m = await call(api.pipeline.models());
      state.copilotModels = (m && m.copilot) || [];
    }
    const i = f.preview || !f.links.length ? null : selOf(t, def);
    const here = state.loaded && state.loaded.task === t.id && state.loaded.step === def.id;
    if (!here) { state.changes = null; state.inputs = null; }
    const jobs = [];
    if (!light || !here || !state.inputs) jobs.push(call(api.pipeline.inputs(t.id, def.id)).then((r) => { state.inputs = r; }));
    if (def.branch && modeOf(def) === 'alteracoes') jobs.push(loadChanges(t));
    if (i === null) {
      state.entries = [];
      state.outputsAll = [];
    } else {
      if (!light || !here || state.loaded.sel !== i) jobs.push(call(api.pipeline.console(t.id, def.id, i)).then((r) => { state.entries = r ? r.entries : []; }));
      jobs.push(Promise.all(f.links.map((l, n) => call(api.pipeline.outputs(t.id, def.id, n)))).then((outs) => {
        state.outputsAll = f.links.map((l, n) => ({ name: l.name, index: n, files: outs[n] ? outs[n].files : [] }));
      }));
    }
    await Promise.all(jobs);
    state.loaded = { task: t.id, step: def.id, sel: i };
  }
  // As alterações dos microserviços da tarefa (git): só quando se mostram
  async function loadChanges(t) {
    const r = await call(api.pipeline.changes(t.id));
    if (state.task && state.task.id === t.id) state.changes = r || { repos: [] };
  }
  // redesenha o passo e leva a conversa ao fim
  function showStep() {
    repaintStep();
    const body = $('#console-body');
    if (body) body.scrollTop = body.scrollHeight;
  }

  // um comando de terminal, partido nos && ; | e com cores: o programa, as opções, os textos entre aspas, os operadores
  function formatCmd(cmd) {
    const s = String(cmd || '');
    const parts = [];
    let cur = '';
    let q = null;
    let depth = 0;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (q) { cur += c; if (c === q && (q === "'" || s[k - 1] !== '\\')) q = null; continue; }
      if (c === "'" || c === '"') { q = c; cur += c; continue; }
      if (c === '\\' && k + 1 < s.length) { cur += c + s[++k]; continue; }
      if (c === '(') depth++;
      if (c === ')') depth = Math.max(0, depth - 1);
      const two = s.slice(k, k + 2);
      if (!depth && (two === '&&' || two === '||')) { parts.push({ text: cur, op: two }); cur = ''; k++; continue; }
      if (!depth && (c === '|' || c === ';' || c === '\n')) { parts.push({ text: cur, op: c === '\n' ? '' : c }); cur = ''; continue; }
      cur += c;
    }
    parts.push({ text: cur, op: '' });
    // as cores: o programa, as opções, os textos entre aspas, os operadores
    const paint = (text) => {
      let first = true;
      return (text.match(/'[^']*'?|"(?:[^"\\]|\\.)*"?|\s+|[^\s'"]+/g) || []).map((t) => {
        if (/^\s/.test(t)) return t;
        if (/^['"]/.test(t)) { first = false; return `<span class="cs">${esc(t)}</span>`; }
        if (first && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { first = false; return `<span class="cc">${esc(t)}</span>`; }
        if (/^--?[A-Za-z]/.test(t)) return `<span class="cf">${esc(t)}</span>`;
        return esc(t);
      }).join('');
    };
    const lines = [];
    let indent = false;
    for (const p of parts) {
      const text = p.text.trim();
      if (!text && !p.op) continue;
      lines.push(`${lines.length ? (indent ? '  ' : '') : '<span class="cp">$ </span>'}${paint(text)}${p.op ? `${p.op === ';' ? '' : ' '}<span class="co">${esc(p.op)}</span>` : ''}`);
      indent = ['&&', '||', '|'].includes(p.op);
    }
    return lines.join('\n');
  }
  // o texto de um agente: parágrafos, listas, negrito e código, sem HTML de fora
  const agentText = (s) => String(s || '').split(/\n{2,}/).map((p) => {
    const lines = p.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${rich(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    if (lines.length > 1 && lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${rich(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    if (/^#{1,4}\s/.test(p)) return `<p><b>${rich(p.replace(/^#{1,4}\s+/, ''))}</b></p>`;
    return `<p>${lines.map(rich).join('<br>')}</p>`;
  }).join('');
  const resultHtml = (r) => `<div class="cmd-meta">${r.err ? '<span class="pill bad">erro</span>' : '<span class="pill good">terminou</span>'}${r.ms != null ? `<span>${esc(ms(r.ms))}</span>` : ''}</div>${r.b ? `<pre class="cmd-out">${esc(r.b)}</pre>` : ''}`;

  function entryHtml(e, results, who) {
    if (e.k === 'say') return `<div class="bubble agent"><div class="bubble-who">Agente: ${esc(who || 'sem nome')}</div><div class="bubble-text">${agentText(e.a)}</div></div>`;
    if (e.k === 'user') return `<div class="bubble me"><div class="bubble-who">tu</div><div class="bubble-text">${esc(e.a).replace(/\n/g, '<br>')}</div></div>`;
    if (e.k === 'tool' && e.a === 'Bash') {
      const r = results && e.id ? results.get(e.id) : null;
      return `<div class="ev tool cmdline" data-cmd-id="${esc(e.id || '')}"><span class="k">Bash</span><div class="cmdwrap"><pre class="cmd">${formatCmd(e.b)}</pre>${r ? resultHtml(r) : ''}</div></div>`;
    }
    // por baixo de um comando: só o que a plataforma decidiu (o comando já está em cima)
    if (e.a === 'Bash' && e.k === 'ok') return `<div class="ev note good">✓ ${esc(String(e.b).split(' · ').pop())}</div>`;
    if (e.a === 'Bash' && e.k === 'ask') return '<div class="ev note warn">● pediu a tua autorização</div>';
    if (e.a === 'Bash' && e.k === 'deny') return `<div class="ev note bad">✕ ${esc(e.c || 'recusado')}</div>`;
    if (e.k === 'tool') return `<div class="ev tool"><span class="k">${esc(e.a)}</span><span class="path">${esc(e.b)}</span></div>`;
    if (e.k === 'ok') return `<div class="ev ok"><span class="k">${esc(e.a === 'Bash' ? 'ok' : e.a)}</span><span class="path">${esc(e.b)}</span></div>`;
    if (e.k === 'deny') return `<div class="ev deny"><span class="k">${esc(e.a)}</span><span><span class="path">${esc(e.b)}</span>${e.c ? `<div class="why">${esc(e.c)}</div>` : ''}</span></div>`;
    if (e.k === 'ask') return `<div class="ev ask"><span class="k">pedido</span><span class="path">${esc(e.a)} · ${esc(String(e.b).slice(0, 160))}</span></div>`;
    if (e.k === 'wait') return `<div class="ev wait"><span class="k">${esc(e.a)}</span><span>${esc(e.b)}</span></div>`;
    if (e.k === 'start') return `<div class="ev start"><span class="k">${esc(hm(e.at))}</span><span class="path">${esc(e.a)} · ${esc(e.b)}</span></div>`;
    return '';
  }
  function consoleHtml(entries, who) {
    const results = new Map(entries.filter((e) => e.k === 'result').map((e) => [e.id, e]));
    return entries.filter((e) => e.k !== 'result').map((e) => entryHtml(e, results, who)).join('');
  }

  function pendingHtml(pending) {
    return (pending || []).map((p) => {
      if (p.tool === 'AskUserQuestion') {
        const qs = (p.input && Array.isArray(p.input.questions)) ? p.input.questions : [];
        return `<div class="perm" data-req="${esc(p.id)}"><div class="title"><span class="dot warn live"></span>O agente pergunta</div>
          ${qs.map((q, n) => `<div class="question-block" data-q="${n}" data-question="${esc(q.question)}"><b>${esc(q.question)}</b>
            <div class="q-options">${(q.options || []).map((o) => `<label class="q-option"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q-${esc(p.id)}-${n}" value="${esc(o.label)}"><span><b>${esc(o.label)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></label>`).join('')}
              <label class="q-option"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q-${esc(p.id)}-${n}" value="__outra"><span><b>Outra</b><input type="text" class="q-other" placeholder="Escreve a tua resposta"></span></label></div></div>`).join('')}
          <div class="actions"><button class="btn primary small" data-act="answer-question" data-req="${esc(p.id)}" type="button">Responder</button><button class="btn small deny" data-act="perm" data-choice="deny" data-req="${esc(p.id)}" type="button">Não responder</button></div></div>`;
      }
      const what = p.tool === 'Bash' ? `<pre class="cmd">${formatCmd(p.summary)}</pre>` : `<code>${esc(p.summary)}</code>`;
      return `<div class="perm" data-req="${esc(p.id)}"><div class="title"><span class="dot warn live"></span>Pedido de permissão · ${esc(p.tool)}</div>${what}
        <div class="actions"><button class="btn primary small" data-act="perm" data-choice="allow" data-req="${esc(p.id)}" type="button">Permitir</button><button class="btn small" data-act="perm" data-choice="always" data-req="${esc(p.id)}" type="button">Permitir nesta tarefa</button><button class="btn small deny" data-act="perm" data-choice="deny" data-req="${esc(p.id)}" type="button">Recusar</button></div></div>`;
    }).join('');
  }

  // linhas acrescentadas e tiradas, com uma barrinha
  const counts = (add, del) => {
    if (add == null && del == null) return '<span class="counts dim">binário</span>';
    const a = add || 0;
    const d = del || 0;
    const t = a + d || 1;
    const na = Math.round((a / t) * 5);
    const nd = d ? Math.max(1, Math.min(5 - na, Math.round((d / t) * 5))) : 0;
    return `<span class="counts"><span class="ca">+${a}</span><span class="cd">−${d}</span><span class="cbar">${'<i class="a"></i>'.repeat(na)}${'<i class="d"></i>'.repeat(nd)}${'<i></i>'.repeat(Math.max(0, 5 - na - nd))}</span></span>`;
  };
  const stLabel = (s) => (s === '?' ? 'A' : s);
  const fileRow = (r, x, sel) => `<button class="f-row${sel && sel.repo === r.name && sel.path === x.path ? ' sel' : ''}" type="button" data-file="${esc(r.name)}|${esc(x.path)}" title="${esc(x.path)}"><span class="st st-${esc(stLabel(x.status))}">${esc(stLabel(x.status))}</span><span class="fname">${esc(x.path)}</span>${counts(x.added, x.removed)}</button>`;

  // ---- As entradas de um passo: os documentos que os agentes recebem ----
  function inputsView(t, def, f) {
    const r = state.inputs;
    if (!r) return '<p class="muted">Não consegui ler as entradas deste passo.</p>';
    const ed = r.editable;
    const box = (items, label) => {
      const on = items.filter((x) => x.on).length;
      return `<input type="checkbox" data-keys="${esc(JSON.stringify(items.map((x) => x.key)))}" ${on === items.length ? 'checked' : ''} ${on && on < items.length ? 'data-indet' : ''} ${ed ? '' : 'disabled'} aria-label="${esc(label)}">`;
    };
    const extraId = (key) => key.split(':')[1];
    const trash = (id) => `<button class="ib bad" type="button" data-act="remove-step-input" data-id="${esc(id)}" data-tip="Tirar deste passo" aria-label="Tirar deste passo">${icon('trash')}</button>`;
    const view = (x) => `<button class="ib" type="button" data-act="view-input" data-key="${esc(x.key)}" data-tip="Ver" aria-label="Ver">${icon('eye')}</button>`;
    const row = (g, x, sub) => `<div class="in-row${x.on ? '' : ' off'}${sub ? ' sub' : ''}">
        <label class="in-pick">${box([x], x.name)}${typeBadge({ kind: 'file', name: x.name }, true)}<span class="fname" title="${esc(x.name)}">${esc(x.name)}</span></label>
        ${x.readable ? '' : '<span class="pill" title="O agente não lê este formato (Word, Excel, zip…)">não lido</span>'}<span class="dim dsize">${esc(size(x.size || 0))}</span>${view(x)}${g.kind === 'extra' && !sub && ed ? trash(extraId(x.key)) : '<span class="ib-sp"></span>'}</div>`;
    const set = (g, s) => {
      if (!s.title) return s.items.map((x) => row(g, x, false)).join('');
      const on = s.items.filter((x) => x.on).length;
      const badge = g.kind === 'out' ? '<span class="in-agent">agente</span>' : typeBadge({ kind: 'folder', name: s.title }, true);
      return `<div class="in-set"><div class="in-row head${on ? '' : ' off'}"><label class="in-pick">${box(s.items, s.title)}${badge}<span class="fname"><b>${esc(s.title)}</b></span></label>
        <span class="dim">${on} de ${s.items.length}</span>${g.kind === 'extra' && ed ? trash(extraId(s.items[0].key)) : '<span class="ib-sp"></span>'}</div>${s.items.map((x) => row(g, x, true)).join('')}</div>`;
    };
    const groups = r.groups.map((g) => {
      const items = g.sets.flatMap((s) => s.items);
      const on = items.filter((x) => x.on).length;
      const adders = g.kind === 'extra' && ed ? `<div class="row in-add"><button class="btn small" data-act="add-step-files" type="button">${icon('upload')}Ficheiros…</button><button class="btn small" data-act="add-step-folder" type="button">${icon('folderPlus')}Pasta…</button><span class="hint">ou arrasta, ou cola, para esta página</span></div>` : '';
      return `<section class="in-group">
        <div class="in-gh">${items.length ? box(items, g.title) : '<span class="in-gap"></span>'}<span class="in-gt"><b>${esc(g.title)}</b><small>${esc(g.note)}</small></span>${items.length ? `<span class="dim">${on} de ${items.length}</span>` : ''}</div>
        ${items.length ? `<div class="in-list">${g.sets.map((s) => set(g, s)).join('')}</div>` : g.kind === 'extra' ? '' : '<p class="muted in-empty">Nenhum.</p>'}${adders}</section>`;
    }).join('');
    return `<div class="inputs">
      <p class="hint">Os agentes deste passo recebem os documentos escolhidos, com o caminho de cada um. Os que tirares não lhes são entregues, e a plataforma recusa que os leiam.</p>
      ${ed ? '' : '<div class="banner warn"><div class="grow">Há um agente a correr nesta tarefa: as entradas só mudam quando acabar (ou se o parares).</div></div>'}
      ${groups}
      ${f.links.length > 1 ? '<p class="hint">Cada agente recebe também o que os agentes antes dele, neste passo, produzirem.</p>' : ''}</div>`;
  }

  // ---- As diferenças de um ficheiro, numa janela: antes e depois lado a lado, ou numa coluna ----
  function diffItems(d) {
    if (d.untracked) {
      const lines = String(d.text || '').replace(/\n$/, '').split('\n');
      return [{ kind: 'hunk', range: `ficheiro novo · ${lines.length} linha${lines.length === 1 ? '' : 's'}`, oldStart: 0, oldCount: 0 }, ...lines.map((text, n) => ({ kind: 'line', type: 'add', newNo: n + 1, text }))];
    }
    const items = [];
    let o = 0;
    let n = 0;
    let started = false;
    for (const line of String(d.patch || '').split('\n')) {
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
      if (h) {
        started = true;
        o = Number(h[1]);
        n = Number(h[3]);
        items.push({ kind: 'hunk', oldStart: o, oldCount: h[2] === undefined ? 1 : Number(h[2]), range: line.replace(/ @@.*$/, ' @@'), context: h[5] || '' });
        continue;
      }
      if (!started || line === '') continue;
      const text = line.slice(1);
      if (line[0] === '-') items.push({ kind: 'line', type: 'del', oldNo: o++, text });
      else if (line[0] === '+') items.push({ kind: 'line', type: 'add', newNo: n++, text });
      else if (line[0] === '\\') items.push({ kind: 'note', text: 'Sem mudança de linha no fim do ficheiro' });
      else items.push({ kind: 'line', type: 'ctx', oldNo: o++, newNo: n++, text });
    }
    return items;
  }
  // as palavras que mudaram entre uma linha tirada e a que a substituiu (só quando as duas ainda se parecem)
  function wordMarks(a, b) {
    const ta = a.match(/\w+|\s+|[^\w\s]/g) || [];
    const tb = b.match(/\w+|\s+|[^\w\s]/g) || [];
    if (!ta.length || !tb.length || ta.length * tb.length > 40000) return null;
    const m = ta.length;
    const n = tb.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ka = new Array(m).fill(false);
    const kb = new Array(n).fill(false);
    for (let i = 0, j = 0; i < m && j < n;) {
      if (ta[i] === tb[j]) { ka[i] = true; kb[j] = true; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
    }
    if (ta.filter((x, k) => ka[k]).join('').trim().length < Math.max(a.length, b.length) * 0.3) return null;
    const html = (toks, keep) => toks.map((x, k) => (keep[k] ? esc(x) : `<span class="dl-word">${esc(x)}</span>`)).join('');
    return [html(ta, ka), html(tb, kb)];
  }
  const SIGN = { add: '+', del: '−', ctx: '' };
  const codeOf = (row, html) => `<span class="dl-code">${html || esc(row.text) || ' '}</span>`;
  function diffHtml(items, split, full, isNew) {
    const out = [];
    let dels = [];
    let adds = [];
    let prevEnd = null;
    const cell = (row, side, html) => (row
      ? `<div class="ds-cell ${row.type}"><span class="dl-no">${(side === 'left' ? row.oldNo : row.newNo) ?? ''}</span><span class="dl-sign">${SIGN[row.type]}</span>${codeOf(row, html)}</div>`
      : '<div class="ds-cell empty"><span class="dl-no"></span><span class="dl-sign"></span><span class="dl-code"> </span></div>');
    const line = (row, html, first) => `<div class="dl ${row.type}"${first ? ' data-g' : ''}><span class="dl-no">${row.oldNo ?? ''}</span><span class="dl-no">${row.newNo ?? ''}</span><span class="dl-sign">${SIGN[row.type]}</span>${codeOf(row, html)}</div>`;
    const flush = () => {
      const m = Math.max(dels.length, adds.length);
      const words = Array.from({ length: m }, (x, k) => (dels[k] && adds[k] ? wordMarks(dels[k].text, adds[k].text) : null));
      if (split) for (let k = 0; k < m; k++) out.push(`<div class="ds"${k === 0 ? ' data-g' : ''}>${cell(dels[k], 'left', words[k] && words[k][0])}${cell(adds[k], 'right', words[k] && words[k][1])}</div>`);
      else {
        dels.forEach((row, k) => out.push(line(row, words[k] && words[k][0], k === 0)));
        adds.forEach((row, k) => out.push(line(row, words[k] && words[k][1], k === 0 && !dels.length)));
      }
      dels = [];
      adds = [];
    };
    if (full) out.push('<div class="df df-full"><span>A mostrar o ficheiro inteiro</span><button class="df-show" type="button" data-dm="fold">Só as alterações</button></div>');
    for (const it of items) {
      if (it.kind === 'line' && it.type === 'del') { if (adds.length) flush(); dels.push(it); continue; }
      if (it.kind === 'line' && it.type === 'add') { adds.push(it); continue; }
      flush();
      if (it.kind === 'hunk') {
        const gap = prevEnd === null ? it.oldStart - 1 : it.oldStart - prevEnd;
        prevEnd = it.oldStart + it.oldCount;
        if (!full && !isNew && gap > 0) out.push(`<div class="df"><span>${gap} linha${gap === 1 ? '' : 's'} sem alterações</span><button class="df-show" type="button" data-dm="full">Mostrar tudo</button></div>`);
        if (!full) out.push(`<div class="dh">${it.context ? `<span class="dh-ctx">${esc(it.context)}</span>` : ''}<span class="dh-range">${esc(it.range)}</span></div>`);
      } else if (it.kind === 'note') out.push(`<div class="dl-note">${esc(it.text)}</div>`);
      else if (split) out.push(`<div class="ds">${cell(it, 'left')}${cell(it, 'right')}</div>`);
      else out.push(line(it));
    }
    flush();
    return `<div class="diff-lines${split ? ' split' : ''}">${out.join('')}</div>`;
  }
  async function openDiff(repo, file, full = false) {
    const t = state.task;
    if (!t) return;
    const r = await call(api.pipeline.fileDiff(t.id, repo, file, full));
    if (!r) return;
    const keepTop = state.diffOpen && state.diffOpen.repo === repo && state.diffOpen.file === file;
    state.diffOpen = { repo, file, full, d: r, idx: -1 };
    paintDiff();
    $('#modal-diff').classList.add('open');
    if (!keepTop) $('#dm-body').scrollTop = 0;
  }
  function paintDiff() {
    const o = state.diffOpen;
    if (!o) return;
    const d = o.d;
    const rec = allFiles().find((x) => x.repo === o.repo && x.path === o.file) || {};
    const repo = ((state.changes && state.changes.repos) || []).find((x) => x.name === o.repo) || {};
    const st = stLabel(rec.status || (d.untracked ? '?' : 'M'));
    $('#dm-status').textContent = st;
    $('#dm-status').className = `st st-${st}`;
    const slash = o.file.lastIndexOf('/');
    $('#dm-path').innerHTML = `<span class="dp-dir">${esc(o.repo)}/${esc(o.file.slice(0, slash + 1))}</span><span class="dp-base">${esc(o.file.slice(slash + 1))}</span>`;
    $('#dm-path').title = `${o.repo}/${o.file}`;
    $('#dm-stats').innerHTML = rec.added == null ? '' : `<span class="add">+${rec.added}</span><span class="del">−${rec.removed || 0}</span>`;
    $$('#dm-layout button').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.diffMode));
    const split = state.diffMode === 'split';
    $('#dm-left').textContent = d.untracked ? 'o ficheiro não existia' : `commit ${String(d.base || '').slice(0, 7)}, antes da tarefa`;
    $('#dm-right').textContent = `${repo.current || repo.branch || 'o branch da tarefa'}, como está agora`;
    $('#dm-cols').hidden = !split || d.binary;
    const note = d.binary ? 'Ficheiro binário: não se mostra.' : [d.untracked ? 'Ficheiro novo: ainda não está num commit.' : '', d.truncated ? 'Cortado: o ficheiro é grande demais para mostrar inteiro.' : ''].filter(Boolean).join(' ');
    $('#dm-note').textContent = note;
    $('#dm-note').hidden = !note;
    $('#dm-body').innerHTML = d.binary ? '' : diffHtml(diffItems(d), split, o.full, Boolean(d.untracked));
    diffPos();
  }
  function diffPos() {
    const g = $$('#dm-body [data-g]');
    const o = state.diffOpen;
    $('#dm-pos').textContent = !g.length ? 'sem alterações' : o.idx < 0 ? `${g.length} alteraç${g.length === 1 ? 'ão' : 'ões'}` : `${o.idx + 1} de ${g.length}`;
    $('#dm-prev').disabled = !g.length || o.idx <= 0;
    $('#dm-next').disabled = !g.length || o.idx >= g.length - 1;
  }
  function diffGo(step) {
    const g = $$('#dm-body [data-g]');
    const o = state.diffOpen;
    if (!g.length || !o) return;
    o.idx = Math.max(0, Math.min(g.length - 1, o.idx + step));
    $('#dm-body').scrollTop = g[o.idx].offsetTop - 40;
    g.forEach((x, k) => x.classList.toggle('dg-here', k === o.idx));
    diffPos();
  }

  // ---- As dúvidas na última mensagem do agente: uma caixa de resposta por dúvida ----
  // Procura uma secção cujo título fale de dúvidas, perguntas, assunções, decisões ou questões em aberto e junta os
  // itens de lista que estão por baixo; sem secção, os itens que acabam em "?". Cada dúvida: a etiqueta (o início a
  // negrito, ou as primeiras palavras) e o texto.
  const DOUBT_HEAD = /(d[úu]vidas?|perguntas?|assun[çc][õo]es|decis[õo]es|em aberto|quest[õo]es|preciso de saber|para confirmar|confirma[çc][õo]es)/i;
  const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
  function doubtsOf(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const isHead = (l) => {
      const t = l.trim();
      if (!t || t.length > 90 || LIST_ITEM.test(t) && !/^\d+[.)]\s+\*\*.*\*\*:?\s*$/.test(t)) return false;
      const bare = t.replace(/^#{1,6}\s*/, '').replace(/^\d+[.)]\s*/, '').replace(/\*\*/g, '').trim();
      const looksHead = /^#{1,6}\s/.test(t) || /^\*\*.*\*\*:?$/.test(t.replace(/^\d+[.)]\s*/, '')) || /:$/.test(bare);
      return looksHead && DOUBT_HEAD.test(bare);
    };
    const anyHead = (l) => {
      const t = l.trim();
      return Boolean(t) && t.length <= 90 && !LIST_ITEM.test(t) && (/^#{1,6}\s/.test(t) || /^\*\*.*\*\*:?$/.test(t) || /^\d+[.)]\s+\*\*.*\*\*:?$/.test(t));
    };
    const collect = (from) => {
      const items = [];
      for (let k = from; k < lines.length; k++) {
        const l = lines[k];
        if (!l.trim()) {
          // uma linha em branco acaba a lista, a não ser que o item seguinte continue
          const next = lines.slice(k + 1).find((x) => x.trim());
          if (!next || !LIST_ITEM.test(next)) break;
          continue;
        }
        if (k > from && anyHead(l) && !LIST_ITEM.test(l)) break;
        const m = LIST_ITEM.exec(l);
        if (m) items.push(m[1].trim());
        else if (items.length) items[items.length - 1] += ` ${l.trim()}`;
        else break;
      }
      return items;
    };
    let items = [];
    for (let k = 0; k < lines.length; k++) {
      if (!isHead(lines[k])) continue;
      items.push(...collect(k + 1));
    }
    if (!items.length) items = lines.map((l) => LIST_ITEM.exec(l)).filter((m) => m && /\?\s*\**\s*$/.test(m[1])).map((m) => m[1].trim());
    return items.slice(0, 12).map((raw) => {
      const b = /^\*\*(.+?)\*\*\s*:?\s*(.*)$/.exec(raw) || /^\*\*(.+?):\*\*\s*(.*)$/.exec(raw);
      // sem negrito, a etiqueta é a pergunta inteira
      if (!b) return { label: raw.slice(0, 200), text: '' };
      return { label: b[1].replace(/:$/, '').trim().slice(0, 120), text: b[2].trim() };
    });
  }

  // a caixa das respostas: uma por dúvida; o que se escreve fica guardado se a página se redesenhar
  function doubtsHtml(doubts, key) {
    const drafts = state.doubtDrafts || {};
    return `<div class="doubts" id="doubts-box" data-key="${esc(key)}">
      <div class="doubts-head"><b>Responder às dúvidas do agente</b><span class="hint">Uma resposta por dúvida. As que deixares em branco seguem a assunção do agente. Cmd+Enter envia.</span></div>
      <ol class="doubts-list">${doubts.map((q, n) => `<li>
        <div class="doubt-q"><b>${rich(q.label)}</b>${q.text ? `<span class="doubt-text">${rich(q.text.length > 220 ? `${q.text.slice(0, 220)}…` : q.text)}</span>` : ''}</div>
        <textarea class="doubt-a" rows="1" data-n="${n}" data-label="${esc(q.label)}" placeholder="A tua resposta (em branco: segue a assunção do agente)">${esc(drafts[`${key}|${n}`] || '')}</textarea></li>`).join('')}</ol>
      <div class="row"><button class="btn primary small" data-act="send-doubts" type="button">Enviar respostas</button><span class="hint">Vão todas numa só mensagem, numeradas.</span></div></div>`;
  }

  function stepPanel(t, def) {
    const f = t.flow[def.id];
    const running = t.running && f.status === 'running';
    const otherRunning = t.running && !running;
    const editable = !t.running;
    const reasons = [];
    if (!t.documents.length) reasons.push('junta pelo menos um documento');
    if (!state.root) reasons.push('define a pasta raiz nas Definições');
    if (!f.links.length) reasons.push('liga pelo menos um agente a este passo, na página Agentes');
    if (otherRunning) reasons.push('há outro passo desta tarefa a correr');
    if (!cliFound(cliNow())) reasons.push(`o ${CLI_NAME[cliNow()]} não está neste computador: escolhe o outro em "Agentes em", no topo`);
    else if (state.auth && state.auth.cli === cliNow() && state.auth.loggedIn === false) reasons.push(`o ${CLI_NAME[cliNow()]} não tem sessão iniciada: carrega no ícone de entrar, no topo`);
    const canStart = !reasons.length && ['idle', 'done', 'failed', 'stopped', 'interrupted'].includes(f.status);
    const i = f.links.length ? selOf(t, def) : 0;
    const link = f.links[i];
    const mode = modeOf(def);

    // à esquerda: a sequência, com o modelo e as permissões de cada agente
    const single = f.links.length === 1;
    const seq = f.links.map((l, n) => {
      const st = l.settings || { model: '', perm: 'ask' };
      const used = { model: l.model !== undefined && running ? l.model : st.model, perm: l.perm !== undefined && running ? l.perm : st.perm };
      const off = editable ? '' : ' disabled title="Não se muda com um agente a trabalhar nesta tarefa"';
      const choices = `<div class="choices">
          <label class="f">Modelo · ${l.tool === 'copilot' ? 'Copilot CLI' : 'Claude Code'}<select data-setting="model" data-agent="${esc(l.agentId)}"${off}>${(() => { const opts = modelOpts(l.tool); return (opts.some((o) => o[0] === used.model) ? opts : [...opts, [used.model, used.model]]).map(([v, lab]) => `<option value="${esc(v)}" ${used.model === v ? 'selected' : ''}>${esc(lab)}</option>`).join(''); })()}</select></label>
          <label class="f">Permissões<select data-setting="perm" data-agent="${esc(l.agentId)}"${off}>${PERM_OPTS.map(([v, lab]) => `<option value="${v}" ${used.perm === v ? 'selected' : ''}>${lab}</option>`).join('')}</select></label>
          <div class="perm-help" data-help="${esc(l.agentId)}">${esc(permHelp(used.perm))}</div></div>`;
      // o que fica por baixo do nome: a pausa e os tokens
      const meta = l.pause || l.tokens ? `<span class="seq-meta">${l.pause ? '<span class="pill" title="A sequência pára depois deste agente até aprovares">pausa depois</span>' : ''}${l.tokens ? `<span class="dim">${esc(tokens(l.tokens))}</span>` : ''}</span>` : '';
      // um só agente: o nome e o estado vão para o cabeçalho do cartão; aqui ficam só a pausa, os tokens e as escolhas
      if (single) return `<div class="seq-row solo">${meta ? `<div class="seq-solo-meta">${meta}</div>` : ''}${choices}</div>`;
      return `<div class="seq-row${n === i ? ' active' : ''}"><button class="seq-pick" type="button" data-sel="${n}"><span class="seq-main"><span class="seq-title"><span class="seq-name"><span class="dim">Agente:</span> <b>${esc(l.name)}</b></span>${statusPill(l.status)}</span>${meta}</span></button>${choices}</div>`;
    }).join('');
    const inSummary = state.inputs ? `<button class="in-summary" type="button" data-mode="entradas">${icon('eye')}<span>${state.inputs.on === state.inputs.total ? `Recebem ${state.inputs.total} documento${state.inputs.total === 1 ? '' : 's'}` : `Recebem ${state.inputs.on} de ${state.inputs.total} documentos`}</span><span class="dim">Entradas</span></button>` : '';
    const controls = `${inSummary}<div class="step-acts">
      ${canStart ? `<button class="btn primary" data-act="start-step" type="button">${f.status === 'idle' ? 'Começar' : 'Correr o passo de novo'}</button>` : ''}
      ${f.status === 'paused' ? '<button class="btn good" data-act="continue-step" type="button">Aprovar e continuar</button>' : ''}
      ${running ? '<button class="btn bad" data-act="stop-step" type="button">Parar</button>' : ''}
    </div>${!canStart && reasons.length && !running && f.status !== 'paused' ? `<p class="hint mt">Para começar: ${esc(reasons.join('; '))}.</p>` : ''}
    ${def.freeze && !f.freeze ? '<p class="hint mt">Neste passo o código fica congelado: o agente só escreve na sua pasta e nas coleções Bruno dos microserviços (no branch da tarefa), e no fim a plataforma confirma que o resto do código não mudou.</p>' : ''}`;
    const repos = (state.changes && state.changes.repos) || [];
    // os microserviços onde a tarefa já criou o branch: da tarefa, sem perguntar ao git
    const touched = Object.keys((t.git && t.git.repos) || {});
    const branchCard = def.branch ? `<div class="card"><div class="card-head"><h2>Branch da tarefa</h2></div><div class="card-body">
        ${touched.length ? `<p><code>${esc(t.branch)}</code></p>` : `<div class="row" style="flex-wrap:nowrap"><input type="text" id="branch-in" value="${esc(t.branch)}" autocomplete="off" spellcheck="false"><button class="btn" data-act="save-branch" type="button" style="height:34px">Guardar</button></div>`}
        <p class="hint mt">${touched.length ? `Criado em ${touched.length} microserviço${touched.length === 1 ? '' : 's'}. Sem push.` : 'Criado em cada microserviço antes da primeira alteração do agente; recusado se esse microserviço tiver alterações por guardar. Sem push.'}</p></div></div>` : '';
    const left = `<div class="step2-side">
      <div class="card"><div class="card-head">${single ? `<h2 class="seq-head" title="${esc(f.links[0].name)}"><span class="dim">Agente:</span> ${esc(f.links[0].name)}</h2>${statusPill(f.links[0].status)}` : `<h2>Sequência</h2>${f.links.length ? `<span class="pill">${f.links.length} agentes</span>` : ''}`}</div><div class="seq">${seq || '<p class="muted" style="padding:12px">Sem agentes. Liga-os na página Agentes.</p>'}</div><div class="card-body">${controls}</div></div>
      ${branchCard}</div>`;

    // à direita: avisos, e Conversa · Produzido · Alterações
    const alerts = (t.alerts || []).filter((x) => x.step === def.id && !x.resolved && !x.dismissed).map((x) => `
      <div class="banner bad alert-box"><div class="grow"><b>Recusado: ${esc(x.repo)}</b> · ${esc(hm(x.at))}${x.count > 1 ? ` · ${x.count} tentativas` : ''}<div>${esc(x.text)}</div>
        ${x.files && x.files.length ? `<div class="alert-files mono">${x.files.slice(0, 8).map(esc).join('<br>')}${(x.total || x.files.length) > 8 ? `<br>… e mais ${(x.total || x.files.length) - 8}` : ''}</div>` : ''}</div>
        <div class="row"><button class="btn small" data-act="alert-resolve" data-id="${esc(x.id)}" type="button">${x.kind === 'dirty' || x.kind === 'moved' ? 'Já guardei, tentar de novo' : 'Já resolvi'}</button><button class="btn small" data-act="alert-dismiss" data-id="${esc(x.id)}" type="button">Fechar</button></div></div>`).join('');
    const freeze = def.freeze && f.freeze && f.freeze.checkedAt ? (f.freeze.changed.length ? `<div class="banner bad"><div class="grow"><b>O código mudou durante os testes</b> em ${esc(f.freeze.changed.join(', '))}. Os resultados não valem como prova.</div></div>` : '<div class="freeze"><span class="dot good"></span><b>Código congelado:</b> confirmado no fim, nenhum microserviço mudou durante este passo.</div>') : '';
    const nDocs = state.outputsAll.reduce((s, o) => s + o.files.length, 0);
    const nFiles = state.changes ? allFiles().length : null;
    const nIn = state.inputs ? (state.inputs.on === state.inputs.total ? state.inputs.total : `${state.inputs.on}/${state.inputs.total}`) : null;
    const tabs = [['entradas', 'Entradas', nIn, 'inbox'], ['conversa', 'Conversa', null, 'chat'], ['produzido', 'Produzido', nDocs, 'fileCheck'], ...(def.branch ? [['alteracoes', 'Alterações', nFiles, 'diff']] : [])];
    const seg = `<div class="seg big">${tabs.map(([v, lab, c, ic]) => `<button type="button" data-mode="${v}" class="${mode === v ? 'active' : ''}">${icon(ic)}${lab}${c != null ? ` <span class="pill">${c}</span>` : ''}</button>`).join('')}</div>`;

    let headExtra = '';
    let body;
    if (mode === 'entradas') {
      body = inputsView(t, def, f);
    } else if (mode === 'conversa') {
      if (link && !f.preview) {
        const live = running && f.current === i;
        const stuck = ['interrupted', 'failed', 'stopped'].includes(link.status);
        // a conversa continua sempre que nada corre na tarefa: também depois de o agente ter terminado
        const canReply = live || (Boolean(link.sessionId) && !t.running && link.status !== 'pending');
        headExtra = `<span class="row run-actions">${[
          f.current === i && !otherRunning && (live || link.status === 'waiting' || stuck) ? `<button class="ib good" data-act="done-link" type="button" data-tip="Dar por terminado (segue para o próximo)" aria-label="Dar este agente por terminado e seguir para o próximo">${icon('check')}</button>` : '',
          !t.running && link.sessionId && stuck ? `<button class="ib accent" data-act="resume-link" type="button" data-tip="Retomar a conversa onde parou" aria-label="Retomar a conversa do agente onde parou">${icon('play')}</button>` : '',
        ].join('')}</span>`;
        body = `${link.error ? `<div class="banner bad"><div class="grow">${esc(link.error)}</div></div>` : ''}
          <div class="console-body chat" id="console-body" aria-live="polite">${consoleHtml(state.entries, link.name) || '<div class="console-empty">Aqui aparece, ao vivo, o que o agente diz, lê, escreve e corre.</div>'}</div>
          ${(() => {
            // as dúvidas da última mensagem do agente, se ele falou por último e está à espera (ou já parou)
            const kinds = state.entries.map((e) => e.k);
            const sayAt = kinds.lastIndexOf('say');
            if (!canReply || link.status === 'running' || sayAt < 0 || sayAt < kinds.lastIndexOf('user')) return '';
            const doubts = doubtsOf(state.entries[sayAt].a);
            return doubts.length ? doubtsHtml(doubts, `${t.id}|${def.id}|${i}|${state.entries[sayAt].at || sayAt}`) : '';
          })()}
          <div id="pending-box">${live ? pendingHtml(f.pending) : ''}</div>
          ${canReply ? `<div class="console-input"><input type="text" id="msg-in" placeholder="${live ? 'Escrever ao agente…' : link.status === 'done' ? 'Escrever ao agente para continuar a conversa (o passo volta a correr)…' : 'Escrever ao agente para o retomar…'}" autocomplete="off"><button class="btn primary" data-act="send-msg" type="button">Enviar</button></div>` : ''}`;
      } else {
        body = `<div class="empty-state"><h2>${esc(def.name)}</h2><p>${esc(def.summary)}</p><p class="muted">Escolhe à esquerda o modelo e as permissões de cada agente e carrega em Começar. Os agentes correm pela ordem; cada um recebe os documentos e o que os anteriores produziram, e dá o trabalho por terminado escrevendo FEITO.md.</p></div>`;
      }
    } else if (mode === 'produzido') {
      const docs = state.outputsAll.map((o) => `<div class="prod-agent"><h3>${esc(o.name)}</h3>${o.files.length ? o.files.map((x) => `<div class="doc-out">${typeBadge({ kind: 'file', name: x.path }, true)}<span class="fname">${esc(x.path)}</span><span class="dim dsize">${esc(size(x.size))}</span><button class="ib" type="button" data-act="view-output" data-index="${o.index}" data-rel="${esc(x.path)}" data-tip="Ver" aria-label="Ver">${icon('eye')}</button></div>`).join('') : '<p class="muted">Ainda nada.</p>'}</div>`).join('');
      body = `<div class="prod">${state.outputsAll.length ? docs : '<p class="muted">Ainda nada: aqui aparecem os documentos que os agentes deste passo escrevem na sua pasta de resultados.</p>'}</div>`;
    } else if (!state.changes) {
      body = '<div class="scan-wait"><span class="spinner" aria-hidden="true"></span>A ler as alterações dos microserviços…</div>';
    } else {
      headExtra = repos.length ? `<button class="btn small" data-act="refresh-changes" type="button" style="margin-left:auto">Atualizar</button>` : '';
      body = repos.length ? `<p class="hint">Os ficheiros alterados em cada microserviço, desde o início da tarefa (com o que ainda não está em commit). Clica num ficheiro para ver as diferenças.</p>
        <div class="changes-list">${repos.map((r) => `<div class="repo">
          <div class="repo-h"><span class="repo-t"><b>${esc(r.name)}</b><small>${esc(r.current || r.branch)} · desde ${esc(String(r.base || '').slice(0, 7))} · ${(r.files || []).length} ficheiro${(r.files || []).length === 1 ? '' : 's'}${r.commits && r.commits.length ? ` · ${r.commits.length} commit${r.commits.length === 1 ? '' : 's'}` : ''}</small></span>${counts(r.added, r.removed)}</div>
          ${r.missing ? '<p class="muted" style="padding:8px 10px">A pasta já não existe.</p>' : (r.files || []).length ? (r.files || []).map((x) => fileRow(r, x, null)).join('') : '<p class="muted" style="padding:8px 10px">Sem alterações.</p>'}</div>`).join('')}</div>`
        : '<div class="empty-state"><h2>Sem alterações</h2><p>Os microserviços desta tarefa ainda não foram alterados.</p></div>';
    }

    return `<div class="step2">${left}<div class="step2-main">${alerts}${freeze}
      <div class="card main2"><div class="card-head">${seg}${headExtra}</div><div class="card-body">${body}</div></div></div></div>`;
  }

  // ===== Agentes =====
  function renderAgents() {
    const toolName = (x) => (x.tool === 'copilot' ? 'Copilot CLI' : 'Claude Code');
    const stepOpts = (x) => [...state.stepList.map((s) => [s.id, s.name]), ['', 'Nenhum (só disponível)']].map(([v, n]) => `<option value="${v}" ${x.step === v ? 'selected' : ''}>${esc(n)}</option>`).join('');
    const KIND = { agent: 'agente', skill: 'skill', ref: 'ref' };
    // a pasta comum em migalhas: os três últimos nomes, com o do pack em destaque
    const crumbs = (base) => {
      const segs = String(base || '').split(/[\\/]/).filter(Boolean);
      const last = segs.slice(-3);
      const strong = /^(\.?claude|copilot|\.github)$/i.test(last[last.length - 1] || '') ? last.length - 2 : last.length - 1;
      return `${segs.length > 3 ? '<span>…</span><span class="sep">›</span>' : ''}${last.map((s, k) => (k === strong ? `<b>${esc(s)}</b>` : `<span>${esc(s)}</span>`)).join('<span class="sep">›</span>')}`;
    };
    const card = (x, n, items, step) => {
      const data = (p) => `data-id="${esc(x.id)}" data-agfile="${esc(p)}"`;
      const files = (x.files || []).map((f) => `<div class="ag-file${f.kind === 'ref' ? ' sub' : ''}${f.missing ? ' missing' : ''}">
          <span class="kind ${f.kind}">${KIND[f.kind]}</span><span class="fname" title="${esc(f.path)}">${esc(f.rel)}</span>
          <span class="acts">${f.missing ? '<span class="pill bad">não encontrado</span>' : iconBtn('eye', 'Ver', 'view-agent-file', data(f.path))}${f.kind === 'ref' ? '' : iconBtn('copy', 'Copiar caminho', 'copy-agent-path', data(f.path)) + (f.missing ? '' : iconBtn('finder', `Mostrar no ${FINDER}`, 'reveal-agent-file', data(f.path)))}</span></div>`).join('');
      return `<article class="ag-card">
        <div class="ag-head">
          ${step ? `<span class="seq-n">${n + 1}</span>` : ''}<span class="ag-name" title="${esc(x.description || '')}">${esc(x.name)}</span>
${x.kind === 'agent' ? '' : '<span class="pill mauve">só skill</span>'}
          <span class="ag-acts">
            ${step ? `${iconBtn('up', 'Subir na sequência', 'move-agent', `data-id="${esc(x.id)}" data-dir="-1"`, n === 0)}${iconBtn('down', 'Descer na sequência', 'move-agent', `data-id="${esc(x.id)}" data-dir="1"`, n === items.length - 1)}<span class="vsep"></span>` : ''}
            <select data-step-of="${esc(x.id)}" aria-label="Passo de ${esc(x.name)}">${stepOpts(x)}</select>
            ${step ? `<label class="ag-pause" title="A sequência pára depois deste agente até carregares em Aprovar e continuar"><input type="checkbox" data-pause="${esc(x.id)}" ${x.pause ? 'checked' : ''}> Pausa depois</label>` : ''}
            <span class="vsep"></span>${iconBtn('trash', 'Tirar da plataforma', 'rm-agent', `data-id="${esc(x.id)}"`)}
          </span>
        </div>
        <div class="ag-crumbs" title="${esc(x.base || '')}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS.folder}</svg>${crumbs(x.base)}${iconBtn('finder', `Mostrar a pasta no ${FINDER}`, 'reveal-agent-file', data(x.base || ''))}${iconBtn('copy', 'Copiar caminho da pasta', 'copy-agent-path', data(x.base || ''))}${iconBtn('refresh', 'Ler a pasta de novo', 'refresh-agent', `data-id="${esc(x.id)}"`)}</div>
        <div class="ag-files">${files || '<p class="muted">Sem ficheiros.</p>'}</div>
      </article>`;
    };
    const group = (step, title, items) => `
      <section class="agent-group">
        <div class="agent-group-head"><h2>${esc(title)}</h2><span class="dim">${items.length ? `${items.length} agente${items.length === 1 ? '' : 's'}${step ? ', por esta ordem' : ''}` : 'sem agentes'}</span>
          <button class="btn small" data-act="add-agent" data-step="${esc(step)}" type="button" style="margin-left:auto">Adicionar a partir de pasta</button></div>
        <div class="ag-list">${items.map((x, n) => card(x, n, items, step)).join('') || '<p class="muted">Adiciona os agentes deste passo a partir da pasta onde estão.</p>'}</div>
      </section>`;
    const groups = state.stepList.map((s) => group(s.id, s.name, state.agents.filter((x) => x.step === s.id)));
    const loose = state.agents.filter((x) => !x.step);
    $('#view-agentes').innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>Agentes</h1><p class="sub">Em cada passo, os agentes correm por esta ordem: cada um começa quando o anterior termina. A plataforma lê os ficheiros onde estão e não os copia.</p></div>
        <button class="btn primary" data-act="add-agent" type="button">Adicionar a partir de pasta</button>
      </div>
      <div class="scroll">${groups.join('')}${loose.length ? group('', 'Sem passo', loose) : ''}</div>`;
  }

  function openAgentModal(step) {
    state.scan = null;
    $('#ma-path').value = '';
    $('#ma-found').hidden = true;
    $('#ma-add').disabled = true;
    $('#ma-step').value = step || '';
    $('#modal-agente').classList.add('open');
  }

  async function scanFolder() {
    const folder = $('#ma-path').value.trim();
    if (!folder) return toast('Indica uma pasta', true);
    const r = await call(api.agents.scan(folder));
    if (!r) return;
    state.scan = r;
    const many = r.found.length > 6;
    $('#ma-count').innerHTML = r.found.length ? `Encontrados ${r.found.length} em <code>${esc(r.folder)}</code>${many ? ' (escolhe os que queres)' : ''}` : `Nada encontrado em <code>${esc(r.folder)}</code>. Procuro <code>agents/*.md</code> e <code>SKILL.md</code>, até 5 níveis.`;
    $('#ma-list').innerHTML = r.found.map((f, i) => `
      <label class="det"><input type="checkbox" data-rel="${i}" ${many ? '' : 'checked'}><span><span class="n">${esc(f.name)} <span class="pill ${f.kind === 'agent' ? '' : 'mauve'}">${f.kind === 'agent' ? 'agente' : 'skill'}</span><span class="pill">${f.tool === 'copilot' ? 'Copilot CLI' : 'Claude Code'}</span></span><span class="p">${esc(f.rel)}</span>${f.description ? `<span class="d">${esc(f.description)}</span>` : ''}</span></label>`).join('');
    $('#ma-found').hidden = false;
    $('#ma-add').disabled = !r.found.length;
  }

  async function addAgents() {
    if (!state.scan) return;
    const items = $$('#ma-list input:checked').map((c) => state.scan.found[Number(c.dataset.rel)].rel);
    if (!items.length) return toast('Escolhe pelo menos um ficheiro', true);
    const r = await call(api.agents.add({ folder: state.scan.folder, items, step: $('#ma-step').value }));
    if (!r) return;
    $('#modal-agente').classList.remove('open');
    toast(`${r.added.length} adicionado${r.added.length === 1 ? '' : 's'}`);
    await loadAgents();
    renderAgents();
  }

  // ===== Serviços =====
  function renderServices() {
    const rows = state.services.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td class="mono">${esc(s.branch) || '<span class="dim">—</span>'}</td></tr>`).join('');
    const body = !state.root ? `
        <div class="empty-state"><h2>Falta a pasta raiz</h2><p>Define nas Definições a pasta onde estão todos os microserviços. As subpastas aparecem aqui, e é a partir dela que correm os agentes.</p><a class="btn primary" href="#definicoes">Definir a pasta raiz</a></div>`
      : state.services.length ? `<div class="card"><table><thead><tr><th>Microserviço</th><th>Branch</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="empty-state"><h2>Nenhum microserviço em ${esc(state.root)}</h2><p>Confirma que a pasta raiz é a que os tem, ou muda-a nas Definições.</p><a class="btn" href="#definicoes">Definições</a></div>`;
    $('#view-servicos').innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>Serviços</h1><p class="sub">${state.root ? `Os microserviços em <code>${esc(state.root)}</code>, um por subpasta.` : 'Os microserviços que as tarefas podem envolver.'}</p></div>
        <button class="btn" data-act="refresh-services" type="button">Atualizar</button>
        <a class="btn" href="#definicoes">Pasta raiz</a>
      </div>
      <div class="scroll">${body}</div>`;
  }

  // ===== Definições =====
  function renderSettings() {
    const i = state.info;
    if (!i) { $('#view-definicoes').innerHTML = ''; return; }
    const cli = (c, hint) => (c.found ? `${esc(c.version) || 'versão desconhecida'} · <code>${esc(c.file)}</code>` : `<span style="color:var(--red)">não encontrado</span> · ${hint}`);
    $('#view-definicoes').innerHTML = `
      <div class="page-head"><div class="grow"><h1>Definições</h1><p class="sub">O que a plataforma encontrou neste computador.</p></div><button class="btn" data-act="recheck" type="button">Voltar a verificar</button></div>
      <div class="scroll"><div class="settings-layout"><div class="settings">
        <div class="card"><div class="card-head"><h2>Pasta raiz dos microserviços</h2>${state.root ? `<span class="pill good" style="margin-left:auto">${state.services.length} microserviço${state.services.length === 1 ? '' : 's'}</span>` : '<span class="pill warn" style="margin-left:auto">por definir</span>'}</div><div class="card-body">
          <p class="muted">A pasta onde estão todos os microserviços, um por subpasta. Os agentes correm a partir dela.</p>
          <div class="row mt" style="flex-wrap:nowrap"><input type="text" id="root-in" value="${esc(state.root)}" placeholder="C:\\Projetos" autocomplete="off" spellcheck="false"><button class="btn" data-act="pick-root" type="button" style="height:34px">Escolher…</button><button class="btn primary" data-act="save-root" type="button" style="height:34px">Guardar</button></div>
          ${state.root && !state.services.length ? '<p class="hint mt">Não encontrei microserviços nesta pasta.</p>' : ''}</div></div>
        <div class="card"><div class="card-head"><h2>Agentes de linha de comandos</h2></div><div class="card-body"><dl class="kv">
          <dt>Claude CLI</dt><dd>${cli(i.clis.claude, 'instala com <code>npm install -g @anthropic-ai/claude-code</code> e abre-o uma vez para iniciar sessão')}</dd>
          <dt>Copilot CLI</dt><dd>${cli(i.clis.copilot, 'instala com <code>npm install -g @github/copilot</code> e corre <code>copilot login</code> uma vez para iniciar sessão')}</dd></dl>
          <p class="hint mt">A plataforma não tem modelo próprio: os agentes correm nestas CLI, com a tua conta. O que um agente lê vai para o fornecedor dele.</p></div></div>
        <div class="card"><div class="card-head"><h2>Motores</h2></div><div class="card-body"><dl class="kv">
          <dt>Docker</dt><dd>${cli(i.engines.docker, 'para o passo Ambiente')}</dd><dt>Podman</dt><dd>${cli(i.engines.podman, 'alternativa ao Docker')}</dd><dt>Git</dt><dd>${cli(i.engines.git, 'para o branch da tarefa')}</dd></dl></div></div>
        <div class="card"><div class="card-head"><h2>Dados</h2></div><div class="card-body"><dl class="kv"><dt>Pasta</dt><dd><code>${esc(i.dataDir)}</code></dd><dt>Conteúdo</dt><dd>tarefas (documentos, o que os agentes fizeram e produziram, linha de tempo), agentes e a pasta raiz. Não vai para o Git.</dd></dl>
          <div class="row mt"><button class="btn small" data-act="open-path" data-path="${esc(i.dataDir)}" type="button">Abrir pasta</button></div></div></div>
      </div>${foundServicesCard()}</div></div>`;
  }

  function foundServicesCard() {
    const rows = state.services.map((s) => `
      <div class="found-row"><div class="found-main"><b>${esc(s.name)}</b></div>
        <div class="found-meta mono">${s.branch ? esc(s.branch) : '<span class="dim">sem branch</span>'}</div></div>`).join('');
    const body = !state.root ? '<p class="muted">Define a pasta raiz e os microserviços que lá estão aparecem aqui.</p>'
      : state.services.length ? `<div class="found-list">${rows}</div>`
        : `<p class="muted">Não encontrei microserviços em <code>${esc(state.root)}</code>.</p>`;
    return `<div class="card found-card"><div class="card-head"><h2>Microserviços encontrados</h2>${state.root ? `<span class="pill ${state.services.length ? 'good' : 'warn'}" style="margin-left:auto">${state.services.length}</span>` : ''}<button class="btn small" data-act="refresh-found" type="button" ${state.root ? '' : 'disabled'}>Atualizar</button></div>
      <div class="card-body">${body}</div></div>`;
  }

  // ===== Nova tarefa =====
  function openNewTask() {
    state.newTask = { files: [], folders: [], type: 'requisito' };
    $('#mt-title-in').value = '';
    $('#mt-ref').value = '';
    $('#mt-text').value = '';
    $$('#mt-type button').forEach((b) => b.classList.toggle('active', b.dataset.v === 'requisito'));
    renderPicked();
    $('#modal-tarefa').classList.add('open');
    $('#mt-title-in').focus();
  }
  function renderPicked() {
    const n = state.newTask;
    $('#mt-picked').innerHTML = [...n.files.map((f, i) => ({ f, i, kind: 'files' })), ...n.folders.map((f, i) => ({ f, i, kind: 'folders' }))].map(({ f, i, kind }) =>
      `<div class="item"><span title="${esc(f)}">${kind === 'folders' ? 'Pasta · ' : ''}${esc(basename(f))}</span><button type="button" data-unpick="${kind}:${i}" aria-label="Tirar">✕</button></div>`).join('');
  }
  async function createTask() {
    const title = $('#mt-title-in').value.trim();
    if (!title) { toast('Dá um título à tarefa', true); return; }
    const text = $('#mt-text').value.trim();
    const r = await call(api.tasks.create({
      title, ref: $('#mt-ref').value.trim(), type: state.newTask.type,
      files: state.newTask.files, folders: state.newTask.folders,
      text: text ? { name: 'descricao', content: text } : null,
    }));
    if (!r) return;
    $('#modal-tarefa').classList.remove('open');
    state.task = null;
    location.hash = `tarefa/${r.task.id}`;
  }

  // ===== Ações =====
  const taskId = () => (state.task ? state.task.id : '');
  const stepId = () => state.tab;
  const currentDef = () => (state.task ? state.task.stepDefs.find((s) => s.id === state.tab) : null);
  const linkIndex = () => (currentDef() ? selOf(state.task, currentDef()) : 0);
  async function reloadTask(opts = {}) {
    if (!state.task) return;
    const keep = $('#msg-in') ? $('#msg-in').value : '';
    if (await loadTask(state.task.id)) {
      await renderTask(opts);
      setView('tarefa');
      if (keep && $('#msg-in')) $('#msg-in').value = keep;
    }
  }

  // ---- O escritório: enquanto um agente trabalha, uma bola no canto inferior esquerdo mostra por cima dela a sala do
  // passo, com os agentes a andar conforme os eventos da consola (office.js, carregado só da primeira vez) ----
  const office = { mod: null, inst: null, key: '', task: '', step: '', loading: false };
  const ACTIVE = ['running', 'waiting'];
  // com um pedido por responder o agente continua "a correr" para a plataforma, mas para ti está à tua espera
  const linkState = (f, n) => (f.links[n].status === 'running' && f.current === n && (f.pending || []).length ? 'waiting' : f.links[n].status);
  const isLive = (t, id) => Boolean(t.flow[id] && t.flow[id].links.some((l) => ACTIVE.includes(l.status)));
  // o passo com um agente a trabalhar: o que estás a ver, se for esse, ou o que estiver a correr
  const activeStep = (t) => (t && t.running ? t.stepDefs.find((d) => d.id === state.tab && isLive(t, d.id)) || t.stepDefs.find((d) => isLive(t, d.id)) || null : null);
  const officeKey = (t, step) => `${t.id}|${step}|${t.flow[step].links.map((l) => l.agentId || l.name).join(',')}`;
  const officeOpen = () => !$('#office-pop').hidden;
  function syncOffice() {
    const t = state.task;
    const ball = $('#office-ball');
    const inTask = state.view === 'tarefa' && t;
    const def = inTask ? activeStep(t) : null;
    if (officeOpen() && (!inTask || t.id !== office.task || !t.flow[office.step])) { closeOffice(); return; }
    // outro passo começou a trabalhar e o da sala já não: a sala passa para esse
    if (officeOpen() && def && def.id !== office.step && !isLive(t, office.step) && !office.loading) { showOffice(def.id); return; }
    // com a sala à vista a bola fica, mesmo depois de o passo terminar: vês o agente ir para o sofá, e fechas tu
    const shown = def || (officeOpen() ? t.stepDefs.find((d) => d.id === office.step) : null);
    ball.hidden = !shown;
    ball.setAttribute('aria-expanded', String(officeOpen()));
    if (shown) {
      const f = t.flow[shown.id];
      const n = f.links.findIndex((x) => ACTIVE.includes(x.status));
      const st = n >= 0 ? linkState(f, n) : 'done';
      ball.dataset.state = st;
      faceFromStatus(t, shown.id, n, st, f);
      ball.title = `${officeOpen() ? 'Esconder' : 'Ver'} o escritório · ${shown.name}: ${n >= 0 ? `${f.links[n].name} ${st === 'waiting' ? 'à tua espera' : 'a trabalhar'}` : 'ninguém a trabalhar'}`;
      ball.setAttribute('aria-label', ball.title);
    }
    if (!officeOpen() || office.loading) return;
    if (officeKey(t, office.step) !== office.key) { showOffice(office.step); return; }
    if (office.inst) t.flow[office.step].links.forEach((l, n) => office.inst.setStatus(n, linkState(t.flow[office.step], n)));
  }
  // ---- A cara do robô na bola: a expressão segue o agente que a bola mostra. O estado da plataforma manda
  // (à tua espera, terminou, falhou); enquanto corre, os eventos da consola dizem se pensa, usa ferramentas ou escreve ----
  const face = { ref: '', mood: 'thinking', timer: null };
  const RUN_MOODS = ['thinking', 'working', 'writing'];
  function setMood(mood, after) {
    clearTimeout(face.timer);
    face.mood = mood;
    // estados de passagem: escrever volta a pensar, a festa do fim volta ao repouso
    if (after) face.timer = setTimeout(() => { if (face.mood === mood) { face.mood = after; paintFace(); } }, mood === 'writing' ? 2500 : 3200);
    paintFace();
  }
  function paintFace() {
    const ball = $('#office-ball');
    if (!ball) return;
    const box = $('#msg-in');
    // estás a escrever ao agente: ele ouve (só enquanto não há erro)
    const typing = box && document.activeElement === box && box.value.trim() && face.mood !== 'error';
    ball.dataset.face = typing ? 'listening' : face.mood;
  }
  function faceFromStatus(t, step, n, st, f) {
    const ref = `${t.id}|${step}|${n}`;
    if (ref !== face.ref) { face.ref = ref; face.mood = ''; }
    if (st === 'waiting') { if (face.mood !== 'approval') setMood('approval'); return; }
    if (st === 'running') { if (!RUN_MOODS.includes(face.mood)) setMood('thinking'); else paintFace(); return; }
    // ninguém a trabalhar: como acabou o último agente que correu
    const ss = f.links.map((l) => l.status);
    const end = ss.includes('failed') ? 'error' : ss.some((s) => s === 'stopped' || s === 'interrupted') ? 'sleeping' : 'success';
    if (face.mood === end || (end === 'success' && face.mood === 'idle')) { paintFace(); return; }
    setMood(end, end === 'success' ? 'idle' : null);
  }
  function faceFromEntry(e) {
    const a = String(e.a || '');
    switch (e.k) {
      case 'start': case 'user': case 'result': return setMood('thinking');
      case 'tool': return setMood('working');
      case 'say': return setMood('writing', 'thinking');
      case 'ask': case 'wait': return setMood('approval');
      case 'ok': if (a === 'Terminou') return setMood('success', 'idle'); return face.mood === 'approval' ? setMood('thinking') : null;
      case 'deny':
        if (a === 'Parou') return setMood('error');
        if (a === 'Parado') return setMood('sleeping');
        return face.mood === 'approval' ? setMood('thinking') : null;
      default: return null;
    }
  }
  document.addEventListener('input', (e) => { if (e.target && e.target.id === 'msg-in') paintFace(); });
  document.addEventListener('focusout', (e) => { if (e.target && e.target.id === 'msg-in') setTimeout(paintFace, 0); });
  function closeOffice() {
    $('#office-pop').hidden = true;
    if (office.inst) office.inst.pause(); // escondida não gasta: retoma onde estava
    syncOffice();
  }
  async function showOffice(step) {
    const t = state.task;
    const def = step ? t && t.stepDefs.find((d) => d.id === step) : activeStep(t);
    if (!t || !def || !t.flow[def.id] || !t.flow[def.id].links.length) return;
    const f = t.flow[def.id];
    const pop = $('#office-pop');
    const msg = $('#office-msg');
    pop.hidden = false;
    pop.setAttribute('aria-label', `O escritório dos agentes do passo ${def.name}`);
    Object.assign(office, { loading: true, task: t.id, step: def.id });
    try {
      office.mod = office.mod || (await import('./office.js'));
      const key = officeKey(t, def.id);
      if (!office.inst || office.key !== key) {
        if (office.inst) office.inst.destroy();
        office.inst = null;
        office.key = key; // mesmo que falhe: não se volta a tentar sozinho, só quando carregas na bola
        office.inst = office.mod.createOffice({ stage: pop, names: f.links.map((l) => l.name) });
      }
      msg.hidden = true;
      // cada agente começa onde a consola diz que está; daí em diante anda com os eventos que chegam
      const cons = await Promise.all(f.links.map((l, n) => (l.status === 'pending' ? null : call(api.pipeline.console(t.id, def.id, n)))));
      const fNow = state.task && state.task.flow[def.id] ? state.task.flow[def.id] : f;
      if (office.inst && office.key === key) fNow.links.forEach((l, n) => office.inst.seed(n, (cons[n] && cons[n].entries) || [], linkState(fNow, n)));
      if (office.inst && officeOpen()) office.inst.resume();
    } catch (err) {
      msg.hidden = false;
      msg.textContent = office.mod ? 'Não consegui desenhar a sala neste computador (sem WebGL).' : `Não consegui carregar a sala: ${err.message}`;
    } finally {
      office.loading = false;
    }
    syncOffice();
  }

  // ---- Antes de começar um passo: confirmar os branches e os commits dos microserviços. A verificação (git status) só
  // corre quando a pessoa a pede: com muitos microserviços grandes, demora ----
  function startDialog(def, f) {
    const t = state.task;
    const again = f.status !== 'idle';
    const chosen = (t.chosenServices || []).length;
    const modal = $('#modal-start');
    $('#ms-title').textContent = `${again ? 'Correr de novo' : 'Começar'} o passo ${def.name}`;
    $('#ms-text').innerHTML = [
      '<p><b>Confirma em que branch e em que commit está cada microserviço.</b> Os agentes trabalham sobre o código como está agora.</p>',
      def.branch ? `<p>Em cada microserviço que alterarem, a plataforma cria o branch <code>${esc(t.branch)}</code> a partir do commit em que ele estiver. Um microserviço com alterações por guardar não pode ser alterado: a plataforma recusa e avisa-te.</p>` : '',
      def.freeze ? '<p>O código fica congelado durante este passo: no fim, a plataforma confirma que os microserviços da tarefa e os escolhidos não mudaram.</p>' : '',
      again ? '<p>Os agentes voltam a correr do princípio. O que produziram da última vez fica guardado à parte.</p>' : '',
    ].join('');
    $('#ms-scope').textContent = chosen ? `os ${chosen} escolhidos` : 'todos os da pasta raiz: pode demorar';
    const scan = $('#ms-scan');
    scan.hidden = true;
    scan.innerHTML = '';
    $('#ms-scan-btn').disabled = false;
    $('#ms-go').textContent = again ? 'Correr de novo' : 'Começar';
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        watch.disconnect();
        $('#ms-go').onclick = null;
        $('#ms-scan-btn').onclick = null;
        modal.classList.remove('open');
        resolve(v);
      };
      // Cancelar, Esc ou um clique fora fecham a janela: é um não
      const watch = new MutationObserver(() => { if (!modal.classList.contains('open')) finish(false); });
      $('#ms-go').onclick = () => finish(true);
      $('#ms-scan-btn').onclick = async () => {
        $('#ms-scan-btn').disabled = true;
        scan.hidden = false;
        scan.innerHTML = `<div class="scan-wait"><span class="spinner" aria-hidden="true"></span>A verificar ${chosen ? `os ${chosen} microserviços escolhidos` : 'os microserviços da pasta raiz'}…</div>`;
        const r = await call(api.pipeline.scanRepos(t.id));
        $('#ms-scan-btn').disabled = false;
        $('#ms-scan-btn').textContent = 'Verificar de novo';
        if (!settled) scan.innerHTML = r ? scanHtml(r) : '<p class="hint">A verificação falhou.</p>';
      };
      $('#ms-scan-btn').textContent = 'Verificar microserviços';
      modal.classList.add('open');
      watch.observe(modal, { attributes: true, attributeFilter: ['class'] });
      $('#ms-go').focus();
    });
  }
  // o resultado da verificação: primeiro os que pedem atenção (erro, alterações por guardar, commits por enviar)
  function scanHtml(r) {
    const repos = r.repos || [];
    if (!repos.length) return '<p class="hint">Não encontrei repositórios Git para verificar.</p>';
    const weight = (x) => (x.error ? 0 : x.dirty ? 1 : x.ahead ? 2 : 3);
    const list = repos.slice().sort((a, b) => weight(a) - weight(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    const n = (k) => repos.filter(k).length;
    const plural = (c, one, many) => `${c} ${c === 1 ? one : many}`;
    const facts = [
      n((x) => x.dirty) ? plural(n((x) => x.dirty), 'com alterações por guardar', 'com alterações por guardar') : '',
      n((x) => x.ahead) ? plural(n((x) => x.ahead), 'com commits por enviar', 'com commits por enviar') : '',
      n((x) => x.behind) ? plural(n((x) => x.behind), 'atrás do remoto', 'atrás do remoto') : '',
      n((x) => x.branch === r.branch) ? plural(n((x) => x.branch === r.branch), `já no branch ${r.branch}`, `já no branch ${r.branch}`) : '',
      n((x) => x.error) ? plural(n((x) => x.error), 'com erro', 'com erro') : '',
    ].filter(Boolean);
    const sync = (x) => {
      if (!x.upstream) return '<span class="dim" title="Este branch não segue nenhum branch remoto">sem remoto</span>';
      if (!x.ahead && !x.behind) return '<span class="dim">em dia</span>';
      return [x.ahead ? `<span class="pill warn" title="Commits por enviar para ${esc(x.upstream)}">↑${x.ahead}</span>` : '', x.behind ? `<span class="pill" title="Commits no remoto que ainda não tens (desde o último fetch)">↓${x.behind}</span>` : ''].join(' ');
    };
    const rows = list.map((x) => (x.error
      ? `<tr class="bad"><td title="${esc(x.name)}">${esc(x.name)}</td><td colspan="4" title="${esc(x.error)}">${esc(x.error)}</td></tr>`
      : `<tr class="${x.dirty ? 'warn' : ''}"><td title="${esc(x.name)}">${esc(x.name)}</td>
        <td class="br" title="${esc(x.branch)}"><code>${esc(x.branch)}</code>${x.branch === r.branch ? ' <span class="pill accent">da tarefa</span>' : ''}</td>
        <td>${x.dirty ? `<span class="pill warn" title="Ficheiros alterados ou novos, por guardar num commit">${x.dirty}</span>` : '<span class="dim">nada</span>'}</td>
        <td>${sync(x)}</td>
        <td title="${x.commit ? esc(`${x.commit.hash} ${x.commit.subject} (${x.commit.when})`) : ''}">${x.commit ? `<code>${esc(x.commit.hash)}</code> ${esc(x.commit.subject)} <span class="dim">${esc(x.commit.when)}</span>` : '<span class="dim">sem commits</span>'}</td></tr>`)).join('');
    return `<p class="scan-sum"><b>${plural(repos.length, 'microserviço verificado', 'microserviços verificados')}</b>${r.scope === 'chosen' ? ' (os escolhidos)' : ''}${facts.length ? `: ${esc(facts.join(', '))}.` : ': tudo guardado e em dia.'}</p>
      <table class="scan-table"><thead><tr><th>Microserviço</th><th>Branch</th><th>Por guardar</th><th title="Em relação ao último fetch: a plataforma não vai à rede">Remoto</th><th>Último commit</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  const actions = {
    // iniciar sessão no CLI escolhido: abre um terminal com o login; ao voltar à janela, vê-se outra vez
    'cli-login': async () => {
      const name = CLI_NAME[cliNow()];
      if (await call(api.app.login(cliNow()))) toast(`Abri um terminal com o login do ${name}. Entra na conta no browser e volta aqui.`);
    },
    'cli-recheck': () => checkAuth(true),
    // mudar o nome da tarefa, ali mesmo no cabeçalho (Enter guarda, Esc cancela)
    'rename-task': () => {
      const h = $('#task-title');
      if (!h || $('#rename-in') || !state.task) return;
      h.outerHTML = `<span class="rename"><input type="text" id="rename-in" maxlength="200" value="${esc(state.task.title)}" aria-label="Nome da tarefa" autocomplete="off" spellcheck="false"><button class="btn small primary" data-act="rename-save" type="button">Guardar</button><button class="btn small" data-act="rename-cancel" type="button">Cancelar</button></span>`;
      const btn = $('[data-act="rename-task"]');
      if (btn) btn.hidden = true;
      const input = $('#rename-in');
      input.focus();
      input.select();
    },
    'rename-save': async () => {
      const input = $('#rename-in');
      if (!input || !state.task) return;
      const name = input.value.trim();
      if (!name) { toast('Dá um nome à tarefa', true); input.focus(); return; }
      if (name !== state.task.title) {
        const r = await call(api.tasks.rename(taskId(), name));
        if (!r) return;
        state.task.title = r.title;
        toast('Nome guardado');
      }
      repaintHead();
    },
    'rename-cancel': () => repaintHead(),
    'toggle-office': () => (officeOpen() ? closeOffice() : showOffice()),
    'new-task': openNewTask,
    'delete-task': async () => {
      if (!(await confirmBox('Apagar a tarefa', `"${state.task.title}", os documentos e tudo o que os agentes produziram deixam de existir na plataforma. Os branches e as alterações nos microserviços ficam onde estão. Isto não se pode desfazer.`))) return;
      if (await call(api.tasks.remove(taskId()))) { state.task = null; location.hash = 'tarefas'; }
    },
    'add-files': async () => {
      const r = await call(api.tasks.pickFiles());
      if (r && r.files.length && (await call(api.tasks.addDocuments(taskId(), { files: r.files })))) await reloadTask();
    },
    'add-folder': async () => {
      const r = await call(api.tasks.pickFolder());
      if (r && r.folder && (await call(api.tasks.addDocuments(taskId(), { folders: [r.folder] })))) await reloadTask();
    },
    'add-text': () => {
      $('#mx-name').value = 'texto colado';
      $('#mx-text').value = '';
      $('#modal-texto').classList.add('open');
      $('#mx-text').focus();
    },
    'view-doc': async (el) => {
      const r = await call(api.tasks.readDocument(taskId(), el.dataset.id, el.dataset.rel || ''));
      if (!r) return;
      viewText(r.name, r.binary ? `${size(r.size)} · ficheiro binário` : `${size(r.size)}${r.truncated ? ' · mostra-se só o início' : ''}`, r.binary ? 'Este ficheiro não é texto (PDF, imagem, Word…), por isso não se mostra aqui.' : r.text);
    },
    'copy-doc-path': async (el) => {
      const t = state.task;
      const d = t.documents.find((x) => x.id === el.dataset.id);
      if (!d) return;
      const sep = t.docsDir.includes('\\') ? '\\' : '/';
      const full = [t.docsDir, d.rel, ...(el.dataset.rel ? el.dataset.rel.split('/') : [])].join(sep);
      try {
        await navigator.clipboard.writeText(full);
        toast('Caminho copiado');
      } catch {
        viewText('Caminho da cópia', '', full);
      }
    },
    'reveal-doc': async (el) => { await call(api.tasks.revealDocument(taskId(), el.dataset.id, el.dataset.rel || '')); },
    'download-doc': async (el) => {
      const r = await call(api.tasks.documentBytes(taskId(), el.dataset.id, el.dataset.rel || ''));
      if (!r) return;
      const bin = atob(r.data);
      const bytes = new Uint8Array(bin.length);
      for (let n = 0; n < bin.length; n++) bytes[n] = bin.charCodeAt(n);
      const url = URL.createObjectURL(new Blob([bytes], { type: r.type }));
      const link = document.createElement('a');
      link.href = url;
      link.download = r.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    'replace-doc': (el) => {
      const input = $('#pick-replace');
      input.dataset.id = el.dataset.id;
      input.dataset.rel = el.dataset.rel || '';
      input.value = '';
      input.click();
    },
    'add-to-folder': (el) => {
      const input = $('#pick-into-folder');
      input.dataset.id = el.dataset.id;
      input.value = '';
      input.click();
    },
    'rm-doc-file': async (el) => {
      if (await call(api.tasks.removeDocumentFile(taskId(), el.dataset.id, el.dataset.rel))) { toast('Tirado da tarefa. O original fica onde estava.'); await reloadTask(); }
    },
    'rm-doc': async (el) => {
      if (await call(api.tasks.removeDocument(taskId(), el.dataset.id))) await reloadTask();
    },
    // -- a sequência --
    'start-step': async () => {
      const def = currentDef();
      const f = state.task.flow[def.id];
      if (!(await startDialog(def, f))) return;
      state.sel[def.id] = 0;
      if (await call(api.pipeline.start(taskId(), def.id))) await reloadTask();
    },
    // estas não mudam a consola (o que o agente faz chega pelos eventos) nem as entradas: recarga leve
    'stop-step': async () => { if (await call(api.pipeline.stop(taskId()))) await reloadTask({ light: true }); },
    'continue-step': async () => { if (await call(api.pipeline.continue(taskId(), stepId()))) await reloadTask({ light: true }); },
    'done-link': async () => { if (await call(api.pipeline.done(taskId(), stepId(), linkIndex()))) await reloadTask({ light: true }); },
    'resume-link': async () => { if (await call(api.pipeline.resume(taskId(), stepId(), linkIndex()))) await reloadTask({ light: true }); },
    'send-doubts': async () => {
      const box = $('#doubts-box');
      if (!box) return;
      const fields = $$('.doubt-a', box);
      if (!fields.some((x) => x.value.trim())) { toast('Escreve pelo menos uma resposta', true); return; }
      const text = ['Respostas às tuas dúvidas:', ...fields.map((x, n) => `${n + 1}. ${x.dataset.label}: ${x.value.trim() || '(sem resposta: segue a tua assunção)'}`)].join('\n');
      if (await call(api.pipeline.send(taskId(), text, stepId(), linkIndex()))) {
        const key = box.dataset.key;
        const kept = {};
        for (const [k, v] of Object.entries(state.doubtDrafts || {})) if (!k.startsWith(`${key}|`)) kept[k] = v;
        state.doubtDrafts = kept;
        toast('Respostas enviadas');
        await reloadTask({ light: true });
      }
    },
    'send-msg': async () => {
      const text = $('#msg-in').value.trim();
      if (!text) return;
      if (await call(api.pipeline.send(taskId(), text, stepId(), linkIndex()))) { $('#msg-in').value = ''; await reloadTask({ light: true }); }
    },
    perm: async (el) => { await call(api.pipeline.answer(taskId(), el.dataset.req, el.dataset.choice, {})); },
    'answer-question': async (el) => {
      const box = el.closest('.perm');
      const answers = {};
      for (const q of $$('.question-block', box)) {
        const picked = $$('input:checked', q).map((c) => (c.value === '__outra' ? ($('.q-other', q).value || '').trim() : c.value)).filter(Boolean);
        if (picked.length) answers[q.dataset.question] = picked.join(', ');
      }
      if (!Object.keys(answers).length) { toast('Escolhe uma resposta', true); return; }
      await call(api.pipeline.answer(taskId(), el.dataset.req, 'allow', answers));
    },
    'view-output': async (el) => {
      const r = await call(api.pipeline.readOutput(taskId(), stepId(), el.dataset.index !== undefined ? Number(el.dataset.index) : linkIndex(), el.dataset.rel));
      if (r) viewText(r.name, r.binary ? `${size(r.size)} · ficheiro binário` : `${size(r.size)}${r.truncated ? ' · mostra-se só o início' : ''}`, r.binary ? 'Este ficheiro não é texto.' : r.text);
    },
    'refresh-changes': async () => {
      const t = state.task;
      state.changes = null;
      repaintStep();
      await loadChanges(t);
      if (state.task === t) repaintStep();
    },
    'svc-all': async () => {
      const names = new Set(state.task.chosenServices || []);
      $$('.svc-row:not([hidden]) input[data-svc]').forEach((x) => names.add(x.dataset.svc));
      await saveServices([...names]);
    },
    'svc-none': async () => { await saveServices([]); },
    'view-input': async (el) => {
      const r = await call(api.pipeline.readInput(taskId(), stepId(), el.dataset.key));
      if (r) viewText(r.name, r.binary ? `${size(r.size)} · ficheiro binário` : `${size(r.size)}${r.truncated ? ' · mostra-se só o início' : ''}`, r.binary ? 'Este ficheiro não é texto.' : r.text);
    },
    'add-step-files': async () => {
      const r = await call(api.tasks.pickFiles());
      if (r && r.files.length) { const x = await call(api.tasks.addStepInputs(taskId(), stepId(), { files: r.files })); if (x) { toast(`Junto a este passo: ${x.added.join(', ')}`); await renderPanel(); } }
    },
    'add-step-folder': async () => {
      const r = await call(api.tasks.pickFolder());
      if (r && r.folder) { const x = await call(api.tasks.addStepInputs(taskId(), stepId(), { folders: [r.folder] })); if (x) { toast(`Junto a este passo: ${x.added.join(', ')}`); await renderPanel(); } }
    },
    'remove-step-input': async (el) => {
      if (!(await confirmBox('Tirar deste passo', 'A plataforma apaga a sua cópia deste documento; o original fica onde está.'))) return;
      if (await call(api.tasks.removeStepInput(taskId(), stepId(), el.dataset.id))) await renderPanel();
    },
    'alert-resolve': async (el) => {
      const r = await call(api.pipeline.alertResolve(taskId(), el.dataset.id));
      if (r) { toast(r.told ? 'Resolvido. O agente vai tentar de novo.' : 'Resolvido.'); await reloadTask({ light: true }); }
    },
    'alert-dismiss': async (el) => { if (await call(api.pipeline.alertDismiss(taskId(), el.dataset.id))) await reloadTask({ light: true }); },
    'save-branch': async () => { if (await call(api.pipeline.setBranch(taskId(), $('#branch-in').value))) { toast('Branch guardado'); await reloadTask({ light: true }); } },
    // -- agentes --
    'add-agent': (el) => openAgentModal(el.dataset.step),
    'view-agent-file': async (el) => {
      const r = await call(api.agents.readFile(el.dataset.id, el.dataset.agfile));
      if (r) viewText(r.name, r.binary ? `${size(r.size)} · ficheiro binário` : `${size(r.size)}${r.truncated ? ' · mostra-se só o início' : ''}`, r.binary ? 'Este ficheiro não é texto.' : r.text);
    },
    'reveal-agent-file': async (el) => { await call(api.agents.reveal(el.dataset.id, el.dataset.agfile)); },
    // lê de novo a pasta do agente (ficheiros novos ou apagados, nome e descrição mudados)
    'refresh-agent': async (el) => {
      const r = await call(api.agents.refresh(el.dataset.id));
      if (!r) return;
      await loadAgents();
      renderAgents();
      toast(`Pasta lida de novo: ${r.files} ficheiro${r.files === 1 ? '' : 's'}`);
    },
    'copy-agent-path': async (el) => {
      try {
        await navigator.clipboard.writeText(el.dataset.agfile);
        toast('Caminho copiado');
      } catch {
        viewText('Caminho', '', el.dataset.agfile);
      }
    },
    'move-agent': async (el) => { if (await call(api.agents.move(el.dataset.id, Number(el.dataset.dir)))) { await loadAgents(); renderAgents(); } },
    'rm-agent': async (el) => {
      if (!(await confirmBox('Tirar o agente', 'A plataforma deixa de o usar. Os ficheiros dele ficam na pasta onde estão.', 'Tirar'))) return;
      if (await call(api.agents.remove(el.dataset.id))) { await loadAgents(); renderAgents(); }
    },
    'open-path': (el) => api.app.openPath(el.dataset.path),
    'refresh-services': async () => { if (await call(api.services.refresh())) { await loadServices(); renderServices(); toast('Atualizado'); } },
    'refresh-found': async () => { if (await call(api.services.refresh())) { await loadServices(); renderSettings(); toast('Atualizado'); } },
    'pick-root': async () => {
      const r = await call(api.settings.pickRoot());
      if (r && r.folder) { $('#root-in').value = r.folder; await actions['save-root'](); }
    },
    'save-root': async () => {
      const r = await call(api.settings.setRoot($('#root-in').value));
      if (!r) return;
      await loadServices();
      renderSettings();
      toast(`Pasta raiz guardada: ${state.services.length} microserviço${state.services.length === 1 ? '' : 's'}`);
    },
    recheck: async () => { await loadInfo(true); renderSettings(); },
  };

  document.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-go]');
    if (go && !e.target.closest('button, a')) { location.hash = go.dataset.go; return; }
    const tab = e.target.closest('[data-tab]');
    if (tab && state.task) {
      state.tab = tab.dataset.tab;
      state.tabOf[state.task.id] = state.tab;
      $$('.step-arrow').forEach((x) => { x.classList.toggle('active', x.dataset.tab === state.tab); x.setAttribute('aria-selected', String(x.dataset.tab === state.tab)); });
      await renderPanel();
      return;
    }
    const sel = e.target.closest('[data-sel]');
    if (sel && state.task) {
      // outro agente da sequência: só a consola dele (o resto do passo já cá está)
      const t = state.task;
      const def = currentDef();
      const n = Number(sel.dataset.sel);
      state.sel[state.tab] = n;
      state.mode[state.tab] = 'conversa';
      const r = await call(api.pipeline.console(t.id, def.id, n));
      if (state.task !== t || state.tab !== def.id || state.sel[def.id] !== n) return;
      state.entries = r ? r.entries : [];
      state.loaded = { task: t.id, step: def.id, sel: n };
      showStep();
      return;
    }
    const mode = e.target.closest('[data-mode]');
    if (mode && state.task) {
      // Entradas, Conversa, Produzido: já cá estão. Alterações: o git só agora, e só o desta tarefa
      state.mode[state.tab] = mode.dataset.mode;
      const def = currentDef();
      showStep();
      if (def && def.branch && mode.dataset.mode === 'alteracoes') {
        const t = state.task;
        state.changes = null;
        repaintStep();
        await loadChanges(t);
        if (state.task === t && state.tab === def.id && modeOf(def) === 'alteracoes') repaintStep();
      }
      return;
    }
    const file = e.target.closest('[data-file]');
    if (file && state.task) {
      const [repo, ...rest] = file.dataset.file.split('|');
      await openDiff(repo, rest.join('|'));
      return;
    }
    const mv = e.target.closest('#mv-mode [data-mv]');
    if (mv) {
      mvMode = mv.dataset.mv;
      try { localStorage.setItem('estaleiro.mdView', mvMode); } catch { /* sem armazenamento */ }
      paintViewMode(true);
      return;
    }
    const layout = e.target.closest('#dm-layout [data-layout]');
    if (layout) { state.diffMode = layout.dataset.layout; paintDiff(); return; }
    const dmFold = e.target.closest('[data-dm]');
    if (dmFold && state.diffOpen) { await openDiff(state.diffOpen.repo, state.diffOpen.file, dmFold.dataset.dm === 'full'); return; }
    if (e.target.closest('#dm-prev')) { diffGo(-1); return; }
    if (e.target.closest('#dm-next')) { diffGo(1); return; }
    const act = e.target.closest('[data-act]');
    if (act && actions[act.dataset.act]) { await actions[act.dataset.act](act); return; }
    const close = e.target.closest('[data-close]');
    if (close) { close.closest('.overlay').classList.remove('open'); return; }
    if (e.target.closest('[data-close-modals]')) { $$('.overlay.open').forEach((o) => o.classList.remove('open')); return; }
    if (e.target.classList && e.target.classList.contains('overlay') && e.target.id !== 'modal-confirm') { e.target.classList.remove('open'); return; }
    const seg = e.target.closest('#mt-type button');
    if (seg) { state.newTask.type = seg.dataset.v; $$('#mt-type button').forEach((b) => b.classList.toggle('active', b === seg)); return; }
    const unpick = e.target.closest('[data-unpick]');
    if (unpick) { const [kind, i] = unpick.dataset.unpick.split(':'); state.newTask[kind].splice(Number(i), 1); renderPicked(); }
  });

  // o CLI que corre todos os agentes: guarda-se, e a página volta a desenhar o que depende dele (modelos, avisos)
  $('#cli-pick').addEventListener('change', async (e) => {
    const value = e.target.value;
    const r = await call(api.settings.setCli(value));
    if (!r) { syncCliPick(); return; }
    if (state.info) state.info.cli = r.cli;
    syncCliPick();
    checkAuth();
    toast(`Os agentes passam a correr no ${CLI_NAME[r.cli]}${cliFound(r.cli) ? '' : ', que não está neste computador'}`, !cliFound(r.cli));
    if (state.view === 'tarefa' && state.task) await reloadTask({ light: true }); // só mudam os modelos e o que se pode fazer
  });

  document.addEventListener('change', async (e) => {
    const runner = e.target.closest('select[data-runner]');
    if (runner) {
      const label = runner.value === 'copilot' ? 'Copilot CLI' : 'Claude Code';
      if (await call(api.agents.setRunner(runner.dataset.runner, runner.value))) {
        await loadAgents();
        renderAgents();
        toast(`Passa a correr no ${label}; o modelo volta ao padrão`);
      }
      return;
    }
    if (e.target.matches('input[data-svc]') && state.task) {
      const names = new Set(state.task.chosenServices || []);
      if (e.target.checked) names.add(e.target.dataset.svc); else names.delete(e.target.dataset.svc);
      await saveServices([...names]);
      return;
    }
    if (e.target.matches('[data-rep-only-bad]')) { $('#mv-doc').classList.toggle('rep-only-bad', e.target.checked); return; }
    const pick = e.target.closest('input[type=checkbox][data-keys]');
    if (pick && state.task && state.inputs) {
      const keys = JSON.parse(pick.dataset.keys);
      const r = await call(api.pipeline.setInputs(taskId(), stepId(), keys, pick.checked));
      if (r) {
        const set = new Set(keys);
        state.inputs.groups.forEach((g) => g.sets.forEach((s) => s.items.forEach((x) => { if (set.has(x.key)) x.on = pick.checked; })));
        Object.assign(state.inputs, r);
      }
      repaintStep();
      return;
    }
    const setting = e.target.closest('select[data-setting]');
    if (setting && state.task) {
      const r = await call(api.pipeline.setAgentSettings(taskId(), setting.dataset.agent, { [setting.dataset.setting]: setting.value }));
      if (r) {
        // o servidor não avisa (foi esta página que mudou): os agentes desta tarefa ficam já com a escolha nova
        for (const fl of Object.values(state.task.flow || {})) for (const l of fl.links || []) if (l.agentId === setting.dataset.agent) l.settings = { ...r.settings };
        const help = $(`[data-help="${CSS.escape(setting.dataset.agent)}"]`);
        if (help) help.textContent = permHelp(r.settings.perm);
        toast(setting.dataset.setting === 'model' ? `Modelo: ${r.settings.model || 'o padrão do CLI'}` : `Permissões: ${permName(r.settings.perm)}`);
      }
      return;
    }
    const stepOf = e.target.closest('[data-step-of]');
    if (stepOf) { if (await call(api.agents.setStep(stepOf.dataset.stepOf, stepOf.value))) { await loadAgents(); renderAgents(); } return; }
    const pause = e.target.closest('[data-pause]');
    if (pause) { if (await call(api.agents.setPause(pause.dataset.pause, pause.checked))) { await loadAgents(); renderAgents(); } }
  });
  // procurar na lista dos microserviços, sem redesenhar
  document.addEventListener('input', (e) => {
    if (e.target.id === 'svc-filter') { state.svcFilter = e.target.value; filterServices(); }
    if (e.target.classList.contains('doubt-a')) {
      e.target.style.height = 'auto';
      e.target.style.height = `${e.target.scrollHeight}px`;
      const box = e.target.closest('#doubts-box');
      state.doubtDrafts = state.doubtDrafts || {};
      if (box) state.doubtDrafts[`${box.dataset.key}|${e.target.dataset.n}`] = e.target.value;
    }
  });
  document.addEventListener('keydown', (e) => {
    if ($('#modal-diff').classList.contains('open') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
      if (e.key === 'j' || e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); diffGo(1); return; }
      if (e.key === 'k' || e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); diffGo(-1); return; }
    }
    if (e.key === 'Enter' && e.target.id === 'root-in') actions['save-root']();
    if (e.key === 'Enter' && e.target.id === 'msg-in') actions['send-msg']();
    if (e.key === 'Enter' && e.target.id === 'rename-in') { e.preventDefault(); actions['rename-save'](); return; }
    if (e.key === 'Escape' && e.target.id === 'rename-in') { actions['rename-cancel'](); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.classList && e.target.classList.contains('doubt-a')) { e.preventDefault(); actions['send-doubts'](); }
    if (e.key === 'Enter' && e.target.id === 'ma-path') scanFolder();
    if (e.key === 'Escape' && officeOpen() && !$$('.overlay.open').length) { closeOffice(); return; }
    if (e.key === 'Escape') $$('.overlay.open').forEach((o) => { if (o.id !== 'modal-confirm') o.classList.remove('open'); else $('#mc-no').click(); });
  });

  $('#rail-logo').addEventListener('click', () => $('#rail').classList.toggle('open'));
  $('#mt-files').addEventListener('click', async () => {
    const r = await call(api.tasks.pickFiles());
    if (r) { state.newTask.files.push(...r.files.filter((f) => !state.newTask.files.includes(f))); renderPicked(); }
  });
  $('#mt-folder').addEventListener('click', async () => {
    const r = await call(api.tasks.pickFolder());
    if (r && r.folder && !state.newTask.folders.includes(r.folder)) { state.newTask.folders.push(r.folder); renderPicked(); }
  });
  $('#mt-create').addEventListener('click', createTask);
  $('#mx-add').addEventListener('click', async () => {
    const content = $('#mx-text').value.trim();
    if (!content) { toast('Cola o texto', true); return; }
    if (await call(api.tasks.addDocuments(taskId(), { text: { name: $('#mx-name').value.trim() || 'texto colado', content } }))) {
      $('#modal-texto').classList.remove('open');
      await reloadTask();
    }
  });
  // substituir um documento, ou juntar ficheiros a uma pasta: o conteúdo vai ao servidor (no browser não há caminho)
  $('#pick-replace').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 30 * 1024 * 1024) { toast(`${f.name} passa os 30 MB`, true); return; }
    if (await call(api.tasks.replaceDocument(taskId(), e.target.dataset.id, e.target.dataset.rel, { data: await toBase64(f) }))) { toast(`Substituído por ${f.name}`); await reloadTask(); }
  });
  $('#pick-into-folder').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const big = files.find((f) => f.size > 30 * 1024 * 1024);
    if (big) { toast(`${big.name} passa os 30 MB`, true); return; }
    const r = await call(api.tasks.addToFolder(taskId(), e.target.dataset.id, await Promise.all(files.map(async (f) => ({ name: f.name, data: await toBase64(f) })))));
    if (r) { toast(`Junto à pasta: ${r.added.join(', ')}`); await reloadTask(); }
  });
  $('#ma-pick').addEventListener('click', async () => {
    const r = await call(api.agents.pickFolder());
    if (r && r.folder) { $('#ma-path').value = r.folder; await scanFolder(); }
  });
  $('#ma-read').addEventListener('click', scanFolder);
  $('#ma-add').addEventListener('click', addAgents);

  // -- arrastar ou colar documentos para a tarefa --
  const DROP_SKIP = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', '.idea', '.gradle']);
  const FILE_MAX = 30 * 1024 * 1024;
  async function toBase64(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const entriesOf = (dir) => new Promise((resolve, reject) => {
    const reader = dir.createReader();
    const all = [];
    const next = () => reader.readEntries((batch) => { if (!batch.length) resolve(all); else { all.push(...batch); next(); } }, reject);
    next();
  });
  const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
  // os ficheiros de uma pasta arrastada, com o caminho dentro dela
  async function walk(entry, prefix, out) {
    if (entry.name.startsWith('.')) return;
    if (entry.isFile) out.push({ path: prefix + entry.name, file: await fileOf(entry) });
    else if (entry.isDirectory && !DROP_SKIP.has(entry.name)) for (const e of await entriesOf(entry)) await walk(e, `${prefix}${entry.name}/`, out);
  }
  const stepTarget = () => {
    const def = currentDef();
    return def && state.task && modeOf(def) === 'entradas' ? def : null;
  };
  async function sendDocuments(files, folders, text) {
    const t = state.task;
    if (!t) return;
    const big = [...files, ...folders.flatMap((f) => f.files.map((x) => x.file))].find((f) => f.size > FILE_MAX);
    if (big) { toast(`${big.name} passa os 30 MB`, true); return; }
    if (!files.length && !folders.length && !text) return;
    const toStep = stepTarget();
    toast(toStep ? `A juntar ao passo ${toStep.name}…` : 'A juntar à tarefa…');
    const payload = {
      files: await Promise.all(files.map(async (f) => ({ name: f.name || 'colado', data: await toBase64(f) }))),
      folders: await Promise.all(folders.map(async (d) => ({ name: d.name, files: await Promise.all(d.files.map(async (x) => ({ path: x.path, data: await toBase64(x.file) }))) }))),
      text,
    };
    if (toStep) {
      const x = await call(api.tasks.uploadStepInputs(t.id, toStep.id, payload));
      if (x) { toast(`Junto ao passo ${toStep.name}: ${x.added.join(', ')}`); await renderPanel(); }
      return;
    }
    const r = await call(api.tasks.uploadDocuments(t.id, payload));
    if (!r) return;
    toast(`Junto: ${r.added.join(', ')}`);
    state.tab = 'documentos';
    state.tabOf[t.id] = 'documentos';
    await reloadTask();
  }
  let dragDepth = 0;
  const dropTarget = () => state.view === 'tarefa' && state.task;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    if (dropTarget()) {
      const s = stepTarget();
      $('#drop-overlay b').textContent = s ? `Larga aqui para juntar ao passo ${s.name}` : 'Larga aqui para juntar à tarefa';
      $('#drop-overlay').hidden = false;
    }
  });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').hidden = true; });
  // largado fora da tarefa, o browser abriria o ficheiro: não abre
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = dropTarget() ? 'copy' : 'none'; } });
  document.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    if (!dropTarget()) return;
    const files = [];
    const folders = [];
    const items = Array.from(e.dataTransfer.items || []).filter((i) => i.kind === 'file');
    const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    if (entries.length && entries.every(Boolean)) {
      for (const entry of entries) {
        if (entry.isDirectory) {
          const list = [];
          for (const c of await entriesOf(entry)) await walk(c, '', list);
          if (list.length) folders.push({ name: entry.name, files: list });
        } else if (!entry.name.startsWith('.')) files.push(await fileOf(entry));
      }
    } else {
      files.push(...Array.from(e.dataTransfer.files || []).filter((f) => !f.name.startsWith('.')));
    }
    await sendDocuments(files, folders, null);
  });
  // colar no separador Documentos (não dentro de uma caixa de texto): ficheiros, uma captura de ecrã, ou texto
  document.addEventListener('paste', async (e) => {
    if (!dropTarget() || (state.tab !== 'documentos' && !stepTarget())) return;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    if ($$('.overlay.open').length) return;
    const cd = e.clipboardData;
    if (!cd) return;
    const files = Array.from(cd.files || []);
    if (files.length) {
      e.preventDefault();
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      await sendDocuments(files.map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], `captura-${stamp}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))), [], null);
      return;
    }
    const text = cd.getData('text/plain');
    if (text && text.trim()) {
      e.preventDefault();
      await sendDocuments([], [], { name: 'texto colado', content: text });
    }
  });

  // -- o que o processo principal conta enquanto os agentes trabalham --
  let reloadTimer = null;
  let eventAt = 0;
  const reloadSoon = () => {
    eventAt = Date.now();
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      // a página já pediu a tarefa depois deste evento (a ação que o causou recarregou): nada a fazer
      if (taskAskedAt >= eventAt) return;
      // não se redesenha enquanto alguém escreve a resposta a uma pergunta do agente
      const a = document.activeElement;
      if (a && a.classList && (a.classList.contains('q-other') || a.classList.contains('doubt-a'))) return;
      reloadTask({ light: true });
    }, 250);
  };
  // na lista de tarefas, o mesmo: espera que os eventos acalmem e pede a lista uma vez
  let listTimer = null;
  const reloadListSoon = () => {
    clearTimeout(listTimer);
    listTimer = setTimeout(async () => { listTimer = null; if (state.view === 'tarefas') { await loadTasks(); renderTasks(); } }, 400);
  };
  api.onTaskEvent(async (e) => {
    const t = state.task;
    if (e.type === 'log' && office.inst && office.task === e.taskId && office.step === e.step) office.inst.feed(e.index, e.entry);
    if (e.type === 'log' && face.ref === `${e.taskId}|${e.step}|${e.index}`) faceFromEntry(e.entry);
    if (e.type === 'log') {
      if (!t || t.id !== e.taskId || state.tab !== e.step || linkIndex() !== e.index) return;
      state.entries.push(e.entry);
      const body = $('#console-body');
      if (body) {
        const empty = $('.console-empty', body);
        if (empty) empty.remove();
        const near = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
        if (e.entry.k === 'result') {
          const box = body.querySelector(`[data-cmd-id="${CSS.escape(e.entry.id || '')}"] .cmdwrap`);
          if (box) box.insertAdjacentHTML('beforeend', resultHtml(e.entry));
        } else {
          const link = t.flow[e.step] && t.flow[e.step].links[e.index];
          body.insertAdjacentHTML('beforeend', entryHtml(e.entry, null, link ? link.name : ''));
        }
        if (near) body.scrollTop = body.scrollHeight;
      }
      return;
    }
    if (e.type === 'alert') {
      toast(`Recusado: ${e.alert.text}`, true);
      if (state.view === 'tarefa' && t && t.id === e.taskId) reloadSoon();
      else if (state.view === 'tarefas') reloadListSoon();
      return;
    }
    if (e.type === 'pending') {
      if (!t || t.id !== e.taskId) return;
      if (t.flow[e.step]) t.flow[e.step].pending = e.pending;
      syncOffice();
      const fresh = (e.pending || []).some((p) => !seenPending.has(p.id));
      (e.pending || []).forEach((p) => seenPending.add(p.id));
      const def = t.stepDefs.find((d) => d.id === e.step);
      const here = state.tab === e.step && linkIndex() === e.index && def && modeOf(def) === 'conversa' && $('#pending-box');
      if (here) {
        $('#pending-box').innerHTML = pendingHtml(e.pending);
        const body = $('#console-body');
        if (body) body.scrollTop = body.scrollHeight;
      } else if (fresh && state.view === 'tarefa' && def) {
        // noutro separador ou noutra vista: vai para a conversa deste agente
        state.tab = e.step;
        state.tabOf[t.id] = e.step;
        state.mode[e.step] = 'conversa';
        state.sel[e.step] = e.index;
        $$('.step-arrow').forEach((x) => { x.classList.toggle('active', x.dataset.tab === state.tab); x.setAttribute('aria-selected', String(x.dataset.tab === state.tab)); });
        await renderPanel();
      }
      if (fresh) focusPending();
      return;
    }
    if (state.view === 'tarefa' && t && t.id === e.taskId) reloadSoon();
    else if (state.view === 'tarefas') reloadListSoon();
  });

  addEventListener('hashchange', route);

  // Um pedido de permissão (ou uma pergunta) acabado de chegar: fica à vista, realçado, e com o foco no primeiro botão,
  // a não ser que estejas a escrever numa caixa de texto ou com uma janela aberta
  function focusPending() {
    const box = $('#pending-box .perm:last-child') || $('#pending-box .perm');
    if (!box) return;
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    box.classList.remove('flash');
    void box.offsetWidth;
    box.classList.add('flash');
    const a = document.activeElement;
    const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable) && !a.closest('#pending-box');
    if (!typing && !$$('.overlay.open').length) (box.querySelector('input[type=radio], input[type=checkbox]') || box.querySelector('button.primary') || box.querySelector('button')).focus({ preventScroll: true });
  }
  (async () => {
    loadInfo(); // os --version dos programas: em fundo, a barra lateral mostra-os quando chegarem
    await Promise.all([loadAgents(true), loadServices()]);
    await route();
  })();
})();
