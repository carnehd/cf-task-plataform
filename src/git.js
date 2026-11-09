// O Git, pelo que a plataforma precisa dele: um branch novo por tarefa em cada microserviço, o estado de cada um e o que
// mudou. Não sabe de linguagens nem de ficheiros de build: só de repositórios. Nunca mexe no trabalho de uma pessoa:
// recusa quando há alterações por guardar, e nunca faz push.
const fs = require('fs');
const path = require('path');
const shell = require('./shell');

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const PATCH_MAX = 400 * 1024;

async function run(cwd, args, timeout = 60000) {
  const g = await shell.findCli('git');
  if (!g.found) throw new Error('O Git não está instalado neste computador');
  const env = await shell.loginShellEnv();
  return shell.exec(g.file, args, { cwd, env, shell: g.shell, timeout });
}

const isRepo = (cwd) => fs.existsSync(path.join(cwd, '.git'));

async function head(cwd) {
  const r = await run(cwd, ['rev-parse', 'HEAD']);
  return r.ok ? r.out.trim() : '';
}

async function branch(cwd) {
  const r = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.out.trim() : '';
}

// As alterações por guardar (ficheiros mudados ou novos), uma por linha
async function dirty(cwd) {
  const r = await run(cwd, ['status', '--porcelain']);
  if (!r.ok) throw new Error(`O git status falhou em ${path.basename(cwd)}: ${r.err.trim().split('\n').pop()}`);
  return r.out.split('\n').filter(Boolean);
}

async function branchExists(cwd, name) {
  return (await run(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).ok;
}

async function createBranch(cwd, name) {
  if (!BRANCH.test(name) || name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) throw new Error(`O nome do branch não é válido: ${name}`);
  const r = await run(cwd, ['checkout', '-b', name]);
  if (!r.ok) throw new Error(`Não consegui criar o branch ${name} em ${path.basename(cwd)}: ${r.err.trim().split('\n').pop()}`);
}

async function checkout(cwd, name) {
  const r = await run(cwd, ['checkout', name]);
  if (!r.ok) throw new Error(`Não consegui passar para o branch ${name} em ${path.basename(cwd)}: ${r.err.trim().split('\n').pop()}`);
}

// O que mudou desde `base`: commits, ficheiros (com estado), o resumo e o patch (cortado). Inclui o que ainda não foi
// guardado num commit; os ficheiros novos entram na lista sem patch.
async function changes(cwd, base) {
  const [names, numstat, untracked, commits] = await Promise.all([
    run(cwd, ['diff', '--name-status', base]),
    run(cwd, ['diff', '--numstat', base]),
    run(cwd, ['ls-files', '--others', '--exclude-standard']),
    run(cwd, ['log', '--oneline', `${base}..HEAD`]),
  ]);
  const counts = new Map();
  for (const line of numstat.out.split('\n').filter(Boolean)) {
    const [a, d, ...rest] = line.split('\t');
    counts.set(rest.join('\t'), { added: a === '-' ? null : Number(a), removed: d === '-' ? null : Number(d) });
  }
  const files = names.out.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    const p = rest[rest.length - 1];
    return { status: status[0], path: p, ...(counts.get(p) || { added: null, removed: null }) };
  });
  for (const f of untracked.out.split('\n').filter(Boolean)) {
    let added = null;
    try {
      const text = fs.readFileSync(path.join(cwd, f), 'utf8');
      added = text.includes('\u0000') ? null : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } catch {
      // não se lê
    }
    files.push({ status: '?', path: f, added, removed: 0 });
  }
  const sum = (k) => files.reduce((n, f) => n + (f[k] || 0), 0);
  return { files, added: sum('added'), removed: sum('removed'), commits: commits.out.split('\n').filter(Boolean) };
}

// O que mudou num ficheiro desde base: o diff unificado; um ficheiro novo, que o git ainda não segue, vem inteiro
// full: com o ficheiro inteiro à volta das alterações
async function fileDiff(cwd, base, file, full = false) {
  const abs = path.resolve(cwd, file);
  if (!abs.startsWith(path.resolve(cwd) + path.sep)) throw new Error('Esse ficheiro não é deste repositório');
  const tracked = (await run(cwd, ['ls-files', '--error-unmatch', '--', file])).ok;
  if (!tracked && fs.existsSync(abs)) {
    const buf = fs.readFileSync(abs);
    if (buf.slice(0, 8192).includes(0)) return { binary: true, untracked: true };
    const text = buf.toString('utf8');
    return { untracked: true, text: text.length > PATCH_MAX ? text.slice(0, PATCH_MAX) : text, truncated: text.length > PATCH_MAX };
  }
  const r = await run(cwd, ['diff', `-U${full ? 100000 : 3}`, base, '--', file]);
  if (!r.ok) throw new Error(`O git diff falhou: ${r.err.trim().split('\n').pop()}`);
  if (/^Binary files /m.test(r.out)) return { binary: true };
  return { patch: r.out.length > PATCH_MAX ? r.out.slice(0, PATCH_MAX) : r.out, truncated: r.out.length > PATCH_MAX };
}

// Um resumo para a pessoa conferir antes de começar um passo: o branch, quantos ficheiros estão por guardar, os commits
// por enviar e por receber (em relação ao último fetch: não vai à rede) e o último commit. Duas chamadas ao git.
async function overview(cwd) {
  const [st, last] = await Promise.all([
    run(cwd, ['status', '--porcelain=v2', '--branch']),
    run(cwd, ['log', '-1', '--date=format:%Y-%m-%d %H:%M', '--format=%h%x09%cd%x09%s']),
  ]);
  if (!st.ok) throw new Error(st.err.trim().split('\n').pop() || 'o git status falhou');
  const lines = st.out.split('\n').filter(Boolean);
  const header = (k) => {
    const l = lines.find((x) => x.startsWith(`# branch.${k} `));
    return l ? l.slice(`# branch.${k} `.length).trim() : '';
  };
  const ab = /^\+(\d+) -(\d+)$/.exec(header('ab'));
  const [hash = '', when = '', ...subject] = last.ok ? last.out.trim().split('\t') : [];
  return {
    branch: header('head') === '(detached)' ? `(${header('oid').slice(0, 7)})` : header('head'),
    upstream: header('upstream'),
    ahead: ab ? Number(ab[1]) : null,
    behind: ab ? Number(ab[2]) : null,
    dirty: lines.filter((l) => !l.startsWith('#')).length,
    commit: hash ? { hash, when, subject: subject.join(' ').slice(0, 200) } : null,
  };
}

module.exports = { BRANCH, isRepo, head, branch, dirty, branchExists, createBranch, checkout, changes, fileDiff, overview };
