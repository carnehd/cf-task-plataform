# Checklists por tipo de alteração

Para a análise (o que procurar) e para a implementação (o que não esquecer). O que o repositório já faz, por regra ou por hábito, manda mais do que esta lista.

## Antes de tudo, em cada repositório

- Regras: `.guidelines/`, `ARQUITETURA.md`, `CONTRIBUTING.md`, `REGRAS.md`. Num repositório hexagonal: o domínio não importa o Spring nem a persistência; cada adaptador implementa **uma** porta e é um módulo ou pacote seu; nenhum adaptador depende de outro adaptador.
- Uma alteração parecida que já exista (o último campo, a última migração, o último cliente): copia-lhe a forma.
- Estado do repositório: `git status --short`, ramo atual, e se há um processo a correr a partir da pasta (`ps` com `target/classes` no comando).

## Campo novo num pedido REST

- DTO de entrada (validação de formato), objeto de domínio (regras de negócio e normalização), mapeamentos, DTO de saída.
- O que é obrigatório depende do tipo? Então a regra vive no domínio, e o DTO só valida o que é universal.
- Todas as violações devolvidas de uma vez; mensagens no idioma do projeto, as que já existem como modelo.
- O campo novo aparece nos contratos: OpenAPI/Swagger, coleção Bruno ou Postman, exemplos na documentação.
- `toString`, logs e *payloads* registados: dados pessoais mascarados; atualiza a lista de chaves sensíveis do filtro de logs, se houver.
- Compatibilidade: um campo novo **obrigatório** parte os clientes antigos. Se a documentação não o pede de forma explícita, opcional primeiro.
- Quem chama este endpoint? `grep` dos clientes e dos URLs nos outros repositórios.

## Persistência (JPA, Liquibase, Flyway)

- Migração **nova** (número seguinte). Nunca editar uma já aplicada.
- Colunas novas: nulas ou com valor por omissão, para não partir as linhas existentes. Diz o que acontece aos dados antigos (preenchimento).
- Restrições e índices: únicos parciais (por exemplo, ignorando `CANCELADO`), `CHECK` de formato.
- *Rollback* no changeset. `GRANT`s: confirma se o utilizador da aplicação já cobre as colunas.
- Entidade, modelo de domínio, repositório e mapeamentos; consultas novas (`findBy...`) se houver filtros.
- Testa a migração numa base **descartável** (contentor com nome e prefixo próprios, parado no fim). Contra uma base que já existe só com um sim.

## Cliente de outro serviço (adaptador de saída)

- Segue o padrão do repositório (porta no núcleo, adaptador, propriedades `@ConfigurationProperties`, ligação ao arranque).
- Variável nova: valor local por omissão em `application.yaml` **e** no ficheiro de configuração do cluster (`configmap`, `values*.yaml`), como o `CONTRIBUTING` mandar.
- Falhas: o que é erro do pedido, o que é indisponibilidade, o que se desfaz (compensação) e o que só gera aviso. Tempos limite.
- O corpo do pedido e da resposta como o outro serviço os espera: confirma no contrato dele ou no código dele, não de memória. Pedidos *chunked* sem `Content-Length` existem: um servidor falso de teste tem de os ler.

## Atributos no Keycloak

- Num realm com perfil de utilizador declarativo, um atributo que não está declarado é **descartado em silêncio** (sem `unmanagedAttributePolicy`). Declara-o no perfil: nome, nome a mostrar, `permissions` (só `admin`), `multivalued`, validadores.
- O realm do ficheiro (`realm-*.json`) só é importado se o realm ainda não existe: num Keycloak local já criado, aplica-se pela API de administração.
- Depois de criar a conta, lê-a e confirma que os atributos lá estão; se faltam, é uma falha, não um sucesso incompleto.
- Nada disto entra em tokens (sem *mappers*). Os outros realms mudam pelo processo da plataforma, antes do serviço novo.

## Mensagens e eventos (Pub/Sub, filas)

- Um formato com versão, id do evento, tipo, origem, instante, id de correlação, resultado e dados. Atributos para filtrar. Chave de ordenação.
- Sem dados pessoais em claro; só ids, enumerações e valores mascarados.
- Publicar é *best-effort* e não faz falhar o pedido. A entrega é "pelo menos uma vez": quem consome ignora repetições pelo id.
- Há consumidores do formato antigo? Avisa-os antes de o substituir.
- Teste com o emulador (contentor descartável): publica, lê da subscrição, valida contra o esquema, e confirma que nenhum dado pessoal lá está. Sem credenciais do GCP, o publicador não pode bloquear o pedido.

## SMS e notificações

- O texto vive onde o serviço de notificações o define (templates). Limite de caracteres depois de substituir os valores.
- Só caracteres do alfabeto GSM-7 (sem `ã õ á í ó ú ê ô â ç`): um único fora dele passa o SMS a UCS-2, com 70 caracteres por segmento.
- O código nunca em logs, respostas, auditoria nem eventos.
- Um template por finalidade e idioma, com um de reserva para as finalidades sem texto próprio.

## Configuração e variáveis

- Valor local por omissão no `application.yaml`; o cluster recebe-o por `configmap` e `values`. Variável sem valor por omissão é obrigatória: diz-o.
- Nomes novos no estilo das existentes. Segredos nunca em ficheiros do repositório.

## Dados pessoais

- Números de identificação fiscal ou de documentos, telemóvel, email, datas de nascimento: mascarados em logs e nas respostas de consulta; nunca em eventos nem em atributos de *traces*.
- O mesmo mascaramento em todos os serviços (confirma que os formatos coincidem).

## Entre serviços

- Ordem: quem fornece antes de quem consome; compatível antes do que parte.
- Um chamador que não envia o campo novo (um serviço de sincronização, por exemplo) tem de continuar a funcionar, ou a documentação diz que não.
- Lista, por serviço, o que o cliente antigo vê quando o novo estiver em produção, e o contrário.

## Construir e testar sem estragar o que corre

- Antes de construir: `ps` com a pasta no comando (`target/classes`). Se há, constrói numa cópia (`rsync -a --exclude target --exclude .git <repo>/ <tmp>/`) com `verify`.
- `install` escreve no `~/.m2`, que outros processos podem estar a usar. Só com um sim.
- Testes de contexto (Spring) arrancam a aplicação: confirma que não precisam de serviços externos nem de credenciais.
- Falha antiga: corre o teste **antes** de alterar, para saber se já falhava.
- Verificação de ponta a ponta: servidores falsos em portas livres, ou contentores descartáveis, com nomes que não colidem com os do utilizador; paras o que arrancaste.
