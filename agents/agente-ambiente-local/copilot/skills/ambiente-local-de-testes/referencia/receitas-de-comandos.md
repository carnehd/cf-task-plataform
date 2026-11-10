# Receitas de comandos (método geral)

**Estas são o método geral.** Um microserviço ou um sistema que tem receita na pasta de receitas do projeto (`pasta-de-receitas.md`) levanta-se pela receita dele; as daqui servem para o que não tem receita, e para o que vale sempre, com ou sem receita: o limite de tempo (1), ver o que está ocupado (2), apagar os contentores `amb-` antes de levantar (5, passo 0), esperar sem `sleep` (6), ver o que corre e parar (7), Windows e Podman (8).

As imagens, versões e valores que o projeto já traz (compose, README, `application.yaml`) mandam sobre estas receitas. Estas servem quando o projeto só diz o que precisa, não como o levantar. `<nome>` é o nome do ambiente; `<porta>` vem sempre do mapa de portas.

## 1. Limite de tempo, em tudo o que pode prender

O `timeout` não existe no macOS, e o `alarm` do Perl não pára um programa em Go (como o `docker`, que ignora o sinal); este atalho funciona nos dois:

```bash
limite() { perl -e '$t=shift; $p=fork; if(!$p){exec @ARGV; exit 127} $SIG{ALRM}=sub{kill "KILL",$p; exit 124}; alarm $t; waitpid $p,0; exit($?>>8)' "$@"; }

limite 8 docker info --format '{{.ServerVersion}}'      # Docker
limite 8 podman info --format '{{.Host.Os}}'            # Podman
# código de saída 124: o motor não responde
```

PowerShell: `$j = Start-Job { docker info }; if (Wait-Job $j -Timeout 8) { Receive-Job $j } else { Stop-Job $j; 'não responde' }`.

Se nenhum motor responde, não arranques nem reinicies o Docker Desktop nem a máquina do Podman: diz ao utilizador. Um disco cheio é causa frequente (`df -k /`; abaixo de 5 GB não se começa). O `curl` leva sempre `-m`.

## 2. Ver o que está ocupado

```bash
lsof -nP -iTCP -sTCP:LISTEN                       # quem escuta (macOS e Linux); `ss -ltnp` no Linux
lsof -nP -iTCP:<porta> -sTCP:LISTEN               # uma porta
limite 15 docker ps --format '{{.Names}}\t{{.Ports}}'   # portas publicadas por contentores
limite 15 docker ps -a --format '{{.Names}}'            # nomes já usados
df -k /                                           # disco livre
```

PowerShell: `Get-NetTCPConnection -State Listen | Select LocalPort,OwningProcess`, `Get-Process -Id <pid>`.

## 3. Sistemas de apoio em contentor (só os que ainda não correm)

Primeiro vês o que já corre (`referencia/reutilizar-o-que-corre.md`) e reutilizas. Esta tabela é só para o que falta.

Nome `amb-<nome>-<sistema>`, etiquetas `ambiente-local=<nome>` e `ambiente-local.sistema=<sistema>`, porta publicada só em `127.0.0.1`. (Quem usa o QuickDeck pode acrescentar `--label git-quick.local-setup=<serviço>` para a app os reconhecer.) Imagem e versão: as do projeto, **desde que já estejam no computador** (`docker images --format '{{.Repository}}:{{.Tag}}'`); a mais parecida que lá esteja (a mesma versão maior) serve, dizendo-o no plano.

Prefixo comum, para abreviar: `E="--pull never --label ambiente-local=<nome>"`. O `--pull never` é obrigatório: só correm imagens que já estão no computador (`docker images`); com Podman é `--pull=never`.

