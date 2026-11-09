// Os contentores de um ambiente, vistos de fora e só a ler: se estão a correr e quem fala com quem. As ligações tiram-se
// das variáveis de ambiente de cada contentor: uma variável cujo valor tem o nome de outro contentor da lista, ou
// host.docker.internal:<porta> de uma porta que outro publica. Só se devolvem os nomes das variáveis, nunca os valores
// (podem ter palavras-passe). Só contentores com nome amb-..., os que a skill de ambiente cria.
const shell = require('./shell');

const NAME = /^amb-[A-Za-z0-9_.-]{1,80}$/;

async function inspect(names) {
  const list = [...new Set((Array.isArray(names) ? names : []).map(String).filter((n) => NAME.test(n)))].slice(0, 40);
  if (!list.length) return { containers: [], links: [] };
  const docker = await shell.findCli('docker');
  if (!docker.found) throw new Error('O Docker não está neste computador');
  const env = await shell.loginShellEnv();
  // um contentor que não existe faz o inspect falhar para todos: vê-se primeiro quais existem
  const ps = await shell.exec(docker.file, ['ps', '-a', '--format', '{{.Names}}'], { env, shell: docker.shell, timeout: 15000 });
  if (!ps.ok) throw new Error('O Docker não respondeu');
  const known = new Set(ps.out.split('\n').map((s) => s.trim()).filter(Boolean));
  const present = list.filter((n) => known.has(n));
  const containers = list.filter((n) => !known.has(n)).map((name) => ({ name, exists: false, running: false, status: 'não existe' }));
  if (!present.length) return { containers, links: [] };
  const r = await shell.exec(docker.file, ['inspect', ...present], { env, shell: docker.shell, timeout: 20000 });
  if (!r.ok) throw new Error('O docker inspect falhou');
  let data = [];
  try {
    data = JSON.parse(r.out);
  } catch {
    throw new Error('Não percebi a resposta do docker inspect');
  }
  const info = data.map((c) => {
    const name = String(c.Name || '').replace(/^\//, '');
    const ports = new Set();
    for (const binds of Object.values((c.NetworkSettings && c.NetworkSettings.Ports) || {})) for (const b of binds || []) if (b && b.HostPort) ports.add(String(b.HostPort));
    return { name, state: c.State || {}, env: (c.Config && c.Config.Env) || [], ports };
  });
  for (const c of info) containers.push({ name: c.name, exists: true, running: Boolean(c.state.Running), status: String(c.state.Status || '') });
  const links = [];
  for (const c of info) {
    const to = new Map();
    for (const line of c.env) {
      const at = String(line).indexOf('=');
      if (at < 1) continue;
      const key = line.slice(0, at);
      const value = line.slice(at + 1);
      for (const o of info) {
        if (o.name === c.name) continue;
        const byName = value.includes(o.name);
        const hd = /host\.(docker|containers)\.internal:(\d+)/.exec(value);
        if (byName || (hd && o.ports.has(hd[2]))) to.set(o.name, [...(to.get(o.name) || []), key]);
      }
    }
    for (const [target, vars] of to) links.push({ from: c.name, to: target, vars: [...new Set(vars)].slice(0, 6) });
  }
  return { containers, links };
}

function register(ipcMain) {
  ipcMain.handle('containers:inspect', async (_, names) => {
    try {
      return await inspect(names);
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  });
}

module.exports = { register, inspect };
