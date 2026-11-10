# Modelo do plano e do relatório

Curto, em tabelas, com evidência (`ficheiro:linha`). Nenhum valor de segredo: diz-se o nome e onde se define.

## Plano (modo Planear)

````markdown
# Ambiente de testes: <nome>

**Para testar:** <funcionalidade, em uma frase> · **Documentação:** `<ficheiro>` · **Regras:** reutilizo os sistemas de apoio que já correm; os microserviços são sempre contentores novos (`amb-<nome>-...`), com o jar construído agora; não altero ficheiros dos projetos (os valores vão por comando); só escrevo dentro das pastas dos repositórios; nada de git além de ler

## Vou apagar antes de levantar
Os contentores `amb-` que esta skill criou antes (etiqueta `ambiente-local`), de qualquer ambiente, e as redes `amb-…` que fiquem vazias:

| Contentor | Ambiente | Estado | Portas que ficam livres |
|---|---|---|---|
| `amb-<outro>-redis` | `<outro>` | a correr | 6379 |
| `amb-<nome>-ms-b` | `<nome>` | parado | 18100, 19100 |

(Nenhum: "não há contentores `amb-` para apagar". Com o prefixo mas sem a etiqueta: "`<nome>` fica, não é desta skill".)

## O que já está de pé
| Coisa | Onde | Confirmação | Serve? |
|---|---|---|---|
| PostgreSQL 16 | contentor `<nome>`, `localhost:5432` | `pg_isready` ok, versão 16.x | **sim: reutilizo** |
| Redis | — | não corre | falta: crio |
| ms-a | processo, `localhost:8100` | `health` `UP` | **não**: os microserviços são sempre contentores novos; este fica como está |

(Se o motor de contentores não respondeu: "não consegui ver os contentores; não assumo nada reutilizável".)

## Receitas
**Pasta:** `<pasta de receitas>` (encontrada em: <pedido / documentos / `RECEITAS_AMBIENTE` / `receitas-ambiente/` na raiz>)

| Microserviço ou sistema | Receita | Variáveis preenchidas (valor · de onde) |
|---|---|---|
| ms-a | `<ficheiro da receita do tipo>` | `<VARIÁVEL>` = `<valor>` · `application.yaml:3`; `<VARIÁVEL>` = `<valor>` · nome do repositório |
| PostgreSQL | `<ficheiro da receita do serviço>` | `<VARIÁVEL>` = `<valor>` · `docker/init-db.sql:2` |
| ms-c | **sem receita**: método geral | |

(Sem pasta: "não encontrei a pasta de receitas; uso o método geral", e a pergunta do fim pede-a. Um passo de uma receita que uma regra proíbe: "não sigo o passo `<x>` de `<receita>`: descarregava uma imagem (regra 8)". Não se copia o conteúdo das receitas: cita-se o ficheiro.)

## Serviços
| Serviço | Pasta | Porta por omissão | Origem | Como corre | Evidência |
|---|---|---|---|---|---|
| ms-a | `/caminho/ms-a` | 8100 | **novo** (8100 está ocupada por um processo que não é deste ambiente) | contentor `amb-<nome>-ms-a`, imagem `eclipse-temurin:21-jre`, na porta 18101 | `application.yaml:3` |
| ms-b | `/caminho/ms-b` | 8100 | **novo** | contentor `amb-<nome>-ms-b`, imagem `eclipse-temurin:21-jre` (a do `Dockerfile:18`, local), jar do módulo `ms-b-aplicacao` | `application.yaml:3` |
| ms-c | `/caminho/ms-c` | 8103 | **não previsto**: `ms-b` chama-o (`application.yaml:90`) | contentor `amb-<nome>-ms-c` | |

(Se o `Dockerfile` do projeto descarrega coisas na construção: "não construo pelo `Dockerfile` (usa `maven:...`, que não está cá, e `dependency:go-offline`): construo o jar e corro-o na imagem final dele".)

## Sistemas de apoio
| Sistema | Quem usa | Origem | Imagem | O que criar lá dentro | Evidência |
|---|---|---|---|---|---|
| PostgreSQL 16 | ms-a | **reutilizado** | (já corre) | no que já corre: utilizadores `<migrações>` e `<aplicação>`, base `<base>`, esquema `<esquema>`; só se faltarem | `<script de inicialização>:1`, `application.yaml:25` |
| Redis 7 | ms-b | **novo** | `redis:7-alpine` (local; a pedida é `redis:7`) | nada | `application.yaml:11` |
| Emulador Pub/Sub | ms-b | **novo** | `<imagem local>` | projeto `<projeto>`, tópico `<tópico>`, subscrição `ver` | `application.yaml:60` |

