# Agente de ambiente local de testes

Agente `levantador-ambiente` + skill `ambiente-local-de-testes`. Genéricos: servem para qualquer projeto e para qualquer funcionalidade que atravesse vários microserviços (pensado para o que é comum: Spring Boot com Maven ou Gradle, base de dados, Redis, Pub/Sub, Keycloak, correio de teste, em Docker ou Podman). Os nomes de ficheiros, chaves e variáveis são descobertos na configuração de cada projeto; nada está fixo para um projeto em particular.

Dada a documentação do que se vai testar, o agente:

1. **percebe que serviços e sistemas de apoio são precisos**: lê a documentação e a configuração de cada serviço (`application.yaml`, `docker-compose`, scripts de inicialização da base, migrações, README) e segue os `base-url` para os serviços que cada um chama;
2. **percebe o que é preciso criar lá dentro**: bases de dados novas (nome, esquema, utilizadores), tópicos e subscrições do Pub/Sub, o realm do Keycloak (ou outro servidor de identidade), o correio de teste;
3. **vê o que já está a correr e reutiliza-o** (um PostgreSQL que já corre não se duplica: cria lá dentro a base e os utilizadores que faltam) e **atribui as portas** do que cria, sem repetir nenhuma nem colidir com o que corre, mantendo a de omissão quando está livre;
4. **entrega o plano** com o mapa de portas, as ligações entre serviços (por variáveis de ambiente) e a ordem;
5. se lho pedires, **levanta o que falta**: sistemas de apoio, bases e tópicos, e os **microserviços em contentores** (do que é chamado para quem chama): constrói o jar no computador e corre-o na imagem Java que o próprio `Dockerfile` do projeto usa, desde que já esteja no computador (nada se descarrega); depois verifica que respondem;
6. no fim diz **o que está a correr**: cada coisa (contentor e imagem, ou processo), onde, as portas do computador e do contentor, o endereço, o `health`, como ver o registo e como parar; e avisa do que corre mas não é deste ambiente (outra versão do mesmo serviço numa porta habitual). Escreve o mesmo em `estado.md` e em `ambiente.json`.

```
claude/                              para Claude Code (vai para .claude/ no projeto)
  agents/levantador-ambiente.md
  skills/ambiente-local-de-testes/
copilot/                             para GitHub Copilot CLI (vai para .github/ no projeto)
  agents/levantador-ambiente.md
  skills/ambiente-local-de-testes/
instalar.sh                          copia para um projeto
```

A skill é igual nas duas pastas; só o cabeçalho do agente difere, porque cada ferramenta lê campos diferentes.

## As receitas do projeto

A skill não traz receitas de nenhum projeto: como se levanta cada **tipo de microserviço** e cada **serviço de apoio** (base de dados, Redis, Pub/Sub, Keycloak, correio...) está numa pasta do projeto, mantida pela equipa, que o agente lê em cada ambiente. Procura-a por esta ordem: a pasta indicada no pedido ou nos documentos da tarefa, a variável `RECEITAS_AMBIENTE`, e `receitas-ambiente/` na pasta que contém os microserviços. Sem pasta, ou sem receita para um microserviço ou sistema, usa o método geral e diz "sem receita" no plano.

```
receitas-ambiente/
  README.md              índice (opcional)
  tipos/<tipo>.md        uma por tipo de microserviço
  servicos/<sistema>.md  uma por serviço de apoio
```

Os modelos estão em `modelos-de-receita/` (copia a pasta para `receitas-ambiente/` e preenche; os ficheiros começados por `_` são modelos e o agente ignora-os). Como a skill as procura e usa: `referencia/pasta-de-receitas.md`.

## Instalar num projeto

```bash
./instalar.sh /caminho/do/projeto ambos
```

`claude` instala em `.claude/`, `copilot` em `.github/`, `ambos` nos dois.

## Usar

Claude Code:
```
usa o agente levantador-ambiente: que sistemas e portas preciso para testar docs/funcionalidade.md? Os repositórios estão em ~/projetos
```
O agente entrega o plano e o mapa de portas. Para o executar, diz-lhe o quê, na mesma conversa:

```
levanta tudo
só os sistemas de apoio
levanta tudo, e reutiliza o postgres que já corre              # só quando o queres
estado do ambiente
para o ambiente                       # pára; mantém os dados
apaga o ambiente                      # pára e apaga os contentores e os dados dele
```

