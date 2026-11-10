# Perguntas, e como as fazer

Pergunta só o que falta e bloqueia. O que o pedido já diz, ou o repositório mostra, não se pergunta. Uma só mensagem, numerada, cada pergunta com a resposta que assumirias.

## 1. No início (antes de ler qualquer coisa)

Só as que o pedido não responde:

```text
Antes de começar, preciso de:

1. Onde está a documentação da tarefa? (um ficheiro ou pasta, um ticket colado, ou descreve-a aqui.)
2. Qual é o identificador da tarefa, para o nome do ramo? (Sem ele uso `feature/<descrição>`.)
3. Onde estão os repositórios dos microserviços? (A pasta que os contém. Se não disseres, procuro nas pastas ao lado da atual.)
```

Se o utilizador responde só a 1, segue com as assunções das outras e assinala-as no plano.

Documentação em falta de todo: "Sem documentação não implemento. Cola-a aqui, indica o ficheiro, ou descreve a tarefa e eu escrevo os requisitos como os percebi, para tu confirmares."

Documentação num endereço que não abres (wiki, Jira, Confluence): "Não consigo abrir isto daqui. Cola o texto, ou exporta-o para um ficheiro Markdown e diz-me onde está."

## 2. Depois de ler a documentação

- **Ambiguidades**: dois requisitos que se contradizem, um campo sem tipo, um comportamento por definir. Cita o sítio (`tarefa.md:112`) e propõe a leitura que adotarias.
- **Decisões em aberto** da própria documentação (as marcadas "a confirmar", "P1", "proposta"): mostra cada uma com a proposta que a documentação assume, e pede a decisão. Resposta curta aceite: "adota as propostas".
- **Falta de contrato**: um serviço referido sem endpoint, mensagem ou tabela definidos.
- **Ordem e compatibilidade**: se a documentação não diz se pode partir clientes antigos, pergunta.

Exemplo:

```text
Li o documento. Antes do plano preciso de decisão em 3 pontos:

1. D2, tamanho máximo do campo (`tarefa.md:81`): a proposta é 100 caracteres. Mantenho?
2. O documento exige um valor único (R4) mas não diz o que acontece com os registos cancelados. Assumo que não contam.
3. R6 manda o serviço B publicar a mensagem, mas hoje só escreve no log. Implemento já o publicador, ou só o formato da mensagem?

As restantes decisões (D3 a D9) assumo as propostas do documento, se me disseres "adota as propostas".
```

## 3. Antes de implementar

- Repositório com alterações por commitar do utilizador: "Em `<pasta>` há alterações tuas por commitar (`<ficheiros>`). Trabalho por cima, e o ramo novo leva-as, ou limpas tu primeiro?"
- Serviço sem repositório local: "Não encontrei o repositório de `<serviço>`. Onde está? (Não o clono sem um sim.)"
- Serviço a correr a partir da pasta: "O `<serviço>` está a correr daqui (`target/classes`). Construo numa cópia para não o partir. Corre?"
- Dependência nova, migração contra uma base existente, `install` no `~/.m2`: um pedido de cada vez, com o que muda.

## 4. Durante

Quando o plano deixa de se sustentar: o que encontraste, o que isso muda, duas opções com a que recomendas. Uma pergunta, não uma lista.