## Mapa de portas
| Dono | Para quê | Por omissão | Atribuída | Origem / porquê |
|---|---|---|---|---|
| postgres | SQL | 5432 | 5432 | reutilizado: fica onde está |
| redis | cache | 6379 | 6379 | novo; livre |
| ms-a | HTTP / gestão | 8100 / 9100 | 8100 / 9100 | reutilizado |
| ms-b | HTTP / gestão | 8100 / 9100 | **18100 / 19100** | novo; repetidas: ms-a já as tem |

## Ligações entre serviços (variáveis `-e`, nunca ficheiros)
| Serviço | Variável | Valor | Evidência |
|---|---|---|---|
| ms-b | `SERVICO_C_URL` | `http://amb-<nome>-ms-c:8103` (contentor do ambiente: pelo nome) | `application.yaml:90` |
| ms-b | `SERVICO_A_URL` | `http://host.docker.internal:8100` (corre no computador) | `application.yaml:91` |
| ms-b | `DATABASE_URL` | `jdbc:postgresql://host.docker.internal:5432/<base>` (postgres reutilizado) | `application.yaml:25` |

## Ordem
1. Sistemas de apoio que faltam: redis, pubsub.
2. Criar: base `<base>` no postgres que já corre, tópico `<tópico>`.
3. ms-b (o ms-a já corre).

## Onde ficam o estado e os registos
- `<repo-de-ms-b>/target/ambiente-<nome>/` (registo e PID de ms-b) e `<repo>/target/ambiente-<nome>/estado.md`. Nada fora dos repositórios.

## Verificação (só prontidão: os testes da tarefa são do passo seguinte)
- `pg_isready`, `redis-cli ping`, `health` de cada serviço (inclui a base de dados e o Redis), o tópico e o realm que respondem, e um pedido só de leitura a cada serviço. Nenhum pedido que cria ou altera dados, nenhuma coleção de testes.

## Como parar
- Só o que levanto (redis, pubsub, ms-b), pelas etiquetas e pelos PIDs. **Não páro** o postgres nem o ms-a (já corriam). A base `<base>` que criei no postgres fica; digo-te como a apagar se quiseres.

## Dúvidas
- <o que nenhum ficheiro diz, com a pergunta que o resolve>
- <palavras-passe locais em falta: onde se definem>

Levanto? Diz "levanta tudo", "só os sistemas de apoio", ou o que mudar.
````

## Relatório (modo Levantar)

````markdown
# Ambiente de testes: <nome> (de pé)

**Resultado:** <tudo de pé e verificado / de pé, com X por verificar / parado em ... porque ...>

## O que está a correr
| O quê | Como corre | Portas (computador → contentor) | Endereço | Health | Estado | Registo | Origem |
|---|---|---|---|---|---|---|---|
| ms-b (ramo `feature/x`, commit `a1b2c3d`) | contentor `amb-<nome>-ms-b`, imagem `eclipse-temurin:21-jre` | 18100 → 8100, 19100 → 9100 | `http://localhost:18100` | `http://localhost:19100/actuator/health` | `UP` | `docker logs -f amb-<nome>-ms-b` | novo |
| ms-c | contentor `amb-<nome>-ms-c`, imagem `eclipse-temurin:21-jre` | 8103 → 8103, 9103 → 9103 | `http://localhost:8103` | `http://localhost:9103/actuator/health` | `UP` | `docker logs -f amb-<nome>-ms-c` | novo |
| redis | contentor `amb-<nome>-redis`, imagem `redis:7-alpine` | 6379 → 6379 | `localhost:6379` | `redis-cli ping` | pronto | `docker logs amb-<nome>-redis` | novo |
| postgres | contentor `<nome do utilizador>`, imagem `postgres:16` | 5432 → 5432 | `localhost:5432` | `pg_isready` | pronto | — | **reutilizado** (não é meu: não o paro) |
| ms-a (ramo `feature/x`, commit `a1b2c3d` + alterações por guardar) | contentor `amb-<nome>-ms-a`, imagem `eclipse-temurin:21-jre` | 18101 → 8100, 19101 → 9100 | `http://localhost:18101` | `http://localhost:19101/actuator/health` | `UP` | `docker logs -f amb-<nome>-ms-a` | novo |

