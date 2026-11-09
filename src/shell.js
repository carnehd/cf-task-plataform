// As linhas de comandos que a plataforma arranca (claude, copilot, git, docker): o ambiente onde as encontrar e como
// as parar. A app não tem modelo próprio: tudo o que um agente faz é feito pela CLI que o utilizador já tem.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

// No macOS e no Linux, uma app aberta pelo Finder ou pelo Dock tem um PATH curto (sem Homebrew, sem nvm, sem Docker).
// Por isso as ferramentas procuram-se com o ambiente da shell do utilizador, lido uma vez de uma shell de login.
// No Windows os programas recebem o PATH completo, e usa-se o da própria app.
let shellEnv = null;
let shellEnvWait = null;

function loginShellEnv() {
  if (IS_WIN) return Promise.resolve(process.env);
  if (shellEnv) return Promise.resolve(shellEnv);
  // vários pedidos ao mesmo tempo (os cinco programas, por exemplo) esperam pela mesma shell
  if (shellEnvWait) return shellEnvWait;
  shellEnvWait = new Promise((resolve) => {
    const mark = '__ESTALEIRO_ENV__';
    const env = { ...process.env };
    let out = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const parts = out.split(mark);
      if (parts.length >= 3) {
        for (const entry of parts[1].split('\0')) {
          const i = entry.indexOf('=');
          if (i > 0) env[entry.slice(0, i).replace(/^\n+/, '')] = entry.slice(i + 1);
        }
      }
      env.PATH = [...new Set([...(env.PATH || '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin'])].join(':');
      shellEnv = env;
      resolve(env);
    };
    let child;
    try {
      child = spawn(process.env.SHELL || '/bin/zsh', ['-ilc', `printf '${mark}'; env -0; printf '${mark}'`], { stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
    } catch {
      finish();
      return;
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 10000);
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); finish(); });
    child.on('close', () => { clearTimeout(timer); finish(); });
  });
  return shellEnvWait;
}

// As variáveis de uma sessão do Claude Code de onde a app possa ter sido aberta são dessa sessão, não do utilizador:
// o agente arrancado daqui tomava-as como suas e falhava a autenticação.
function agentEnv(env) {
  const out = { ...env };
  for (const key of Object.keys(out)) if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(key)) delete out[key];
  return out;
}

function onPath(name, env) {
  const exts = IS_WIN ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // não está aqui
      }
    }
  }
  return null;
}

// No Windows o npm deixa um .cmd à frente do programa do Claude, que não arranca sem uma shell (e a shell estraga os
// argumentos com JSON): procura-se o próprio exe. O .cmd do Copilot fica: os argumentos dele são palavras simples.
function behindShim(name, file) {
  if (!/\.(cmd|bat|ps1)$/i.test(file)) return file;
  if (name !== 'claude') return file;
  const exe = path.join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return fs.existsSync(exe) ? exe : null;
}

// Onde um programa pode estar: no PATH da shell do utilizador, senão nos sítios onde os instaladores o põem.
function places(name, env) {
  const home = os.homedir();
  const out = [];
  const found = onPath(name, env);
  if (found) out.push(behindShim(name, found));
  if (IS_WIN) {
    out.push(path.join(home, '.local', 'bin', `${name}.exe`));
    if (env.APPDATA) {
      out.push(path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
      out.push(path.join(env.APPDATA, 'npm', `${name}.cmd`));
    }
    if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Programs', name, `${name}.exe`));
  } else {
    out.push(path.join(home, '.local', 'bin', name), path.join(home, `.${name}`, 'local', name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`);
    try {
      const nodes = path.join(home, '.nvm', 'versions', 'node');
      for (const v of fs.readdirSync(nodes).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) out.push(path.join(nodes, v, 'bin', name));
    } catch {
      // sem nvm
    }
  }
  return out.filter(Boolean);
}

const known = new Map();

// { name, found, file, command, version, shell }: shell é true quando só se arranca por cmd.exe (um .cmd)
async function findCli(name, again = false) {
  if (known.has(name) && !again) return known.get(name);
  const env = await loginShellEnv();
  const file = places(name, env).find((f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  }) || null;
  const useShell = Boolean(file && /\.(cmd|bat)$/i.test(file));
  const info = { name, found: Boolean(file), file, command: file && onPath(name, env) ? name : file ? file.replace(os.homedir(), '~') : name, version: '', shell: useShell };
  if (file) {
    info.version = await new Promise((resolve) => {
      execFile(file, ['--version'], { env, timeout: 15000, windowsHide: true, shell: useShell }, (err, out) => resolve(err ? '' : ((/\d+\.\d+(\.\d+)?/.exec(String(out)) || [''])[0]).slice(0, 20)));
    });
  }
  known.set(name, info);
  return info;
}

// Corre um programa até ao fim e devolve o que escreveu. Para comandos curtos: git, docker ps.
function exec(file, args, { cwd, env, timeout = 20000, shell: useShell = false } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, timeout, windowsHide: true, shell: useShell, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      resolve({ ok: !err, code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, out: String(out || ''), err: String(errOut || (err && err.message) || '') });
    });
  });
}

// Termina um processo e os filhos dele (o Claude CLI arranca os seus).
function killTree(child) {
  return new Promise((resolve) => {
    if (!child) return resolve();
    if (IS_WIN) {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      k.on('close', resolve);
      k.on('error', resolve);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const signal = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch {
        try { child.kill(name); } catch { /* já terminou */ }
      }
    };
    const timer = setTimeout(() => { signal('SIGKILL'); resolve(); }, 4000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    signal('SIGTERM');
  });
}

module.exports = { IS_WIN, loginShellEnv, agentEnv, findCli, exec, killTree };
