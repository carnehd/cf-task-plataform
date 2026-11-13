// O que um agente pode fazer num passo, decidido pela plataforma antes de cada ferramenta correr. Não depende do código
// dos microserviços: só de caminhos e de comandos.
//   ler:       sempre, na pasta raiz e nas pastas da tarefa (o CLI já as conhece)
//   escrever:  nas pastas que o passo dá (os resultados do agente, os testes da tarefa) e, num passo que altera os
//              microserviços, dentro de um deles: só nos que a pessoa aprovou (approveRepo) e, antes da primeira escrita
//              num microserviço, prepareRepo() passa-o para o branch da tarefa (ou recusa, se tiver alterações por guardar)
//   comandos:  cada um é perguntado à pessoa; alguns são recusados sem perguntar (push, mexer nos branches, sudo...)
const fs = require('fs');
const path = require('path');

// O caminho verdadeiro (sem ligações simbólicas: /tmp é /private/tmp no macOS), também para um ficheiro que ainda não existe
function real(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}
const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Os modos de permissão que a pessoa escolhe por agente, antes de começar
//   ask   cada comando é perguntado
//   read  os comandos que só leem correm logo; os outros são perguntados
//   all   tudo corre sem perguntar, menos o que é sempre recusado
//   plan  só planear: nenhum comando, e só escreve na sua pasta de resultados
const PERMS = ['ask', 'read', 'all', 'plan'];

