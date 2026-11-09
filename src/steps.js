// Os passos de uma tarefa. É configuração, não lógica: a plataforma não sabe o que cada um faz, só o que recebe e o
// que o agente desse passo pode fazer. Um agente (a pasta que se liga na página Agentes) faz o resto.
//
//   from:      os passos cujo resultado (a pasta outputs) este passo recebe, além dos documentos da tarefa
//   write:     onde o agente pode escrever: 'projects' (os microserviços da tarefa), 'outputs' (a pasta de resultados
//              do passo, onde deixa os documentos que produz), 'tests' (a pasta dos testes da tarefa)
//   branch:    a plataforma cria um branch novo da tarefa em cada microserviço antes de o agente começar
//   repoTests: pastas de testes dentro de cada microserviço onde o passo pode escrever mesmo com o código congelado:
//              a pasta que tem o ficheiro `marker` (ou a pasta `dir` na raiz do microserviço, para criar uma nova),
//              sempre no branch da tarefa; não contam como alteração ao código
//   freeze:    o código fica congelado: a plataforma guarda o estado dos repositórios antes e confirma no fim
//   runnable:  já corre nesta versão
//   skill:     as instruções que vêm com a plataforma, usadas quando não se liga outro agente ao passo
const STEPS = [
  {
    id: 'implementacao',
    name: 'Implementação',
    runnable: true,
    skill: 'implementar-tarefa',
    from: [],
    write: ['projects', 'outputs'],
    branch: true,
    summary: 'O agente lê os documentos e o código e implementa o que pedem, num branch novo de cada microserviço da tarefa. Sem push.',
  },
  {
    id: 'ambiente',
    name: 'Ambiente',
    runnable: true,
    skill: 'levantar-ambiente',
    from: ['implementacao'],
    write: ['outputs'],
    summary: 'Um agente lê os microserviços e propõe o que levantar neste computador para os testar. Nada arranca sem um clique teu.',
  },
  {
    id: 'testes',
    name: 'Testes e relatório',
    runnable: true,
    skill: 'testar-e-reportar',
    from: ['implementacao', 'ambiente'],
    write: ['outputs', 'tests'],
    repoTests: { marker: 'bruno.json', dir: 'bruno' },
    freeze: true,
    summary: 'Um agente cria testes para cada requisito, corre-os e escreve o relatório. O código fica congelado: só escreve na sua pasta e nas coleções Bruno dos microserviços.',
  },
];

const ids = () => STEPS.map((s) => s.id);
const get = (id) => STEPS.find((s) => s.id === id) || null;

module.exports = { STEPS, ids, get };