| Sistema | Comando (`docker run -d ...`) | Pronto quando |
|---|---|---|
| PostgreSQL | `--name amb-<nome>-postgres $E --label ambiente-local.sistema=postgres -p 127.0.0.1:<porta>:5432 -e POSTGRES_PASSWORD=<do projeto, ou perguntada> postgres:<versão>` | `docker exec amb-<nome>-postgres pg_isready -U postgres` |
| Redis | `--name amb-<nome>-redis $E --label ambiente-local.sistema=redis -p 127.0.0.1:<porta>:6379 redis:<versão>` | `docker exec amb-<nome>-redis redis-cli ping` responde `PONG` |
| Emulador Pub/Sub | `--name amb-<nome>-pubsub $E --label ambiente-local.sistema=pubsub -p 127.0.0.1:<porta>:8085 gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators gcloud beta emulators pubsub start --project=<projeto> --host-port=0.0.0.0:8085` | `docker exec amb-<nome>-pubsub curl -sf http://localhost:8085/` responde `Ok` |
| Keycloak | `--name amb-<nome>-keycloak $E --label ambiente-local.sistema=keycloak -p 127.0.0.1:<porta>:8080 -v <pasta-do-realm>:/opt/keycloak/data/import:ro -e KC_BOOTSTRAP_ADMIN_USERNAME=<do projeto> -e KC_BOOTSTRAP_ADMIN_PASSWORD=<do projeto> quay.io/keycloak/keycloak:<versão> start-dev --import-realm` | `curl -fsS -m 5 http://localhost:<porta>/realms/<realm>` |
| Correio simulado | `--name amb-<nome>-mailpit $E --label ambiente-local.sistema=mailpit -p 127.0.0.1:<porta-smtp>:1025 -p 127.0.0.1:<porta-ui>:8025 axllent/mailpit` | `curl -fsS -m 5 http://localhost:<porta-ui>/api/v1/info` |
| Observabilidade (só se pedida) | `--name amb-<nome>-lgtm $E --label ambiente-local.sistema=lgtm -p 127.0.0.1:<porta>:3000 -p 127.0.0.1:<porta-otlp-grpc>:4317 -p 127.0.0.1:<porta-otlp-http>:4318 grafana/otel-lgtm` | `docker exec amb-<nome>-lgtm sh -c 'test -f /tmp/ready'` |

Palavras-passe e administradores: os que o projeto dá para uso local; senão, **pergunta**. Nunca os escrevas no relatório, nem num comando que mostres (usa uma variável do shell que já os tenha, ou diz só "do `docker-compose.yaml:12`").

Compose, só quando o projeto o pede e o ficheiro não fixa portas que colidam: `docker compose -f <ficheiro> -p amb-<nome> up -d --pull never --wait <serviço>`. Um serviço com `profiles:` só sobe com `--profile`.

## 4. Criar o que há dentro dos sistemas

Sem escrever ficheiros: o SQL vai por *stdin*, ou lê-se do repositório (sem o copiar nem o editar). Funciona igual num contentor novo e num que já corria (`<c>` é o contentor do PostgreSQL, o teu ou o que já existia).

**PostgreSQL** (idempotente, só acrescenta):

```bash
docker exec -i <c> psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
-- utilizadores: se já existem, ficam como estão (a palavra-passe também)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '<utilizador-migracoes>') THEN
    CREATE USER "<utilizador-migracoes>" WITH PASSWORD '<valor local definido pelo projeto>';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '<utilizador-aplicacao>') THEN
    CREATE USER "<utilizador-aplicacao>" WITH PASSWORD '<valor local definido pelo projeto>';
  END IF;
END $$;
SELECT 'CREATE DATABASE "<base>" OWNER "<utilizador-migracoes>"' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '<base>') \gexec
\connect "<base>"
CREATE SCHEMA IF NOT EXISTS "<esquema>";
GRANT ALL PRIVILEGES ON SCHEMA "<esquema>" TO "<utilizador-migracoes>";
GRANT USAGE ON SCHEMA "<esquema>" TO "<utilizador-aplicacao>";
ALTER DEFAULT PRIVILEGES FOR ROLE "<utilizador-migracoes>" IN SCHEMA "<esquema>" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "<utilizador-aplicacao>";
ALTER DEFAULT PRIVILEGES FOR ROLE "<utilizador-migracoes>" IN SCHEMA "<esquema>" GRANT USAGE, SELECT ON SEQUENCES TO "<utilizador-aplicacao>";
SQL
```