// Um comando que só lê: cada parte (entre && || ; |) começa por um programa que só lê, sem redirecionar para ficheiros
// nem substituições ($(...), crases). Na dúvida, não é.
const READ_CMDS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'wc', 'pwd', 'echo', 'printf', 'which', 'file', 'stat', 'du', 'df', 'tree', 'sort', 'uniq', 'cut', 'tr', 'awk', 'jq', 'yq', 'diff', 'cmp', 'lsof', 'ps', 'env', 'printenv', 'date', 'whoami', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', 'true', 'false', 'nl', 'column', 'xxd', 'hexdump', 'od', 'md5', 'md5sum', 'shasum', 'sha256sum', 'cd', 'type', 'command', 'uname', 'sed', 'unzip', 'docker', 'podman', 'git', 'netstat', 'ss', 'pgrep', 'id', 'hostname', 'sw_vers', 'java', 'mvn', 'node', 'npm']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'grep', 'cat-file', 'branch', 'remote', 'config', 'tag', 'reflog', 'stash']);
function isReadOnly(command) {
  const cmd = String(command || '').replace(/\d?>\s*\/dev\/null/g, '').replace(/2>&1/g, '');
  if (/>|<\(|\$\(|`/.test(cmd)) return false;
  return cmd.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean).every((part) => {
    const words = part.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (!words.length) return true;
    const prog = words[0].replace(/^.*\//, '');
    const rest = words.slice(1);
    if (!READ_CMDS.has(prog)) return false;
    if (prog === 'git') {
      let k = 0;
      while (k < rest.length && rest[k].startsWith('-')) k += ['-C', '-c', '--git-dir', '--work-tree'].includes(rest[k]) ? 2 : 1;
      const sub = rest[k];
      if (!GIT_READ.has(sub)) return false;
      const args = rest.slice(k + 1);
      if (sub === 'branch') return args.every((a) => ['-a', '-r', '--list', '--show-current', '-v', '-vv', '--all'].includes(a));
      if (sub === 'remote') return args.every((a) => a === '-v' || a === 'show' || !a.startsWith('-') && args[0] !== 'add');
      if (sub === 'config') return args.includes('--get') || args.includes('--list') || args.includes('-l');
      if (sub === 'tag') return !args.length || args.every((a) => ['-l', '--list'].includes(a));
      if (sub === 'stash') return args[0] === 'list' || args[0] === 'show';
      if (sub === 'reflog') return !args.length || args[0] === 'show';
      return true;
    }
    if (prog === 'find') return !rest.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fls'].includes(a));
    if (prog === 'sed') return !rest.some((a) => /^-i/.test(a) || a === '--in-place');
    if (prog === 'unzip') return rest.some((a) => ['-l', '-p', '-t', '-v', '-Z'].includes(a));
    if (prog === 'docker' || prog === 'podman') return ['ps', 'images', 'inspect', 'logs', 'version', 'info', 'port', 'top'].includes(rest[0]) || (rest[0] === 'compose' && ['ps', 'logs', 'config'].includes(rest[1]));
    if (['java', 'mvn', 'node', 'npm'].includes(prog)) return rest.length === 1 && ['-version', '--version', '-v'].includes(rest[0]);
    return true;
  });
}

const BASH_DENIED = [
  [/\bgit\s+(push|remote|config|reset|clean|checkout|switch|rebase|merge|pull|fetch|stash|cherry-pick|revert|tag|filter-branch|reflog|gc|worktree|submodule)\b/, 'A plataforma gere o Git: no branch da tarefa podes fazer git status, diff, log, add e commit, mais nada.'],
  [/\bgit\s+branch\s+(-[dDmMcC]|--delete|--move|--copy)\b/, 'A plataforma gere os branches.'],
  [/\bsudo\b/, 'Comandos com sudo não são permitidos.'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sh|bash|zsh)\b/, 'Correr um script descarregado não é permitido.'],
  [/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(\/|~|\$HOME)(\s|$|\/\*)/, 'Apagar pastas de sistema ou a pasta pessoal não é permitido.'],
];

// root: a pasta raiz dos microserviços. writeDirs: pastas onde se escreve sem mais. repos: true quando o passo altera os
// microserviços (cada um uma subpasta da raiz). prepareRepo(dir) → '' ou o motivo de recusa. codeFrozen: o passo não
// pode alterar os microserviços (só se diz no motivo da recusa).
// hidden: os documentos que a pessoa tirou das entradas deste passo (ficheiros ou pastas): o Read deles é recusado
// repoTests: { marker, dir }: com o código congelado, ainda se escreve nas pastas de testes de cada microserviço (a pasta
// com o ficheiro marker, ou <microserviço>/<dir>/ para criar uma), no branch da tarefa (prepareRepo)
// approveRepo(nome) → '' ou o motivo de recusa: o microserviço tem de estar na lista que a pessoa aprovou
// holdCommands() → true enquanto a pessoa não aprovou nenhum microserviço: em "tudo sem perguntar", os comandos que não
// só leem passam a ser perguntados (um comando também altera ficheiros)
// onWrite(caminho): uma escrita autorizada numa das pastas writeDirs (para a plataforma ler o que o agente lá deixou)
function inRepoTests(repoDir, abs, repoTests) {
  const rel = path.relative(repoDir, abs).split(path.sep);
  if (repoTests.dir && rel.length > 1 && rel[0] === repoTests.dir) return true;
  let d = path.dirname(abs);
  while (d !== repoDir && inside(repoDir, d)) {
    if (fs.existsSync(path.join(d, repoTests.marker))) return true;
    d = path.dirname(d);
  }
  return false;
}

function makePolicy({ root, writeDirs = [], repos = false, prepareRepo, approveRepo = null, holdCommands = null, onWrite = null, codeFrozen = false, perm = 'ask', hidden = [], repoTests = null }) {
  const mode = PERMS.includes(perm) ? perm : 'ask';
  // só planear: não altera os microserviços
  if (mode === 'plan') { repos = false; repoTests = null; }
  const rootReal = real(root);
  const writeReal = writeDirs.map(real);
  const hiddenReal = hidden.map(real);
  return async function decide({ tool, input }) {
    const i = input || {};
    if (tool === 'Read' && hiddenReal.length) {
      const target = String(i.file_path || '');
      const abs = real(path.isAbsolute(target) ? target : path.join(root, target));
      if (hiddenReal.some((d) => inside(d, abs))) return { action: 'deny', message: 'A pessoa tirou este documento das entradas deste passo: não o uses. Trabalha com os documentos que recebeste.' };
    }
    if (['Read', 'Grep', 'Glob', 'LS', 'TodoWrite'].includes(tool)) return { action: 'allow' };
    if (tool === 'AskUserQuestion') return { action: 'ask' };
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
      const target = String(i.file_path || i.notebook_path || '');
      if (!target) return { action: 'deny', message: 'Sem caminho de ficheiro.' };
      const abs = real(path.isAbsolute(target) ? target : path.join(root, target));
      if (writeReal.some((d) => inside(d, abs))) {
        if (onWrite) onWrite(abs);
        return { action: 'allow' };
      }
      if (repos && inside(rootReal, abs) && abs !== rootReal) {
        const rel = path.relative(rootReal, abs).split(path.sep);
        if (rel.length < 2) return { action: 'deny', message: 'Só podes escrever dentro de um microserviço, não na pasta raiz.' };
        if (rel.includes('.git')) return { action: 'deny', message: 'A pasta .git é gerida pela plataforma.' };
        const notYet = approveRepo ? await approveRepo(rel[0]) : '';
        if (notYet) return { action: 'deny', message: notYet };
        const why = await prepareRepo(path.join(rootReal, rel[0]), rel[0]);
        if (why) return { action: 'deny', message: why };
        return { action: 'allow' };
      }
      if (repoTests && inside(rootReal, abs) && abs !== rootReal) {
        const rel = path.relative(rootReal, abs).split(path.sep);
        if (rel.length > 2 && !rel.includes('.git') && inRepoTests(path.join(rootReal, rel[0]), abs, repoTests)) {
          const why = await prepareRepo(path.join(rootReal, rel[0]), rel[0]);
          if (why) return { action: 'deny', message: why };
          return { action: 'allow' };
        }
      }
      const where = [...writeDirs, ...(repos ? ['dentro dos microserviços da pasta raiz'] : []), ...(repoTests ? [`nas pastas de testes dos microserviços (onde está um ${repoTests.marker}, ou <microserviço>/${repoTests.dir}/ para criar uma)`] : [])].join(', ');
      return { action: 'deny', message: `${mode === 'plan' ? 'Estás em modo só planear. ' : codeFrozen ? 'Neste passo o código está congelado. ' : ''}Só podes escrever em: ${where}.` };
    }
    if (tool === 'Bash') {
      const cmd = String(i.command || '');
      for (const [re, why] of BASH_DENIED) if (re.test(cmd)) return { action: 'deny', message: why };
      if (mode === 'plan') return { action: 'deny', message: 'Estás em modo só planear: não corres comandos. Escreve o plano na tua pasta de resultados.' };
      if (mode === 'all') {
        if (holdCommands && !isReadOnly(cmd) && await holdCommands()) return { action: 'ask' };
        return { action: 'allow', note: `${cmd.slice(0, 200)} · correu sem perguntar` };
      }
      if (mode === 'read' && isReadOnly(cmd)) return { action: 'allow', note: `${cmd.slice(0, 200)} · só leitura, correu sem perguntar` };
      return { action: 'ask' };
    }
    return { action: 'deny', message: `A ferramenta ${tool} não está disponível neste passo.` };
  };
}

module.exports = { makePolicy, real, inside, isReadOnly, inRepoTests, PERMS };
