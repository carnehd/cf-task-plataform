# Agente de implementação de tarefas

Agente `implementador-ms` + skill `implementacao-de-tarefas`. Genéricos: servem para qualquer projeto e qualquer tarefa que atravesse um ou mais microserviços (pensado para o que é comum: Spring Boot com Maven ou Gradle, base de dados, mensagens, identidade; o método não depende disso). Nada está fixo para um projeto em particular: o agente descobre a arquitetura, as regras e os nomes em cada repositório.

O agente:

1. **pede a documentação** da tarefa (um ficheiro ou pasta, um ticket colado, ou a tua descrição, que ele transforma em requisitos para confirmares);
2. **lê-a** e diz o que percebeu: requisitos, critérios de aceitação, decisões em aberto, com as dúvidas;
3. **descobre que microserviços mudam** (os da documentação e os que partem sem lá estar) e onde estão os repositórios;
4. **analisa o código** de cada um: as regras do repositório, o caminho de cada requisito, uma alteração parecida a copiar, os riscos;
5. **propõe o plano** por serviço e na ordem certa, e espera pelo teu sim;
6. **implementa**: um ramo por repositório, código, testes, configuração e documentação, construindo e testando sem estragar o que está a correr;
7. **entrega o relatório**: o que mudou, os testes que correu, a ligação requisito → ficheiros → testes, o que não verificou.

```
claude/                              para Claude Code (vai para .claude/ no projeto)
  agents/implementador-ms.md
  skills/implementacao-de-tarefas/
copilot/                             para GitHub Copilot CLI (vai para .github/ no projeto)
  agents/implementador-ms.md
  skills/implementacao-de-tarefas/
instalar.sh                          copia para um projeto
```

A skill é igual nas duas pastas; só o cabeçalho do agente difere, porque cada ferramenta lê campos diferentes.

## Instalar num projeto

```bash
./instalar.sh /caminho/do/projeto ambos
```

`claude` instala em `.claude/`, `copilot` em `.github/`, `ambos` nos dois. Instala no projeto de onde queres trabalhar (por exemplo, o repositório que tem a documentação, ou uma pasta que contenha os microserviços).

## Usar

Claude Code:
```
usa o agente implementador-ms: implementa a tarefa
```
Se não lhe deres a documentação, ele pede-a. Podes dá-la logo:
```
usa o agente implementador-ms: implementa os requisitos de docs/tarefa.md; os repositórios estão em ~/projetos
```

Copilot CLI:
```bash
copilot --agent=implementador-ms -p "Analisa docs/tarefa.md e diz-me que microserviços tenho de alterar e o plano."
```

O agente entrega a análise e o plano e **espera pelo teu sim** antes de alterar código. Responde ao plano com "implementa", ou com o que mudar. Se o pedido já diz "implementa sem pedir confirmação", ele mostra o plano e avança, desde que não haja dúvidas que bloqueiem. Na Copilot CLI, em modo não interativo (`-p`), o agente só analisa e planeia; para o deixar implementar, o pedido tem de o dizer e as ferramentas de escrita e de shell têm de estar permitidas.

## O que o agente nunca faz

- Implementar sem documentação, ou acrescentar o que a documentação não pede.
- Decidir por ti as decisões em aberto da documentação.
- Alterar um repositório com alterações tuas por commitar sem perguntar, nem perder o que lá está.
- `git commit`, `git push`, *deploys*, apagar dados, volumes, contentores ou ramos.
- Correr contra ambientes partilhados, ou escrever valores de segredos.
- Construir na pasta de um serviço que está a correr, nem fazer `install` no `~/.m2` sem pedir.
- Correr migrações contra uma base que já existe sem pedir.

## Atualizar

Edita aqui, nas duas pastas, e volta a correr `instalar.sh` em cada projeto. Os projetos não devem editar a cópia local.
