# Cobertura de requisitos

Atualizado em: AAAA-MM-DD · Microserviço: `<microserviço>` · Coleção: `<microserviço>/bruno` · Ambiente: `<nome>` · Ramo base: `<base>` (`<merge-base>`) · Documentação: `<documentos>`

Cada requisito tem a sua pasta na raiz da coleção, com o identificador do requisito como nome. Correr um requisito: `bru run <REQ-ID> --env <ambiente>`.

Tipos: **novo** · **alterado** (testa-se o novo e que o antigo deixou de valer) · **removido** (testa-se que saiu) · **mantido** (a documentação diz que fica igual) · **regressão** (o que a alteração pode partir e a documentação não muda)

Estados: ✅ coberto e a passar · ❌ coberto e a falhar · ⬜ em falta · ➖ não testável por API

Os testes são links para o ficheiro, com nome completo. Sem abreviaturas. Doc é a parte da documentação de onde vem o critério; numa regressão, a origem.

| Requisito | Tipo | Critério de aceitação | Doc | Testes | Estado | Observação |
|---|---|---|---|---|---|---|
| R1-1 | novo | Criar devolve 201 com o id gerado | `requisito.md` §2.1 | [R1/02-criar-201](R1/02-criar-201.bru) | ✅ | |
| R1-2 | alterado | Nome passa a obrigatório (antes era opcional) | `requisito.md` §2.2 | [R1/03-criar-sem-nome-400](R1/03-criar-sem-nome-400.bru) | ✅ | o pedido antigo, sem nome, já é recusado |
| R1-3 | alterado | Nome até 100 caracteres (antes 150) | `requisito.md` §2.2 | [R1/04-criar-nome-101-400](R1/04-criar-nome-101-400.bru) | ❌ | Código aceita 150; ver `Dominio.java:23` |
| R1-4 | removido | `apelido` deixa de vir na resposta | `requisito.md` §2.3 | [R1/05-obter-sem-apelido](R1/05-obter-sem-apelido.bru) | ✅ | |
| R2-1 | novo | Apagar com dependências dá 409 | `requisito.md` §3 | | ⬜ | Regra não existe no código |
| R3-1 | novo | Enviar email de boas-vindas | `requisito.md` §4 | | ➖ | Sem endpoint para verificar; confirmar por log |
| R1-5 | mantido | A pesquisa por estado continua igual | `requisito.md` §5: "a pesquisa mantém-se" | [pesquisa/03-por-estado](pesquisa/03-por-estado.bru) | ✅ | teste que já existia |
| R1-REG-1 | regressão | Listar continua a devolver 200 com id, nome e estado | diff em `ClienteRepository.java:41` (não documentada) | [R1/06-regressao-listar-200](R1/06-regressao-listar-200.bru) | ✅ | |

## Testes por requisito (índice inverso)

Todos os ficheiros da pasta do requisito, com o critério lido do bloco `docs` de cada um.

### R1

| Ficheiro | Critério | O que verifica |
|---|---|---|
| [01-prep-dados](R1/01-prep-dados.bru) | preparação da cadeia | dados únicos da execução |
| [02-criar-201](R1/02-criar-201.bru) | R1-1 | criar devolve 201 e o id; produz `r1Id` |
| [03-criar-sem-nome-400](R1/03-criar-sem-nome-400.bru) | R1-2 | nome obrigatório |
| [04-criar-nome-101-400](R1/04-criar-nome-101-400.bru) | R1-3 | limite de 100 caracteres |
| [05-obter-sem-apelido](R1/05-obter-sem-apelido.bru) | R1-4 | a resposta já não traz `apelido` |
| [06-regressao-listar-200](R1/06-regressao-listar-200.bru) | R1-REG-1 | a listagem mantém o código e os campos do contrato da base |
| [07-limpeza](R1/07-limpeza.bru) | limpeza da cadeia | remove o recurso criado em 02 |

Testes sem critério: 0.

## Cadeia de pedidos
Ordem de execução e dados que passam de um pedido para o seguinte.

| # | Pedido | Consome | Produz | Estado ou efeito que deixa |
|---|---|---|---|---|
| 01 | `R1/01-prep-dados.bru` | | `r1Sufixo` | |
| 02 | `R1/02-criar-201.bru` | `r1Sufixo` | `r1Id` | recurso criado, estado inicial |
| 03 | `R1/03-criar-sem-nome-400.bru` | | | sem alteração (400 esperado) |
| 04 | `R1/04-criar-nome-101-400.bru` | | | sem alteração (400 esperado) |
| 05 | `R1/05-obter-sem-apelido.bru` | `r1Id` | | |
| 06 | `R1/06-regressao-listar-200.bru` | `r1Id` | | |
| 07 | `R1/07-limpeza.bru` | `r1Id` | | recurso removido |

## Dúvidas sobre o requisito
- R1-2: "nome curto" não define mínimo. Assumido 1 carácter.

## Divergências encontradas
- R1-3, limite de 100: a implementação valida 150 (`Dominio.java:23`). O teste segue o requisito.

## Alterações face ao ramo base

Base: `origin/develop` (merge-base `a1b2c3d`).

| Alteração | Onde | Critério |
|---|---|---|
| `nome` passa a obrigatório em `POST /clientes` | contrato (`openapi.yaml`) e `ClienteRequest.java:12` | R1-2 |
| `apelido` sai da resposta de `GET /clientes/{id}` | contrato (`openapi.yaml`) | R1-4 |
| `ClienteRepository.listar` muda a query (junta `estado`) | `ClienteRepository.java:41` | **não documentada**; coberta por R1-REG-1 |

Critérios sem alteração no código: R2-1 (apagar com dependências).
