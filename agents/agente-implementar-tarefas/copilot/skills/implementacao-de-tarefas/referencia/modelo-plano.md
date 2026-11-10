# Modelo do plano

Curto, em tabelas, com evidência (`ficheiro:linha`). Sem código no plano: o código vem depois de um sim.

````markdown
# Plano: <nome da tarefa>

**Documentação:** `<ficheiro>` · **Tarefa:** <identificador> · **Ramo:** `feature/<ticket>-<descrição>`

## O que a tarefa pede
<uma frase>

## Requisitos
| # | Requisito | Critério de aceitação |
|---|---|---|
| R1 | <texto curto> | <como se prova> |

## Serviços
| Serviço | Pasta | Ramo atual | Por commitar | Ferramenta | Muda? |
|---|---|---|---|---|---|
| ms-a | `/caminho/ms-a` | main | limpo | Maven | **sim**, R1 R2 |
| ms-b | `/caminho/ms-b` | main | 1 ficheiro teu | Maven | sim, R3 |
| ms-c | `/caminho/ms-c` | main | limpo | Maven | **não previsto**: chama o endpoint que muda (`ClienteA.java:41`) |

## Ordem
1. `ms-a` (fornece o contrato; alterações compatíveis)
2. `ms-b` (consome)
<porquê esta ordem>

## Tarefas
### ms-a (`/caminho/ms-a`)
| Tarefa | Requisitos | O que muda | Ficheiros | Teste |
|---|---|---|---|---|
| T1 | R1 | campo novo no pedido, com validação | `CriarPedido.java:12`, `Pedido.java:30` | `PedidoTest`: campo em falta, formato inválido |
| T2 | R2 | coluna nova | `db/changelog/changes/002-...yaml` (novo) | migração numa base descartável |
| T3 | R1 R2 | configuração e documentação | `application.yaml:45`, `configmap.yaml`, OpenAPI, coleção de testes de API | teste de API |

### ms-b
...

## Riscos e compatibilidade
- <o que pode partir e quem depende>

## Fora deste plano
- <o que a documentação deixa de fora, ou que eu escolhi não fazer, e porquê>

## Premissas e dúvidas
- <o que assumi, a verde ou a confirmar>

## Como vou verificar
- testes por módulo e `verify` por repositório (numa cópia, se o serviço está a correr)
- <verificação de ponta a ponta, se a tarefa a pede: com o quê>

Posso implementar? Diz "implementa", ou o que mudar.
````

## Regras do plano

- Cada requisito aparece em pelo menos uma tarefa. Um requisito sem tarefa tem de dizer porquê (já existe, fora do âmbito).
- Cada tarefa tem pelo menos um teste. Uma que não pode ter (configuração) diz como se verifica.
- Mostra a divisão entre o que a documentação manda e o que tu deduziste.
- Nada de datas nem de estimativas de tempo.
