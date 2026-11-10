# Alocação de portas

Regras: nenhuma porta repetida no ambiente, nenhuma que já esteja ocupada, nenhuma mudada sem religar quem a usa. **O que já corre e vais reutilizar não recebe porta nova**: entra no mapa com a porta onde está, e as portas dos outros calculam-se à volta dela. Só o que crias recebe uma porta atribuída.

## 1. Reúne o que o ambiente quer

Uma linha por porta, com o dono e a de omissão (com evidência):

| Dono | Para quê | Por omissão | Onde |
|---|---|---|---|
| ms-a | HTTP | 8100 | `application.yaml:3` |
| ms-a | gestão (*actuator*) | 9100 | `application.yaml:41` |
| ms-b | HTTP | 8100 | `application.yaml:3` |
| postgres | SQL | 5432 | `docker-compose.yaml:7` |
| redis | cache | 6379 | `application.yaml:11` |
| pubsub | emulador | 8085 | `docker-compose.yaml:30` |

Duas linhas com a mesma porta por omissão (ms-a e ms-b acima) é **normal** e é o caso que este passo resolve: nunca podem coexistir.

## 2. Reúne o que está ocupado

Só leitura, com limite de tempo nos comandos do motor de contentores:

| Origem | macOS / Linux | Windows (PowerShell) |
|---|---|---|
| Processos à escuta | `lsof -nP -iTCP -sTCP:LISTEN` (ou `ss -ltnp`) | `Get-NetTCPConnection -State Listen \| Select LocalPort,OwningProcess` |
| Portas publicadas por contentores | `docker ps --format '{{.Names}}\t{{.Ports}}'` (e `podman ps`) | o mesmo |
| Serviços do sistema | AirPlay (5000, 7000) e outros do macOS; uma máquina do Podman ou do Docker Desktop escuta em várias | `netstat -ano` |

E o que **tu próprio já planeaste** neste ambiente. O conjunto das ocupadas é a união dos três. As portas dos contentores `amb-` com a etiqueta `ambiente-local` contam como **livres**: esses contentores apagam-se antes de levantar (SKILL, regra 15). Uma porta ocupada **por um sistema reutilizável** (um PostgreSQL que já corre na 5432) não é um problema: é o sistema que vais usar (`referencia/reutilizar-o-que-corre.md`); ocupada por outra coisa, é um conflito, e o que crias vai para outra porta.

## 3. Atribui, por ordem de dependência

Sistemas de apoio primeiro, depois os serviços que os usam, os que são chamados antes dos que chamam. Para cada entrada:

1. Se a de omissão está livre e ninguém a planeou: **fica**. O ambiente o mais parecido possível com o normal.
2. Senão, tenta `de omissão + 10000` (`5432 → 15432`, `8100 → 18100`). Reconhece-se à primeira vista.
3. Senão, a próxima livre a partir daí (`+1`), até 200 tentativas.
4. Regras: nunca abaixo de 1024, nunca na faixa dinâmica (49152 e acima), nunca uma porta que outra entrada já tem, e nunca a mesma porta em endereços diferentes (`0.0.0.0` e `127.0.0.1` colidem).
5. Contentores (de apoio e microserviços) publicam só em `127.0.0.1` (`-p 127.0.0.1:<porta-do-mapa>:<porta-de-dentro>`). Dentro do contentor o serviço fica na porta por omissão da sua configuração; o que muda é só a porta do computador. Entre contentores da rede do ambiente usa-se a porta de dentro, pelo nome do contentor.

Um serviço com duas portas (HTTP e gestão) recebe as duas pelo mesmo método; se a HTTP mudou, a de gestão, em geral, também.

## 4. O mapa

Escreve-o inteiro **antes** de levantares qualquer coisa:

| Dono | Para quê | Por omissão | Atribuída | Porquê mudou |
|---|---|---|---|---|
| postgres | SQL | 5432 | **15432** | 5432 ocupada (contentor do utilizador) |
| redis | cache | 6379 | **16379** | 6379 ocupada |
| ms-a | HTTP | 8100 | 8100 | livre |
| ms-b | HTTP | 8100 | **18100** | repetida: ms-a ficou com 8100 |

## 5. Religar quem usa a porta nova

Cada porta que mudou obriga a mudar **quem lhe fala**, sempre por variável de ambiente, na linha de comando do consumidor:

| Consumidor | Variável (como está na configuração) | Valor novo |
|---|---|---|
| ms-b | `SERVICO_A_URL` (`application.yaml:90`) | `http://localhost:8100` |
| ms-a | `DATABASE_URL` (`application.yaml:25`) | `jdbc:postgresql://localhost:15432/<base>` |
| ms-a | `REDIS_PORT` | `16379` |
| ms-a e ms-b | `SERVER_PORT` (ou a que a configuração declarar) | `8100`, `18100` |

Regras:
- Usa o nome **exato** da variável que a configuração declara (`${NOME:valor}`). Em Spring, `server.port` também aceita `SERVER_PORT`, mas só se a configuração não o fixou. Nunca uses nomes de variáveis de outro projeto.
- Se a configuração fixa um valor sem variável, usa `SPRING_APPLICATION_JSON='{"server":{"port":18100}}'` ou o argumento `--server.port=18100`. Se nem isso serve, diz que não se consegue sem editar o ficheiro, e pergunta.
- Os testes (coleção de API, `curl`) também chamam portas: no relatório dizes **que variável do ambiente de testes** o utilizador tem de trocar (por exemplo `baseUrl`), sem editares nada.
- Um serviço dentro de um contentor que chama um sistema que está no computador usa `host.docker.internal` (Docker) ou `host.containers.internal` (Podman), não `localhost`.

## 6. Reconfirma ao usar

Entre planear e levantar, o mundo muda. Imediatamente antes de usar cada porta, vê outra vez que está livre. Se não, volta ao passo 3 só para essa entrada e atualiza o mapa e as variáveis de quem a usa.
