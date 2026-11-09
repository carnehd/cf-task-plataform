// Serviços: os microserviços que uma tarefa pode envolver. Não se adicionam um a um: são as subpastas da pasta raiz
// (settings.js) que parecem um projeto (têm pom.xml, build.gradle, package.json ou .git). De cada uma lê-se o que se
// vê sem correr nada: Maven ou Gradle, se é Spring Boot, a porta do application.yml e o branch do git.
// O id de um serviço é o nome da sua pasta.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

const SKIP = new Set(['node_modules', 'target', 'build', 'dist', 'out']);
const MAX_SERVICES = 300;

const readText = (f, max = 200 * 1024) => {
  try {
    return fs.readFileSync(f, 'utf8').slice(0, max);
  } catch {
    return '';
  }
};

// A porta em application.yml / application.properties (e nos perfis local, dev e default), quando está escrita
function portOf(folder) {
  const dir = path.join(folder, 'src', 'main', 'resources');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /^application(-(local|dev|default))?\.(ya?ml|properties)$/i.test(n));
  } catch {
    return null;
  }
  names.sort((a, b) => (a.includes('-local') ? -1 : b.includes('-local') ? 1 : 0));
  for (const n of names) {
    const text = readText(path.join(dir, n));
    const yml = /^server:\s*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+port:\s*\$?\{?[A-Z_]*:?(\d{2,5})/m.exec(text) || /^server:\s*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+port:\s*(\d{2,5})/m.exec(text);
    const props = /^server\.port\s*=\s*\$?\{?[A-Z_]*:?(\d{2,5})/m.exec(text);
    const m = yml || props;
    if (m) return Number(m[1]);
  }
  return null;
}

// O branch em que está a pasta, lido de .git/HEAD (também num worktree, onde .git é um ficheiro): sem correr o git
function branchOf(folder) {
  try {
    let git = path.join(folder, '.git');
    if (fs.statSync(git).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readText(git, 2000));
      if (!m) return '';
      git = path.resolve(folder, m[1].trim());
    }
    const head = readText(path.join(git, 'HEAD'), 500).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1].slice(0, 120) : head ? `(${head.slice(0, 7)})` : '';
  } catch {
    return '';
  }
}

function describe(name, folder) {
  const has = (f) => fs.existsSync(path.join(folder, f));
  const pom = has('pom.xml') ? readText(path.join(folder, 'pom.xml')) : '';
  const gradle = has('build.gradle') ? readText(path.join(folder, 'build.gradle')) : has('build.gradle.kts') ? readText(path.join(folder, 'build.gradle.kts')) : '';
  const build = has('pom.xml') ? 'maven' : has('build.gradle') || has('build.gradle.kts') ? 'gradle' : has('package.json') ? 'node' : '';
  if (!build && !has('.git')) return null;
  return { id: name, name, folder, build, springBoot: /spring-boot/.test(pom + gradle), port: portOf(folder), branch: branchOf(folder) };
}

// Os microserviços da pasta raiz, por ordem de nome. Sem pasta raiz, nenhum. Ler as pastas todas (pom.xml, resources,
// .git/HEAD) leva tempo com muitos microserviços, por isso a lista fica em memória: um minuto, ou até se pedir de novo
// (Atualizar), ou até mudar a pasta raiz.
const KEEP_MS = 60 * 1000;
let cache = null;
function list(dataDir, fresh = false) {
  const root = settings.rootDir(dataDir);
  if (!root) return [];
  if (!fresh && cache && cache.root === root && Date.now() - cache.at < KEEP_MS) return cache.list;
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (out.length >= MAX_SERVICES) break;
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const folder = path.join(root, e.name);
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(folder).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    const s = describe(e.name, folder);
    if (s) out.push(s);
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  cache = { root, at: Date.now(), list: out };
  return out;
}

const get = (dataDir, id) => list(dataDir).find((s) => s.id === id) || null;

function register(ipcMain, { dataDir }) {
  const answer = (fresh) => ({ root: settings.rootDir(dataDir), services: list(dataDir, fresh) });
  ipcMain.handle('services:list', async () => answer(false));
  ipcMain.handle('services:refresh', async () => answer(true));
}

module.exports = { register, list, get };
