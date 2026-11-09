# Estaleiro

Plataforma para implementar requisitos e resolver defeitos em microserviços com agentes. Dás-lhe os documentos de
entrada que descrevem o requisito ou o defeito; em cada passo, os agentes que ligaste a esse passo trabalham com eles,
um a seguir ao outro.

A plataforma é agnóstica: não lê o código dos microserviços nem interpreta o que os agentes produzem. Entrega a cada
agente os documentos e o que os anteriores produziram, impõe as regras do passo, e mostra o que acontece. O que
depende do código (que linguagem, como se compila, como se testa) fica nos agentes.

A plataforma não tem modelo próprio: os agentes correm no Claude Code ou no Copilot CLI que já tens, com a tua conta.
O que um agente lê vai para o fornecedor dele.

## Instalação

### Dependências

| O quê | Quando é preciso | Como confirmar |
|---|---|---|
| [Node.js](https://nodejs.org) 20 ou mais recente | para correr a partir do código (não é preciso com o `.exe`) | `node --version` |
| [Git](https://git-scm.com) | sempre: a plataforma cria o branch da tarefa e mostra as alterações | `git --version` |
| [Claude Code](https://docs.anthropic.com/claude-code), com sessão iniciada | para os agentes que correm no Claude Code | `claude --version` |
| [Copilot CLI](https://github.com/github/copilot-cli), com sessão iniciada | para os agentes que correm no Copilot CLI | `copilot --version` |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | para os agentes do passo Ambiente que levantam contentores | `docker ps` |
| [Bruno CLI](https://docs.usebruno.com/bru-cli/overview) | para os agentes do passo Testes que correm coleções Bruno | `bru --version` |
| O que os microserviços precisam (Java, Maven, …) | para os agentes compilarem e correrem os testes | `java -version`, `mvn -v` |

Basta um dos dois CLIs (Claude Code ou Copilot CLI), o dos agentes que vais usar. Docker, Bruno e as ferramentas dos
microserviços dependem do que os teus agentes fazem: a plataforma não os usa diretamente.

Instalar e iniciar sessão nos CLIs (Windows, macOS ou Linux, com o Node instalado):

```bash
npm install -g @anthropic-ai/claude-code   # Claude Code
claude                                     # e dentro dele: /login
npm install -g @github/copilot             # Copilot CLI
copilot                                    # e dentro dele: /login
npm install -g @usebruno/cli               # Bruno CLI
```

No Windows, o Claude Code precisa do Git for Windows instalado (usa a Git Bash).

### Opção A: o executável para Windows

1. Descarrega `Estaleiro-<versão>-windows-x64.zip` das [Releases](https://github.com/carnehd/cf-task-plataform/releases/latest).
2. Extrai o zip para uma pasta tua (por exemplo `C:\Estaleiro`): dentro está `Estaleiro-<versão>.exe`. É portátil:
   não instala nada, e a pasta `data` (tarefas, agentes, definições) fica ao lado do exe.
3. Abre o exe. Não está assinado: se o Windows mostrar "O Windows protegeu o seu PC", escolhe **Mais informações** e
   **Executar mesmo assim**.

Para atualizar, troca o exe por um novo na mesma pasta: a pasta `data` fica.

### Opção B: a partir do código, no browser

```bash
git clone https://github.com/carnehd/cf-task-plataform.git
cd cf-task-plataform
npm run web
```

Abre no browser o endereço que aparece na consola (`http://127.0.0.1:5810/?t=...`). Não precisa de `npm install`: só
usa o Node. É um servidor local, só em `127.0.0.1`, e o endereço leva um segredo (`data/web-token`) que fica igual de
uma vez para a outra.

Outra porta ou outra pasta de dados (uma segunda instância, ou testes):

```bash
PORT=5811 npm run web                     # macOS, Linux
ESTALEIRO_DATA=/caminho/dados npm run web
```

```powershell
$env:PORT=5811; npm run web               # Windows (PowerShell)
$env:ESTALEIRO_DATA="C:\dados"; npm run web
```

Para atualizar: `git pull` e voltar a correr `npm run web`. A pasta `data` não vai para o Git e fica como estava.

### Opção C: a partir do código, como aplicação

```bash
npm install      # descarrega o Electron
npm start
```

### Configurar pela primeira vez

1. **Definições:** a pasta raiz onde estão todos os microserviços (cada subpasta é um microserviço, de preferência um
   repositório Git). Os agentes correm a partir desta pasta.
2. **Agentes:** em cada passo, **Adicionar a partir de pasta**. A plataforma lê os `agents/*.md` e `SKILL.md` que lá
   estão e guarda onde ficam (não os copia). Ordena-os com ↑ ↓, marca as pausas, e escolhe em **Corre em** se cada um
   corre no Claude Code ou no Copilot CLI.
3. **Tarefas, Nova tarefa:** título, tipo e documentos. Depois, em cada separador de passo, **Começar**.

As definições, os agentes e as tarefas guardam caminhos deste computador: noutro computador, define a pasta raiz e
adiciona os agentes de novo.

### Problemas comuns

- **"Não encontro o Claude CLI" (ou o Copilot CLI):** confirma num terminal novo que `claude --version` responde. No
  macOS, a app procura os programas com o PATH da tua shell de login; no Windows, com o PATH do sistema (depois de
  instalar um CLI, fecha e volta a abrir a plataforma).
- **"A porta 5810 já está em uso":** já há uma plataforma a correr (abre o endereço dela), ou usa outra porta (`PORT`).
- **O agente falha a autenticação:** abre o CLI num terminal e inicia sessão de novo (`/login`).

## O fluxo

1. **Documentos** de entrada: ficheiros, pastas ou texto colado. A plataforma guarda uma cópia.
2. **Microserviços** (opcional): escolhes, da pasta raiz, os microserviços em que a tarefa mexe. A escolha vai no pedido
   a cada agente ("são estes os microserviços em causa"). Sem escolha, os agentes descobrem sozinhos, como as skills dizem.
3. **Implementação**: os agentes alteram os microserviços num branch novo da tarefa.
4. **Ambiente**: os agentes levantam o que é preciso para testar (cada comando autorizado por ti).
5. **Testes e relatório**: os agentes escrevem e correm os testes e o relatório, com o código congelado.

Em cada passo há uma **sequência de agentes** (página Agentes): correm pela ordem, e cada um começa quando o
anterior termina. Cada agente:

- recebe os documentos da tarefa e as pastas de resultados dos agentes anteriores (deste passo e dos anteriores);
- corre numa sessão sua, a partir da pasta raiz dos microserviços, e fala contigo enquanto trabalha: o que faz
  aparece ao vivo, os comandos que quer correr chegam como pedidos de permissão, e pode fazer-te perguntas;
- dá o trabalho por terminado escrevendo `FEITO.md` na sua pasta de resultados. Se parar sem o escrever (por
  exemplo, à espera de uma decisão), a sequência espera por ti: respondes-lhe, ou dá-lo por terminado.

Um agente marcado com **pausa depois** faz a sequência parar até carregares em **Aprovar e continuar**.

Antes de começar um passo, a plataforma pede-te para confirmares em que branch e em que commit está cada
microserviço: os agentes trabalham sobre o código como está. **Verificar microserviços** mostra, para cada um, o
branch, os ficheiros por guardar, os commits por enviar ou por receber (em relação ao último fetch, sem ir à rede) e o
último commit. Verifica os microserviços escolhidos no passo Microserviços; sem escolha, todos os da pasta raiz. A
plataforma só corre o `git status` quando o pedes: com muitos microserviços grandes, demora.

Antes de começar, escolhes para cada agente o **modelo** (o padrão do Claude CLI, Fable, Opus, Sonnet ou Haiku) e as
**permissões**: *perguntar sempre* (cada comando pede-te autorização), *leitura sem perguntar* (`git status`, `ls`,
`cat`, `grep`… correm logo), *tudo sem perguntar* (menos o que a plataforma recusa sempre) ou *só planear* (não corre
comandos nem altera os microserviços). A escolha fica como ponto de partida desse agente nas tarefas seguintes.

No separador de cada passo, à direita:

- **Entradas**: os documentos que os agentes do passo recebem. Por omissão, todos: os da tarefa e o que os passos
  anteriores produziram. Tiras e voltas a pôr cada ficheiro (ou uma pasta inteira), e juntas documentos só a esse passo
  (Ficheiros…, Pasta…, arrastar ou colar). O agente recebe só os escolhidos, e a leitura dos que tiraste é recusada.
- **Conversa**: o que o agente te diz, em caixas de mensagem; os comandos formatados, com o que devolveram.
- **Produzido**: os documentos que cada agente escreveu na sua pasta de resultados.

Ao ver um ficheiro `.md` (um documento, uma entrada ou o que um agente produziu), **Documento** mostra-o formatado, como a
pré-visualização do VS Code, e **Texto** mostra-o como está escrito. A escolha fica para a próxima vez.
- **Alterações** (passo com branch): os ficheiros alterados em cada microserviço. Clicar num abre uma janela com as
  diferenças, lado a lado ou numa coluna, com as palavras alteradas realçadas e ↑/↓ (ou J/K) entre alterações.

**O escritório.** Enquanto um agente trabalha, aparece uma bola no canto inferior esquerdo (azul a trabalhar, âmbar
quando está à tua espera). Carregar nela mostra por cima dela a sala do passo, só a imagem, e voltar a carregar (ou Esc)
esconde-a. Cada agente do passo tem uma secretária (até 4) e anda conforme os eventos da consola: lê na estante (`Read`,
`Grep`, `Glob`), escreve e corre comandos na secretária (o ecrã mostra o ficheiro ou o comando), vai pensar para a janela
ao fim de 20 segundos sem eventos, vem à frente da sala quando pede autorização ou espera por ti, e senta-se no sofá
quando termina; o anel no chão tem a cor do estado. Com a sala à vista, a bola fica (verde) depois de o passo terminar,
até a fechares. A cena usa o three.js (r160, licença MIT), que vem com a plataforma em `src/renderer/vendor/three/` e só
se carrega da primeira vez que abres a sala.

## Claude Code e Copilot CLI

Cada agente corre no CLI de onde veio: um agente de `.claude/` (ou de um pack com `claude/`) no Claude CLI, um de `.github/` (ou `copilot/`) no Copilot CLI. Os dois passam pelas mesmas regras de cada passo, os mesmos pedidos de autorização e a mesma conversa. O Copilot corre em modo ACP (`copilot --acp`); o modelo escolhe-se da lista que o próprio Copilot CLI dá.

Diferenças do Copilot: aprova sozinho os comandos que considera seguros (um `ls` não chega a ser perguntado), não recebe o motivo de uma recusa (a plataforma junta-o à mensagem seguinte), e não se lhe impede a leitura de um documento tirado das Entradas (o pedido diz-lhe para não o usar).

## As regras de cada passo

| | Implementação | Ambiente | Testes e relatório |
|---|---|---|---|
| Ler | tudo na pasta raiz e na tarefa | igual | igual |
| Escrever | os microserviços (no branch da tarefa) e a sua pasta de resultados | a sua pasta de resultados | a sua pasta de resultados e a pasta dos testes da tarefa |
| Comandos | cada um perguntado a ti | igual | igual |

Sempre recusados, sem perguntar: `git push`, mudar de branch, `reset`, `rebase` e afins (a plataforma gere o Git),
`sudo`, scripts descarregados e executados, ferramentas da web.

**O branch da tarefa** (por omissão `feature/<referência>`) é criado pela plataforma em cada microserviço antes da
primeira alteração de um agente nele. Se esse microserviço tiver alterações por guardar, a alteração é recusada: a
plataforma não mexe no trabalho de ninguém. Nunca faz push.

**Nos testes o código fica congelado**: a plataforma guarda o estado dos repositórios onde a tarefa mexeu e dos
microserviços escolhidos no início do passo, e confirma no fim que nada mudou.

## Estrutura

```
src/
  main.js        a janela Electron
  web.js         o servidor do browser (sem Electron)
  core.js        o que a plataforma faz, igual nos dois
  tasks.js       tarefas e documentos
  pipeline.js    a sequência de agentes de um passo
  session.js     uma sessão com o Claude CLI (conversa, permissões, perguntas)
  policy.js      o que um agente pode fazer em cada passo
  steps.js       os passos: o que cada um recebe e onde pode escrever
  git.js         o branch da tarefa e o que mudou
  agents.js      os agentes, por passo e por ordem
  services.js    os microserviços da pasta raiz
  settings.js    a pasta raiz
  shell.js       encontrar e arrancar as CLI
  renderer/      a página (a mesma na janela e no browser)
    office.js    o escritório 3D dos agentes (com vendor/three/)
data/            tarefas, agentes e definições deste computador (não vai para o Git)
  tasks/<id>/documents/                     a cópia dos documentos
  tasks/<id>/steps/<passo>/<n>-<agente>/    outputs/ (o que produziu) e console.jsonl (o que fez)
  tasks/<id>/tests/                         os testes
```

## Ainda não

- Jira como origem dos documentos.
- Correr passos em paralelo.

## Gerar o executável

```bash
npm install
npm run dist     # dist/Estaleiro-<versão>.exe: Windows x64, portátil (nas Releases vai dentro de um zip)
```

Gera-se em qualquer sistema (também num Mac). O electron-builder descarrega o Electron para Windows da página de
releases do Electron no GitHub, e guarda-o em cache.