Se o projeto tem um script de inicialização que já faz isto, lê-o do repositório: `docker exec -i <c> psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < <repo>/docker/init...sql`. Antes, confirma que o que ele cria ainda não existe (num sistema que já corria, um `CREATE USER` repetido falha): se existe, não o corras. Num contentor **novo**, podes dar o script ao próprio contentor, como volume só de leitura: `-v <repo>/docker/init...sql:/docker-entrypoint-initdb.d/init.sql:ro`. Os nomes de base, esquema e utilizadores vêm desse script e da configuração do serviço. Se o projeto usa um só utilizador, ignora o segundo.

Confirma: `docker exec <c> psql -U postgres -Atc "select datname from pg_database where datname='<base>'"`.

**Pub/Sub** (o emulador começa vazio; um tópico que já existe devolve conflito, que não é erro):

```bash
docker exec <c> curl -sf -X PUT http://localhost:8085/v1/projects/<projeto>/topics/<tópico>
docker exec <c> curl -sf -X PUT -H 'Content-Type: application/json' -d '{"topic":"projects/<projeto>/topics/<tópico>"}' http://localhost:8085/v1/projects/<projeto>/subscriptions/<subscrição>
docker exec <c> curl -sf http://localhost:8085/v1/projects/<projeto>/topics        # confirmar
```

Os serviços recebem `PUBSUB_EMULATOR_HOST=localhost:<porta>` e o projeto (a variável que a configuração chamar).

**Keycloak:** o `--import-realm` só importa um realm que ainda não existe. Confirma com `GET /realms/<realm>`; um `404` depois de arrancar quer dizer que o ficheiro não foi lido (pasta errada, JSON inválido): lê o registo do contentor.

## 5. Microserviços: sempre contentores novos

Cada microserviço do plano corre num contentor **novo**, com o prefixo `amb-<nome>-`, e com o jar **construído agora**. Não se descarrega nada e não se altera nenhum ficheiro do projeto: constrói-se o jar no computador e corre-se numa imagem Java que já cá está.

**Nunca se aproveita um microserviço que já corre** (um processo, um contentor de outra pessoa, ou um `amb-` de antes), mesmo que responda ao `health`: o código dele pode não ser o de agora. O que corre do mesmo serviço e não é deste ambiente fica como está; o teu vai para outra porta e avisas no fim.

**0. Antes de levantar, apagar os contentores `amb-`** (SKILL, regra 15): todos os que têm o nome a começar por `amb-` **e** a etiqueta `ambiente-local`, de qualquer ambiente, microserviços e sistemas de apoio. Primeiro vês quais (vão para o plano), depois apagas, e por fim as redes `amb-…` que ficaram vazias:

```bash
limite 15 docker ps -a --filter label=ambiente-local --format '{{.ID}} {{.Names}} {{.Status}}' | awk '$2 ~ /^amb-/'      # os que vais apagar
limite 15 docker ps -a --format '{{.Names}} {{.Label "ambiente-local"}}' | awk '$1 ~ /^amb-/ && NF == 1'         # prefixo sem etiqueta: não são teus, ficam
ids=$(limite 15 docker ps -a --filter label=ambiente-local --format '{{.ID}} {{.Names}}' | awk '$2 ~ /^amb-/ {print $1}')
[ -n "$ids" ] && limite 60 docker rm -f $ids
for n in $(limite 15 docker network ls --filter label=ambiente-local --format '{{.Name}}' | grep '^amb-'); do limite 15 docker network rm "$n" 2>/dev/null; done   # uma rede ainda em uso recusa: fica
```

Os volumes desses contentores não se apagam (nada de `-v` nem `prune`); os dados que criaste noutros sistemas (uma base no PostgreSQL do utilizador) também ficam.

**1. A imagem Java.** A da fase final do `Dockerfile` do projeto (`FROM eclipse-temurin:21-jre`, por exemplo), se está no computador; senão, uma da mesma versão do Java do projeto (`<java.version>` do `pom.xml`, `toolchain` do Gradle) que esteja:

```bash
grep -h '^FROM' <repo>/Dockerfile                       # que imagem usa o projeto para correr
limite 15 docker images --format '{{.Repository}}:{{.Tag}}' | grep -Ei 'temurin|openjdk|corretto|jre|jdk'
limite 15 docker image inspect <imagem> --format '{{.Id}}'   # está cá?
```

Nenhuma da versão certa: paras e perguntas (descarregar com autorização, ou o utilizador prefere o serviço como processo). **Não construas pelo `Dockerfile`** se a fase de construção usa uma imagem que não está cá ou descarrega dependências (`mvn dependency:go-offline`): falhava atrás de um *proxy*. Diz-lo no plano numa linha.

**2. Construir o jar, e copiá-lo para a pasta de estado:**

```bash
cd <repo> && ./mvnw -q -o -DskipTests package           # -o: só com o que a cache já tem; sem ele se faltar alguma coisa (e dizes)
D=<repo>/target/ambiente-<nome>; mkdir -p $D
cp <módulo>/target/<nome>.jar $D/<serviço>.jar          # o contentor corre esta cópia: uma construção seguinte não lhe mexe
git -C <repo> rev-parse --short HEAD                    # o commit, para a etiqueta
git -C <repo> status --porcelain | head -1              # alguma coisa? então é "commit + alterações por guardar"
date -u +%Y-%m-%dT%H:%M:%SZ                             # quando foi construído, para a etiqueta
```

**3. A rede do ambiente** (uma vez):

```bash
limite 15 docker network inspect amb-<nome> >/dev/null 2>&1 || limite 15 docker network create --label ambiente-local=<nome> amb-<nome>
```

**4. Arrancar.** A porta de dentro é a que a configuração do serviço usa por omissão (não precisas de a mudar); a do computador é a do mapa. As variáveis são as que a **configuração do projeto** declara:

```bash
limite 60 docker run -d --pull never --name amb-<nome>-<serviço> --network amb-<nome> \
  --label ambiente-local=<nome> --label ambiente-local.servico=<serviço> \
  --label ambiente-local.ramo=<ramo> --label ambiente-local.commit=<commit> --label ambiente-local.construido=<data> \
  -p 127.0.0.1:<porta-http-do-mapa>:<porta-http-interna> -p 127.0.0.1:<porta-gestão-do-mapa>:<porta-gestão-interna> \
  -v <repo>/target/ambiente-<nome>/<serviço>.jar:/app/app.jar:ro \
  -e <VAR_LIGACAO_BD>=jdbc:postgresql://host.docker.internal:<porta-bd>/<base> \
  -e <VAR_ENDERECO_OUTRO_SERVICO>=http://amb-<nome>-<outro>:<porta-interna-do-outro> \
  -e <VAR_ENDERECO_SERVICO_DO_COMPUTADOR>=http://host.docker.internal:<porta> \
  -e PUBSUB_EMULATOR_HOST=host.docker.internal:<porta-pubsub> \
  <imagem-java> java -jar /app/app.jar
```

- Um sistema de apoio que **tu** criaste na mesma rede chama-se pelo nome (`amb-<nome>-postgres:5432`). Um que já corria (contentor do utilizador, ou no computador) chama-se por `host.docker.internal:<porta publicada>`. Nunca `localhost` dentro de um contentor: é o próprio contentor.
- Linux com Docker: acrescenta `--add-host=host.docker.internal:host-gateway`. Podman: `host.containers.internal` e `--pull=never`.
- **Identidade:** quem pede o token (os testes, no computador) e quem o valida (o serviço, no contentor) têm de ver o mesmo emissor. Dá ao serviço o emissor como os testes o vêem (`http://localhost:<porta>/realms/<realm>`) e o endereço das chaves por `host.docker.internal`, pelas variáveis que a configuração tiver. Se a configuração não separa os dois, assinala-o: os pedidos autenticados podem falhar com 401.
- Se um valor não se consegue dar por `-e` (a configuração não o deixa), paras e dizes: nunca editas o ficheiro.

