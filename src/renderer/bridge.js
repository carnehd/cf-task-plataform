// No browser não há Electron nem preload: aqui faz-se o mesmo `window.estaleiro`, com pedidos ao servidor local
// (web.js) e, para escolher pastas e ficheiros, um seletor na própria página. Na janela Electron o preload já pôs
// window.estaleiro e isto não faz nada. Os canais são os mesmos de preload.js.
(function () {
  if (window.estaleiro) return;
  const token = (document.querySelector('meta[name="estaleiro-token"]') || {}).content || '';

  const post = (channel) => async (...args) => {
    try {
      const r = await fetch(`/api/${channel}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ args }) });
      if (!r.ok) return { error: `O servidor respondeu ${r.status}: ${(await r.text()).slice(0, 200)}` };
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

  async function show(where) {
    const r = await post('fs:list')(where);
    if (r.error) { $('fs-hint').textContent = r.error; return; }
    current = r;
    $('fs-path').value = r.path;
    $('fs-up').disabled = !r.parent;
    const files = pending && pending.mode === 'files';
    $('fs-list').innerHTML = r.entries.map((e, i) => (e.dir
      ? `<button type="button" class="fs-row dir" data-i="${i}">Pasta · ${esc(e.name)}</button>`
      : `<label class="fs-row file${files ? '' : ' off'}"><input type="checkbox" data-i="${i}" ${selected.has(e.full) ? 'checked' : ''} ${files ? '' : 'disabled'}>${esc(e.name)}</label>`)).join('')
      || '<div class="fs-empty">Pasta vazia</div>';
    updateOk();
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function updateOk() {
    const files = pending && pending.mode === 'files';
    $('fs-ok').textContent = files ? `Escolher ${selected.size ? `(${selected.size})` : ''}`.trim() : 'Escolher esta pasta';
    $('fs-ok').disabled = files ? !selected.size : !current;
    $('fs-hint').textContent = files ? 'Marca os ficheiros. Entra nas pastas para os procurar.' : 'Entra na pasta e escolhe-a.';
  }

  function choose(mode, title) {
    return new Promise((resolve) => {
      if (pending) finish(null);
      pending = { resolve, mode };
      selected = new Set();
      $('fs-title').textContent = title;
      $('modal-fs').classList.add('open');
      show(current ? current.path : '');
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('fs-list').addEventListener('click', (e) => {
      const dir = e.target.closest('.fs-row.dir');
      if (dir) show(current.entries[Number(dir.dataset.i)].full);
    });
    $('fs-list').addEventListener('change', (e) => {
      const box = e.target.closest('input[data-i]');
      if (!box) return;
      const full = current.entries[Number(box.dataset.i)].full;
      if (box.checked) selected.add(full); else selected.delete(full);
      updateOk();
    });
    $('fs-up').addEventListener('click', () => current && current.parent && show(current.parent));
    $('fs-go').addEventListener('click', () => show($('fs-path').value));
    $('fs-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') show($('fs-path').value); });
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
    app: { info: post('app:info'), openPath: post('app:open-path') },
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
      readFile: post('agents:read-file'),
      reveal: post('agents:reveal'),
    },
    settings: {
      get: post('settings:get'),
      setRoot: post('settings:set-root'),
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