Rede do ambiente: `amb-<nome>` (os contentores novos falam uns com os outros pelo nome).

## A correr, mas não é deste ambiente
| O quê | Onde | Porque importa |
|---|---|---|
| ms-a (um processo que já corria, PID 15190) | `localhost:8100` | é a porta habitual do ms-a e pode ter outro código: **testa contra 18101**, não contra 8100 |

## O que criei dentro do que já corria
- Base `<base>` (esquema `<esquema>`, utilizadores `<migrações>` e `<aplicação>`) no postgres que já corria; já existia? "já existia: usei como estava"

## O que não toquei
- Nenhum ficheiro dos projetos. Nada fora das pastas dos repositórios, a não ser o que as ferramentas de construção escrevem nas suas caches. Nada em git.
- Os teus contentores e processos: intactos.

## Usar nos testes (sem editar nada)
- Coleção de testes de API: passa o endereço base por linha de comando em vez de editar o ficheiro do ambiente (por exemplo, `--env-var baseUrl=http://localhost:18100` no Bruno)
- Ver as mensagens do Pub/Sub: <comando de leitura da subscrição>

## Parar
```bash
docker stop $(docker ps -q --filter label=ambiente-local=<nome>)     # só os contentores deste ambiente
```
(O postgres e o processo do ms-a em 8100 não se param: não são deste ambiente. "Apaga o ambiente" remove também os contentores e a rede `amb-<nome>`.)

## Por verificar / dúvidas
- <o que não consegui verificar, e porquê>
````

## `estado.md` e `ambiente.json`

Onde: em `<repositório>/target/ambiente-<nome>/` (ou `<repositório>/.ambiente-<nome>/`) ou, dentro de uma plataforma que te dá uma pasta de resultados, nessa pasta.

`estado.md`: a tabela "O que está a correr", com a origem de cada coisa; a lista do que levantaste (contentores com nome e etiqueta, a rede, processos com PID e comando se os houver); o que reutilizaste (com a nota "não é meu: não se pára"); o que corre mas não é deste ambiente; e o que criaste dentro de sistemas reutilizados (uma base, um tópico). É o que uma conversa nova lê para saber o que está de pé e o que parar. Sem segredos.

`ambiente.json`: o mesmo, para uma ferramenta ler (sem segredos):

```json
{
  "nome": "<nome>",
  "verificadoEm": "2026-11-08T17:01:00Z",
  "rede": "amb-<nome>",
  "itens": [
    {
      "nome": "ms-b",
      "tipo": "servico",
      "origem": "novo",
      "comoCorre": "contentor",
      "contentor": "amb-<nome>-ms-b",
      "imagem": "eclipse-temurin:21-jre",
      "pid": null,
      "ramo": "feature/x",
      "commit": "a1b2c3d",
      "alteracoesPorGuardar": true,
      "construido": "2026-11-08T16:58:00Z",
      "portas": [{ "computador": 18100, "contentor": 8100, "para": "http" }, { "computador": 19100, "contentor": 9100, "para": "gestao" }],
      "endereco": "http://localhost:18100",
      "saude": "http://localhost:19100/actuator/health",
      "estado": "UP",
      "registo": "docker logs -f amb-<nome>-ms-b",
      "parar": "docker stop amb-<nome>-ms-b"
    },
    {
      "nome": "postgres",
      "tipo": "sistema",
      "origem": "reutilizado",
      "comoCorre": "contentor",
      "contentor": "postgres",
      "imagem": "postgres:16",
      "portas": [{ "computador": 5432, "contentor": 5432, "para": "sql" }],
      "endereco": "localhost:5432",
      "estado": "pronto",
      "parar": null
    }
  ],
  "foraDoAmbiente": [
    { "nome": "ms-b", "comoCorre": "processo", "pid": 15190, "endereco": "http://localhost:8100", "nota": "versão antiga, sem as alterações da tarefa" }
  ]
}
```

`tipo`: `servico` ou `sistema`; `origem`: `novo` ou `reutilizado`; `comoCorre`: `contentor` ou `processo`; `parar`: o comando, ou `null` no que não é deste ambiente.