**5. Pronto quando** o `health` responde pela porta publicada (secção 6). Se não arranca: `limite 15 docker logs --tail 80 amb-<nome>-<serviço>`.

**Só se o utilizador o pedir por palavras suas**, um serviço como processo no computador: `nohup java -jar ...` com o registo e o PID em `<repo>/target/ambiente-<nome>/` (e `<serviço>.pid-pai` se for `spring-boot:run`); no PowerShell, `Start-Process ... -PassThru`.

## 6. Esperar e verificar (sem `sleep`)

Só prontidão (SKILL, regra 16): `health`, ligações e um pedido **só de leitura** a cada serviço. Nada de `POST` de negócio, nada dos critérios de aceitação, nada de `bru run`, `mvn test` ou `npm test`.

```bash
curl -fsS -m 5 --retry 40 --retry-delay 3 --retry-connrefused http://localhost:<porta-gestão-do-mapa>/actuator/health   # pela porta publicada
docker compose ... up -d --wait <serviço>
docker exec amb-<nome>-postgres pg_isready -U postgres
```

A verificação das ligações: o `health` que a aplicação expõe e que inclui as dependências (base de dados, Redis), ou um pedido simples ao serviço que fala com o outro. O que falha, lê o fim do registo (`limite 15 docker logs --tail 80 amb-<nome>-<serviço>`; num processo, `tail -50 <repo>/target/ambiente-<nome>/<serviço>.log`).

## 7. O que está a correr, e parar (só o que levantaste)

Ver, no fim e em qualquer altura:

```bash
limite 15 docker ps -a --filter label=ambiente-local=<nome> --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
limite 15 docker inspect amb-<nome>-<serviço> --format '{{.State.Status}} {{index .Config.Labels "ambiente-local.commit"}}'
lsof -nP -iTCP -sTCP:LISTEN                                   # também o que não é contentor (e o que não é deste ambiente)
limite 15 docker logs -f --tail 100 amb-<nome>-<serviço>      # o registo de um serviço (o comando que dás no relatório)
```

Parar:

```bash
limite 30 docker ps -q --filter label=ambiente-local=<nome>     # os contentores deste ambiente, pela etiqueta, nunca por nome parecido
limite 60 docker stop $(docker ps -q --filter label=ambiente-local=<nome>)
# um processo que o utilizador te tenha pedido: confirma primeiro que o PID ainda é o teu
ps -p $(cat <repo>/target/ambiente-<nome>/<serviço>.pid) -o command=
kill -TERM $(cat <repo>/target/ambiente-<nome>/<serviço>.pid)
```

**O que reutilizaste não se pára**, nem os contentores nem os serviços que já corriam. `docker stop` mantém os contentores e os dados; só "apaga o ambiente" (palavras do utilizador) leva a `docker rm` dos contentores com a tua etiqueta, `docker network rm amb-<nome>` e às pastas `target/ambiente-<nome>`. O que criaste dentro de um sistema reutilizado (uma base, um tópico) fica, e dizes o que ficou.

## 8. Windows e Podman

- **No Windows**, o Claude Code corre os comandos no Git Bash: as receitas acima funcionam lá, e o `limite` usa o `perl` que vem com o Git. Exceção: o `lsof` não existe. Para ver as portas ocupadas usa `netstat -ano | grep LISTENING` (o último número é o PID) e, para saber que programa é, `tasklist //FI "PID eq <pid>"`. Com o Docker Desktop, `host.docker.internal` funciona sem `--add-host`.
- `podman` no lugar de `docker`; a sintaxe é a mesma (`--pull=never`, `podman network create`). Com Podman, o endereço do computador visto de um contentor é `host.containers.internal`.
- `mvnw.cmd`, caminhos com `\`, e o PowerShell nos equivalentes acima. Atrás de um *proxy* as descargas falhariam; é mais uma razão para só usar o que já está no computador.
