# Estaleiro

Plataforma para implementar requisitos e resolver defeitos em microserviços com agentes. Dás-lhe os documentos de
entrada que descrevem o requisito ou o defeito; em cada passo, os agentes que ligaste a esse passo trabalham com eles,
um a seguir ao outro.

A plataforma é agnóstica: não lê o código dos microserviços nem interpreta o que os agentes produzem. Entrega a cada
agente os documentos e o que os anteriores produziram, impõe as regras do passo, e mostra o que acontece. O que
depende do código (que linguagem, como se compila, como se testa) fica nos agentes.

A plataforma não tem modelo próprio: os agentes correm no Claude CLI que já tens, com a tua conta. O que um agente lê
vai para o fornecedor dele.

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

**Nos testes o código fica congelado**: a plataforma guarda o estado dos repositórios no início do passo e confirma no
fim que nada mudou.

## Correr

```bash
npm run web      # no browser: abre o endereço que aparece na consola (não precisa de npm install)
npm install      # só para a janela Electron e para o .exe
npm start        # como aplicação (Electron)
```

`npm run web` só precisa do Node: é um servidor local, só em `127.0.0.1`. O endereço leva um segredo
(`data/web-token`), igual de uma vez para a outra. Outra porta: `PORT=5811 npm run web`. Outra pasta de dados (uma
segunda instância, ou testes): `ESTALEIRO_DATA=/caminho npm run web`.

Pré-requisitos: Node 20 ou mais recente; o Claude CLI instalado e com sessão iniciada (`claude`, depois `/login`).

## Primeiros passos

1. **Definições:** a pasta raiz onde estão todos os microserviços. Cada subpasta é um microserviço; os agentes correm
   a partir desta pasta.
2. **Agentes:** em cada passo, **Adicionar a partir de pasta**. A plataforma lê os `agents/*.md` e `SKILL.md` que lá
   estão e guarda onde ficam (não os copia). Ordena-os com ↑ ↓ e marca as pausas.
3. **Tarefas, Nova tarefa:** título, tipo e documentos. Depois, em cada separador de passo, **Começar**.

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

## Executável para Windows

```bash
npm run dist     # dist/Estaleiro-<versão>.exe, portátil: a pasta data fica ao lado do exe
```
