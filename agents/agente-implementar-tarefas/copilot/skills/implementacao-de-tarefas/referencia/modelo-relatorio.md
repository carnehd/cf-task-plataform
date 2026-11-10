# Modelo do relatório final

Honesto e curto. Estados: **passou**, **falhou**, **não corri** (com a razão). Nunca "deve funcionar".

````markdown
# Implementação: <nome da tarefa>

**Resultado:** <uma frase: feito e verificado / feito, com X por verificar / parado em T3 porque ...>

## Por serviço
### ms-a: `feature/<ticket>-<descrição>` (`/caminho/ms-a`)
| Ficheiro | Alteração |
|---|---|
| `src/.../CriarPedido.java` | campo `codigo`, obrigatório quando o tipo é `A` |
| `db/changelog/changes/002-...yaml` | colunas novas (novo) |

Testes: <n> corridos, <n> a passar, <n> novos. `verify`: **passou** / **falhou** (<qual>). Construído numa cópia: sim/não.

### ms-b ...

## Rastreabilidade
| Requisito | Ficheiros | Teste que o prova | Estado |
|---|---|---|---|
| R1 | `CriarPedido.java`, `Pedido.java` | `PedidoTest.campoEmFalta` | passou |
| R2 | `002-...yaml` | migração numa base descartável | passou |
| R3 | `ClienteA.java` | — | **não corri** (precisa do serviço real) |

## Decisões
| Decisão | Quem | Onde |
|---|---|---|
| Tamanho máximo do campo: 100 | utilizador | pergunta 1 |
| Campo opcional em vez de obrigatório no serviço B | eu, por compatibilidade | `Pedido.java:30` |

## O que não foi feito, ou não foi verificado
- <cada coisa, com a razão>

## Testes que já falhavam antes
- <teste, e como sei que já falhava (corrido antes de alterar)>

## Riscos
- <o que um cliente antigo, um dado existente ou outro serviço pode sentir>

## Ordem de colocação em ambiente
1. <primeiro o que não parte nada> ...

## Como testar à mão
```bash
<os comandos, com valores fictícios; nunca segredos>
```

## A seguir
- Ver o diff de cada repositório: `git -C <pasta> diff main...`
- Nada foi commitado nem enviado. Mensagem sugerida para cada repositório: `<ticket>: <resumo>`
````

## Regras

- A tabela de rastreabilidade tem **todos** os requisitos, também os que não foram feitos.
- "Passou" só com a saída que o viste: o número de testes e o resultado do `verify`.
- Ficheiros por caminho relativo ao repositório. Sem valores de segredos, sem dados pessoais reais.
- Se paraste a meio, o relatório diz exatamente onde: o repositório fica num estado que compila? Que tarefas estão feitas?
