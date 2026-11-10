# Onde procurar, e o que tirar de cada ficheiro

Lê só o que existir. Cada linha do plano cita `ficheiro:linha`. O que o código executa (a configuração da aplicação, o compose) vale mais do que o README quando se contradizem; a divergência vai para as dúvidas.

**Os nomes das chaves, das variáveis e dos ficheiros são os do projeto que tens à frente.** Descobre-os na configuração; nunca assumas os de outro projeto. As chaves abaixo são as convenções comuns (Spring Boot e outras), só para saberes o que procurar.

## Ficheiros

| Onde | O que diz | O que extrair |
|---|---|---|
| A documentação da funcionalidade | Que serviços e sistemas entram, em que ordem, que dados e mensagens | Lista de serviços, contratos, bases, tópicos, mensagens, identidade, ordem de colocação |
| `README*`, documentos de ambiente local, `CONTRIBUTING*`, `docs/` | Os passos oficiais de cada serviço, pré-requisitos, portas | Comandos, versões, o que o autor diz que é preciso |
| `application*.yml`, `.yaml`, `.properties` (ou o equivalente: `.env`, `config/*`, `settings.py`...) | A configuração da aplicação | Tudo o que está na tabela das chaves, abaixo; cada `${NOME:valor}` ou equivalente |
| `docker-compose*.yml`, `compose*.yaml`, `docker/` | Os sistemas de apoio em local | Serviços, imagens e versões, portas (`host:contentor`), variáveis, `healthcheck`, `profiles`, volumes de importação |
| Scripts de inicialização de bases (`init*.sql`, `docker-entrypoint-initdb.d/`, `docker/`) | O que há que criar numa base nova | Nome do esquema, utilizadores (os nomes; as palavras-passe nunca ao relatório), permissões |
| `db/changelog/`, `db/migration/`, `migrations/` | As migrações | Que utilizador as corre, em que esquema; em geral correm no arranque do serviço |
| Ficheiros de realm ou de configuração de um servidor de identidade (`*realm*.json`) | O realm a importar | Nome do realm, clientes, grupos, atributos |
| `.env.example`, `.env.sample`, `env/` | Os nomes das variáveis | Nomes e valores de exemplo; um `.env` real: só os nomes |
| `pom.xml`, `build.gradle`, `package.json`, `requirements.txt`, `go.mod`; `mvnw`, `.sdkmanrc`, `.nvmrc` | A linguagem, a ferramenta e as versões | Como se constrói e se arranca; que módulo é a aplicação |
| `Dockerfile*` | Como corre em contentor | `EXPOSE`, variáveis |
| `k8s/`, `helm/`, `values*.yaml`, `configmap*` | As variáveis que o serviço recebe no cluster | Os **nomes** das variáveis e a forma dos endereços; nunca os valores de ambientes partilhados |
| Coleções de testes de API (`*.http`, Bruno, Postman, `environments/`) | Onde o serviço é chamado nos testes | A variável do endereço base (para dizeres qual o utilizador tem de trocar, sem editar) |
| `scripts/`, `Makefile` | Atalhos já prontos | Comandos de arranque e de preparação |

## Chaves da configuração → que sistema é preciso

| Chave | Sistema | O que perguntar ao ficheiro |
|---|---|---|
| `server.port` | a própria aplicação | porta por omissão, e a variável que a configuração lhe põe |
| `management.server.port` (ou equivalente) | gestão (*actuator*, *health*) | porta por omissão, e se o *health* inclui a base de dados e as outras dependências |
| `spring.datasource.url` (`jdbc:postgresql://`, `jdbc:mysql://`, `jdbc:h2:`), `DATABASE_URL`, `mongodb://` | base de dados | qual, nome da base. `h2` em memória não precisa de nada |
| esquema (`default_schema`, `schema`, uma variável própria), `spring.datasource.username`, `spring.liquibase.user` | esquema e utilizadores | nome do esquema a criar; os nomes dos utilizadores; quem corre as migrações |
| `spring.liquibase.*`, `spring.flyway.*`, `migrations` | migrações no arranque | a base **tem** de existir e responder antes de o serviço arrancar |
| `spring.data.redis.*`, `spring.redis.*`, `REDIS_URL` | Redis | porta, palavra-passe, SSL |
| `spring.cloud.gcp.pubsub.*`, `PUBSUB_EMULATOR_HOST`, e as chaves próprias do projeto com `pubsub`, `topic`, `topico`, `subscription` | Pub/Sub | projeto, nomes dos tópicos e das subscrições; o emulador começa vazio |
| `spring.kafka.*`, `spring.rabbitmq.*`, `amqp://` | Kafka, RabbitMQ | porta, tópicos ou filas |
| `spring.security.oauth2.*.issuer-uri`, `jwk-set-uri`, qualquer chave com `keycloak` ou `oidc` | Keycloak ou outro servidor de identidade | endereço, realm, cliente de serviço; o realm tem de existir |
| qualquer chave com `url`, `base-url`, `host` ou `endpoint` cujo valor por omissão é `localhost:<porta>` ou o nome de outro serviço; `@FeignClient`, clientes REST | **outro microserviço** | quem é (a porta por omissão bate com o `server.port` de que repositório?) → entra no ambiente |
| `spring.mail.*`, SMTP, e chaves com `sms`, `smtp`, `mailer` (incluindo um modo "simulador") | correio e SMS | se há um modo simulado: servidor de correio de teste (Mailpit, MailHog), domínio dos números |
| `s3`, `minio`, `blob`, `elasticsearch`, `opensearch`, `mongodb` | armazenamento, pesquisa | imagem e porta; o que criar (bucket, índice) |
| `otel.*`, `otlp`, `management.otlp.*`, `tracing` | observabilidade | opcional: só se a documentação ou o utilizador a quer |
| chaves que ligam e desligam uma dependência (`enabled`, `ativo`, `ativa`) | dependências opcionais | se desligar evita levantar um serviço que só serve de auditoria ou de *best-effort* |

## Descobrir quem é o serviço que um endereço aponta

1. O nome da variável e o valor por omissão (`http://localhost:<porta>`).
2. Procura, nos repositórios que tens, o que tem esse `server.port` por omissão e o nome parecido (identificador do projeto, nome da aplicação, pasta).
3. Se nenhum bate, pergunta. Não inventes que "deve ser" este.

## Sistemas de apoio sem receita

Para um sistema que não esteja nas receitas (Mongo, MinIO, Elasticsearch...): imagem e versão da configuração do projeto, só se já existe no computador; porta por omissão da imagem; o *healthcheck* do próprio compose; o mesmo plano de portas e a mesma etiqueta.
