// No browser não há Electron nem preload: aqui faz-se o mesmo `window.estaleiro`, com pedidos ao servidor local
// (web.js) e, para escolher pastas e ficheiros, um seletor na própria página. Na janela Electron o preload já pôs
// window.estaleiro e isto não faz nada. Os canais são os mesmos de preload.js.
(function () {
  if (window.estaleiro) return;
  const token = (document.querySelector('meta[name="estaleiro-token"]') || {}).content || '';

  const post = (channel) => async (...args) => {
    try {
      const r = await fetch(`/api/${channel}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ args }) });
      if (!r.ok) {
        const text = (await r.text()).slice(0, 200);
        // a página é lida do disco a cada vez, o servidor só quando arranca: uma chamada nova num servidor antigo
        if (r.status === 404 && /Chamada desconhecida/.test(text)) return { error: 'O servidor da plataforma está desatualizado: a página é mais recente. Reinicia-o (Ctrl+C no terminal e npm run web) e recarrega a página.' };
        return { error: `O servidor respondeu ${r.status}: ${text}` };
      }
      return await r.json();
    } catch (e) {
      return { error: `Sem ligação ao servidor da plataforma (${e.message}). Confirma que o npm run web continua a correr.` };
    }
  };

  // -- o seletor de pastas e ficheiros --
  const $ = (id) => document.getElementById(id);
  let pending = null; // { resolve, mode }
  let selected = new Set();
  let current = null;

  function finish(value) {
    if (!pending) return;
    const { resolve } = pending;
    pending = null;
    $('modal-fs').classList.remove('open');
    resolve(value);
  }

  // ícones da janela (pasta, ficheiro e atalhos)
  const ICO = {
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    app: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
    home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
    root: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v10M11 11.5L6.2 17.4M13 11.5l4.8 5.9"/>',
    drive: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h.01"/>',
  };
  const svg = (n) => `<svg class="fs-ico" viewBox="0 0 24 24" aria-hidden="true">${ICO[n] || ICO.folder}</svg>`;
  const size = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const when = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  async function show(where) {
    const r = await post('fs:list')(where);
    if (r.error) { $('fs-hint').textContent = r.error; return; }
    current = r;
    $('fs-filter').value = '';
    $('fs-path').value = r.path;
    $('fs-path').hidden = true;
    $('fs-crumbs').hidden = false;
    $('fs-up').disabled = !r.parent;
    // o caminho às fatias: cada uma leva a essa pasta
    const parts = [];
    let p = r.path;
    for (;;) {
      const parent = p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '') || (r.sep === '/' ? '/' : '');
      const name = p === '/' ? '/' : (p.match(/[^\\/]+[\\/]?$/) || [p])[0].replace(/[\\/]$/, '');
      parts.unshift({ name: name || p, path: p });
      if (!parent || parent === p || /^[A-Za-z]:$/.test(p.replace(/[\\/]+$/, ''))) break;
      p = /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
    }
    $('fs-crumbs').innerHTML = parts.map((x, i) => `${i ? '<span class="fs-sep">›</span>' : ''}<button type="button" class="fs-crumb" data-go="${esc(x.path)}">${esc(x.name)}</button>`).join('');
    const sc = $('fs-crumbs');
    sc.scrollLeft = sc.scrollWidth;
    $('fs-places').innerHTML = (r.places || []).map((x) => `<button type="button" class="fs-place${x.path === r.path ? ' on' : ''}" data-go="${esc(x.path)}" title="${esc(x.path)}">${svg(x.kind === 'folder' ? 'folder' : x.kind)}<span>${esc(x.label)}</span></button>`).join('');
    paintList();
  }
  function paintList() {
    const r = current;
    if (!r) return;
    const files = pending && pending.mode === 'files';
    const q = $('fs-filter').value.trim().toLowerCase();
    const rows = r.entries.map((e, i) => ({ e, i })).filter(({ e }) => !q || e.name.toLowerCase().includes(q));
    $('fs-list').innerHTML = rows.map(({ e, i }) => (e.dir
      ? `<button type="button" class="fs-row dir" data-i="${i}" title="Abrir ${esc(e.name)}">${svg('folder')}<span class="fs-name">${esc(e.name)}</span><span class="fs-meta"></span><span class="fs-meta">${esc(when(e.mtime))}</span></button>`
      : `<label class="fs-row file${files ? '' : ' off'}${selected.has(e.full) ? ' on' : ''}" title="${esc(e.name)}"><input type="checkbox" data-i="${i}" ${selected.has(e.full) ? 'checked' : ''} ${files ? '' : 'disabled'}>${svg('file')}<span class="fs-name">${esc(e.name)}</span><span class="fs-meta">${esc(size(e.size))}</span><span class="fs-meta">${esc(when(e.mtime))}</span></label>`)).join('')
      || `<div class="fs-empty">${q ? 'Nada com esse nome nesta pasta.' : 'Pasta vazia.'}</div>`;
    if (r.more) $('fs-list').insertAdjacentHTML('beforeend', '<div class="fs-empty">Há mais ficheiros: usa o filtro para os encontrar.</div>');
    updateOk();
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function updateOk() {
    const files = pending && pending.mode === 'files';
    $('fs-ok').textContent = files ? `Escolher${selected.size ? ` (${selected.size})` : ''}` : 'Escolher esta pasta';
    $('fs-ok').disabled = files ? !selected.size : !current;
    $('fs-hint').textContent = files
      ? (selected.size ? `${selected.size} ficheiro${selected.size === 1 ? '' : 's'} escolhido${selected.size === 1 ? '' : 's'} (podes juntar de outras pastas)` : 'Marca os ficheiros; entra nas pastas para os procurar.')
      : (current ? `Escolhes ${current.path}` : '');
  }

  function choose(mode, title) {
    return new Promise((resolve) => {
      if (pending) finish(null);
      pending = { resolve, mode };
      selected = new Set();
      $('fs-title').textContent = title;
      $('modal-fs').classList.add('open');
      // a primeira vez, a pasta onde a app está a correr; depois, a última onde se esteve
      show(current ? current.path : '');
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    // pastas, fatias do caminho e atalhos: entrar
    $('modal-fs').addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) { show(go.dataset.go); return; }
      const dir = e.target.closest('.fs-row.dir');
      if (dir) { show(current.entries[Number(dir.dataset.i)].full); return; }
      if (e.target.closest('#fs-crumbs') && !e.target.closest('.fs-crumb')) editPath();
    });
    $('fs-list').addEventListener('change', (e) => {
      const box = e.target.closest('input[data-i]');
      if (!box) return;
      const full = current.entries[Number(box.dataset.i)].full;
      if (box.checked) selected.add(full); else selected.delete(full);
      box.closest('.fs-row').classList.toggle('on', box.checked);
      updateOk();
    });
    // escrever o caminho: um duplo clique no caminho (ou um clique no espaço livre dele)
    const editPath = () => { $('fs-crumbs').hidden = true; $('fs-path').hidden = false; $('fs-path').focus(); $('fs-path').select(); };
    $('fs-crumbs').addEventListener('dblclick', editPath);
    $('fs-path').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); show($('fs-path').value); }
      if (e.key === 'Escape') { e.stopPropagation(); $('fs-path').hidden = true; $('fs-crumbs').hidden = false; }
    });
    $('fs-path').addEventListener('blur', () => { $('fs-path').hidden = true; $('fs-crumbs').hidden = false; });
    $('fs-filter').addEventListener('input', paintList);
    $('fs-up').addEventListener('click', () => current && current.parent && show(current.parent));
    $('fs-cancel').addEventListener('click', () => finish(null));
    $('fs-ok').addEventListener('click', () => {
      if (!pending) return;
      finish(pending.mode === 'files' ? { files: [...selected] } : { folder: current.path });
    });
    // fechado por fora (Esc, ou um clique no fundo): a escolha fica por fazer
    new MutationObserver(() => { if (pending && !$('modal-fs').classList.contains('open')) { const { resolve } = pending; pending = null; resolve(null); } })
      .observe($('modal-fs'), { attributes: true, attributeFilter: ['class'] });
  });

  const picker = (mode, title, key) => async () => {
    const r = await choose(mode, title);
    return r || (key === 'files' ? { files: [] } : { folder: null });
  };

  window.estaleiro = {
    app: { info: post('app:info'), openPath: post('app:open-path'), auth: post('app:auth'), login: post('app:login') },
    agents: {
      list: post('agents:list'),
      pickFolder: picker('folder', 'Pasta com agentes ou skills', 'folder'),
      scan: post('agents:scan'),
      add: post('agents:add'),
      setStep: post('agents:set-step'),
      move: post('agents:move'),
      setPause: post('agents:set-pause'),
      remove: post('agents:remove'),
      setRunner: post('agents:set-runner'),
      refresh: post('agents:refresh'),
      readFile: post('agents:read-file'),
      reveal: post('agents:reveal'),
    },
    settings: {
      get: post('settings:get'),
      setRoot: post('settings:set-root'),
      setCli: post('settings:set-cli'),
      pickRoot: picker('folder', 'Pasta raiz dos microserviços', 'folder'),
    },
    services: {
      list: post('services:list'),
      refresh: post('services:refresh'),
    },
    tasks: {
      list: post('tasks:list'),
      get: post('tasks:get'),
      create: post('tasks:create'),
      pickFiles: picker('files', 'Documentos da tarefa', 'files'),
      pickFolder: picker('folder', 'Pasta de documentos', 'folder'),
      addDocuments: post('tasks:add-documents'),
      uploadDocuments: post('tasks:upload-documents'),
      setServices: post('tasks:set-services'),
      addStepInputs: post('tasks:add-step-inputs'),
      uploadStepInputs: post('tasks:upload-step-inputs'),
      removeStepInput: post('tasks:remove-step-input'),
      removeDocument: post('tasks:remove-document'),
      readDocument: post('tasks:read-document'),
      removeDocumentFile: post('tasks:remove-document-file'),
      revealDocument: post('tasks:reveal-document'),
      documentBytes: post('tasks:document-bytes'),
      replaceDocument: post('tasks:replace-document'),
      addToFolder: post('tasks:add-to-folder'),
      remove: post('tasks:remove'),
      rename: post('tasks:rename'),
    },
    pipeline: {
      start: post('pipeline:start'),
      send: post('pipeline:send'),
      models: post('pipeline:models'),
      answer: post('pipeline:answer'),
      done: post('pipeline:done'),
      stop: post('pipeline:stop'),
      continue: post('pipeline:continue'),
      retry: post('pipeline:retry'),
      resume: post('pipeline:resume'),
      console: post('pipeline:console'),
      outputs: post('pipeline:outputs'),
      readOutput: post('pipeline:read-output'),
      changes: post('pipeline:changes'),
      scanRepos: post('pipeline:scan-repos'),
      setBranch: post('pipeline:set-branch'),
      fileDiff: post('pipeline:file-diff'),
      inputs: post('pipeline:inputs'),
      setInputs: post('pipeline:set-inputs'),
      readInput: post('pipeline:read-input'),
      setAgentSettings: post('pipeline:set-agent-settings'),
      alertResolve: post('pipeline:alert-resolve'),
      alertDismiss: post('pipeline:alert-dismiss'),
    },
    onTaskEvent: (cb) => {
      const source = new EventSource(`/events?t=${encodeURIComponent(token)}`);
      source.addEventListener('task-event', (e) => {
        try {
          cb(JSON.parse(e.data));
        } catch {
          // um evento que não é JSON
        }
      });
    },
  };
})();
