# Reutilizar o que já corre

Regra: antes de criar, vê o que já está de pé e usa-o. Só crias o que falta. Nunca duplicas um sistema que já corre (dois PostgreSQL, dois Redis...), e nunca mexes no que não é teu além do que o plano diz.

**"Não é teu" não é razão para criares outro.** Um contentor que o utilizador já tinha serve na mesma: ligas-te a ele e acrescentas lá dentro o que falta (secção 4). Só não o paras, não o reinicias e não o apagas.

**Os contentores `amb-` que esta skill criou** (nome a começar por `amb-` e etiqueta `ambiente-local`, de qualquer ambiente) **não se reutilizam**: apagam-se antes de levantar (SKILL, regra 15), e o que fazia falta cria-se de novo.

## 1. Ver o que corre (só leitura, com limite de tempo)

```bash
limite 15 docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}'     # contentores a correr (limite: receitas, secção 1)
lsof -nP -iTCP -sTCP:LISTEN                                                    # processos à escuta (também os que não são contentores)
```

PowerShell: `Get-NetTCPConnection -State Listen | Select LocalPort,OwningProcess`. Com Podman, `podman ps`.

Se o motor não responde (saída `124`), dizes que não o conseguiste ver, não assumes nada reutilizável e propões o plano com o que sabes (o que o `lsof` mostra continua válido).

Contentores parados com o nome certo existem, mas **não contam** como "a correr". Não os arrancas: dizes que há um parado e perguntas se o utilizador o quer arrancado (é dele).

## 2. Reconhecer, e confirmar

Uma porta aberta não chega: confirma que é o sistema que se pensa, com o protocolo dele.

| Sistema | Como se reconhece | Confirmação | Criar lá dentro, sem credenciais |
|---|---|---|---|
| PostgreSQL | imagem `postgres*`; porta 5432 (ou a que a configuração do serviço usa) | `docker exec <c> pg_isready`; versão: `docker exec <c> psql -U postgres -Atc 'show server_version'` | `docker exec -i <c> psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres` com o SQL por *stdin* |
| Redis | imagem `redis*`; porta 6379 | `docker exec <c> redis-cli ping` responde `PONG` | nada a criar |
| Emulador Pub/Sub | imagem com `emulators` ou `pubsub`; porta 8085 | `curl -fsS -m 5 http://localhost:<porta>/` responde `Ok` | tópicos e subscrições pela API REST (um que já existe devolve conflito, que não é erro) |
| Keycloak | imagem `keycloak`; porta 8080 | `curl -fsS -m 5 http://localhost:<porta>/realms/<realm>` | o realm não existe? importar pela API de administração precisa de credenciais: pergunta |
| Correio de teste | imagem `mailpit` ou `mailhog` | a API ou a página de informação | nada a criar |
| Kafka, RabbitMQ | imagem e porta do sistema | o comando de diagnóstico do próprio sistema | tópicos e filas que faltam |
| Observabilidade | imagem `otel-lgtm` ou semelhante | só se o utilizador a quer | — |
| Um microserviço | — | **não se reutiliza**: cada microserviço do plano é sempre um contentor novo, com o jar construído agora (SKILL, regra 13). Um que já corre fica como está e vai para "A correr, mas não é deste ambiente" | — |

Se o sistema **não** é um contentor (um PostgreSQL instalado no computador, um processo local), a confirmação faz-se pelo protocolo, de fora (`pg_isready -h localhost -p <porta>`), e para escrever lá dentro precisas de credenciais: as que o projeto define para local; se não há, pergunta.

## 3. Quando servir, e quando não

Reutiliza se:
- é o sistema certo (a confirmação acima) e responde;
- a versão serve: a mesma versão maior que a configuração ou a documentação pede (um PostgreSQL 16 serve para o que pede 16);
- é local (`localhost`), nunca um endereço de um ambiente partilhado.

O utilizador a dizer "sem pedir confirmação do plano" não muda isto: dispensa a pergunta, não dispensa o reaproveitamento.

Há **dois candidatos** do mesmo tipo (por exemplo dois PostgreSQL)? Escolhes o da porta por omissão da configuração do serviço; se nenhum está nela, o primeiro que serve. Dizes qual escolheste e porquê, numa linha, e avanças: não é razão para criar um terceiro nem para parar. Em modo Planear podes perguntar se o utilizador prefere o outro.

**Não** reutilizes, e pergunta, se:
- a porta responde mas é outra coisa (o protocolo não bate);
- a versão é anterior à pedida, ou de outra família;
- faltam as credenciais para criar lá dentro o que é preciso;

Os microserviços ficam fora desta secção: nunca se reutilizam (SKILL, regra 13). Um que já corre não se toca; o do ambiente é um contentor novo noutra porta, e o outro aparece em "A correr, mas não é deste ambiente", para ninguém testar contra ele por engano.

## 4. Escrever num sistema que não é teu

Só acrescentas, só o que o plano lista, só com nomes do projeto, e sempre idempotente:

- `CREATE USER`, `CREATE DATABASE`, `CREATE SCHEMA` só `IF NOT EXISTS` (ou depois de verificares que não existem), com `GRANT` só sobre o que criaste;
- uma base que já existe usa-se como está; um utilizador que já existe fica como está (a palavra-passe também);
- **nunca** `DROP`, `TRUNCATE`, `DELETE`, `ALTER` do que já existia, `FLUSHALL`/`FLUSHDB`, nem apagar tópicos, filas ou realms;
- o plano diz, antes de levantares, **exatamente** o que vais criar dentro de cada sistema reutilizado ("no PostgreSQL que já corre em `localhost:5432`: base `<base>`, esquema `<esquema>`, utilizadores `<migrações>` e `<aplicação>`"), e é isso que fazes, nada mais.

## 5. No mapa e no estado

Cada linha diz a origem:

| Coisa | Origem | Onde |
|---|---|---|
| PostgreSQL | **reutilizado** (contentor `<nome>`) | `localhost:5432` |
| Redis | **novo** (contentor `amb-<nome>-redis`) | `localhost:6379` |
| ms-a | **novo** (contentor `amb-<nome>-ms-a`; o processo que já corria em 8100 fica como está) | `localhost:18101` |
| ms-b | **novo** (contentor `amb-<nome>-ms-b`) | `localhost:18100` |

O que reutilizaste vai para o `estado.md` com a nota "não é meu: não se pára". O que criaste dentro de um sistema reutilizado (uma base, um tópico) também, para o utilizador saber o que lá ficou.