Copilot CLI:
```bash
copilot --agent=levantador-ambiente -p "Que sistemas e portas preciso para testar docs/funcionalidade.md? Repositórios em ~/projetos."
```
Em modo não interativo (`-p`), o agente só levanta se o pedido já o disser (`... e levanta tudo`) e se as ferramentas de shell estiverem permitidas (`--allow-tool='shell'`).

**O agente não testa a tarefa:** só levanta o ambiente e confirma que está pronto a usar (`health`, ligações e um pedido só de leitura a cada serviço). Os critérios de aceitação e as coleções de testes são do passo de testes.

**No fim do plano, o agente pergunta sempre se quer que levante o ambiente** (levantar tudo, só os sistemas de apoio, ou não levantar) e espera pela resposta antes de dar a tarefa por terminada.

## Como trata o que já corre, as portas e as bases

- **Reutiliza antes de criar.** Vê os processos à escuta e os contentores. Um PostgreSQL, um Redis, um emulador de Pub/Sub ou um Keycloak que já corre e é o certo (confirma pelo protocolo e pela versão) usa-se tal como está, na porta onde está; nunca se duplica. Só cria (contentores `amb-<nome>-...` com a etiqueta `ambiente-local=<nome>`) o que falta. Não corre o `docker-compose` de cada serviço tal como está, porque cada um quereria a mesma porta.
- **Dentro de um sistema que já corre só acrescenta**: a base, o esquema e os utilizadores que faltam, de forma idempotente. Nunca `DROP`, `TRUNCATE`, `DELETE` nem `ALTER` do que existia. O plano diz, antes de levantar, exatamente o que vai criar lá dentro.
- Só usa **imagens que já existem no computador**; a versão pedida, ou a mais parecida (a mesma versão maior), dita no plano.
- Cada porta nova mantém a de omissão se estiver livre; senão tenta `omissão + 10000` (`5432 → 15432`), e depois a próxima livre. O que já corre fica na porta onde está. O mapa fica escrito antes de levantar, e cada porta é reconfirmada ao usá-la.
- Um serviço com porta nova obriga a religar quem o chama: o agente dá-lhe o endereço novo por variável (por exemplo `SERVICO_B_URL`), **nunca editando ficheiros do projeto**.
- Bases, esquemas, utilizadores, tópicos e subscrições criam-se a partir do script de inicialização da base do projeto e da configuração, sem escrever ficheiros (o SQL vai por *stdin* ou lê-se do repositório). As migrações correm no arranque do serviço.
- **Antes de levantar, apaga os contentores `amb-`** que esta skill criou (nome `amb-…` e etiqueta `ambiente-local`, de qualquer ambiente, microserviços e sistemas de apoio) e as redes `amb-…` que fiquem vazias; o plano diz quais. Os que têm o prefixo sem a etiqueta ficam. Os dados criados noutros sistemas (uma base no PostgreSQL do utilizador) também ficam.
- **Os microserviços são sempre contentores novos**, `amb-<nome>-<serviço>`, com o jar construído no momento a partir da pasta do repositório (o ramo da tarefa, com as alterações ainda sem commit). Nunca se aproveita um que já corre, mesmo que responda ao `health`. O que não é desta skill fica como está, o novo vai para outra porta, e o relatório avisa.

## O que o agente nunca faz

- Levantar sem o utilizador o pedir.
- **Alterar ficheiros dos projetos**, de configuração ou outros: os valores que mudam (portas, endereços, bases) vão por comando (variável de ambiente, argumento, `-e`).
- **Criar ou apagar fora das pastas dos repositórios**: os registos, os PIDs e o estado ficam em `<repositório>/target/ambiente-<nome>/` (ou `.ambiente-<nome>/`).
- **Escrever em git**: nunca `push`, `commit`, `checkout`, `stash` ou `reset`.
- Criar um sistema que já corre (um segundo PostgreSQL, por exemplo), ou parar o que reutilizou ou o que já corria.
- Escrever o valor de um segredo, ou inventar um que falta (pergunta).
- Matar o que já corria, ou o que ocupa uma porta; `down -v`, `rm`, `prune`, `volume rm`.
- Descarregar imagens: só usa as que já estão no computador (`--pull never`); se falta uma, diz qual e pergunta. Com o disco abaixo de 5 GB pára.
- Correr testes, migrações à mão, *deploys*, nem usar ambientes partilhados.

## Atualizar

Edita aqui, nas duas pastas, e volta a correr `instalar.sh` em cada projeto. Os projetos não devem editar a cópia local.
