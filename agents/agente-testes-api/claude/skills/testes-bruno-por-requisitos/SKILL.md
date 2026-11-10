---
name: testes-bruno-por-requisitos
description: Cria ou atualiza testes automáticos Bruno (.bru) a partir de requisitos funcionais de uma API REST, cruzando o requisito com o contrato OpenAPI/Swagger, o código (validações, regras de negócio, formato de erros) e a coleção Bruno existente. Os testes ficam no microserviço correspondente, numa pasta nova com o identificador do requisito, dentro da coleção Bruno desse microserviço; se ele não tiver coleção, cria-a. Separa o que a documentação diz que é novo, alterado, removido ou mantido, compara o contrato e o código com o ramo base (só a ler) e acrescenta testes de regressão para o que a alteração não devia mudar. Corre a coleção, classifica as falhas e produz uma matriz de cobertura requisito → testes, cada teste ligado à parte da documentação de onde vem. Usa quando houver um requisito novo ou alterado para validar, quando se pedir "cria testes para este requisito", "verifica se o requisito X está implementado", ou "cobre o endpoint Y com testes".
---

# Testes Bruno a partir de requisitos

Objetivo: dado um requisito, garantir que existe um conjunto de pedidos Bruno que prova que o requisito está implementado e a funcionar, e dizer com clareza o que falta.

Princípios:
- O requisito manda. O código e o swagger servem para descobrir como chamar a API e que erros esperar, nunca para decidir o que é correto. Se o código contradiz o requisito, o teste segue o requisito e falha.
- Nunca alterar o código da aplicação para fazer um teste passar. Só se escrevem ficheiros dentro da coleção Bruno do microserviço correspondente (secção 3): a pasta do requisito, o ficheiro de cobertura e, se a coleção não existia, os ficheiros base dela. Sem commits e sem mudar de branch.
- A documentação fornecida é a referência: cada critério e cada teste dizem de que parte do documento vêm (ficheiro e secção, ou uma citação curta). Um teste que não se liga a nenhuma parte da documentação, nem a uma regressão (secção 2c), não se escreve.
- Dois tipos de teste: os que provam as **alterações** que a documentação descreve (o que é novo, o que muda, o que sai) e os de **regressão**, que provam que o que a documentação não muda continua a funcionar.
- Git só para ler: `diff`, `show`, `log`, `merge-base`, `status`. Nunca `checkout`, `stash`, `reset` nem `commit`.
- Cada teste tem de ser repetível: corre duas vezes seguidas e passa as duas.
- Seguir as convenções da coleção que já existe. Só se inventa estrutura quando não há nenhuma.
- Ficheiros de ambiente (`environments/*.bru`), `bruno.json` e pedidos que já existiam não se alteram em silêncio. Se for mesmo preciso mudar um, o relatório diz qual, o que mudou e porquê. Mudar o `baseUrl` para apontar a outra porta nunca é solução: se a app não responde no ambiente indicado, reporta-se.

## 1. Recolher contexto

Faz-se em duas partes. Primeiro os documentos fonte (passos 1 e 2). Depois para-se para validar com o utilizador (secção 1b). Só depois se lê o código e a coleção (passos 3 a 5). A razão: se o entendimento do requisito estiver errado, tudo o que vier a seguir é trabalho perdido, e o código pode contaminar a leitura do requisito.

Lê, por esta ordem, e toma notas curtas:

1. **Requisito**: texto, ficheiro ou ticket indicado. Separa-o em critérios de aceitação verificáveis, um por linha. Se um critério for ambíguo, regista a dúvida e assume a interpretação mais restritiva.
   - **O tipo de cada critério**, pelo que o documento diz:
     - **novo**: não existia (endpoint, campo, regra);
     - **alterado**: existia e muda; regista o antes e o depois ("o nome passa a obrigatório", "o limite passa de 150 para 100");
     - **removido**: deixa de existir (endpoint, campo, valor de um enum, regra);
     - **mantido**: o documento diz que fica igual ("o resto mantém-se", "sem impacto em…", "continua a…").
     Se o documento não diz se algo já existia, o tipo sai da comparação com o ramo base (passo 2); se nem assim se sabe, assume **novo** e regista a dúvida.
   - **A referência**: cada critério leva o sítio do documento de onde vem (`requisito.md §3.2`, ou uma citação curta entre aspas, se o documento não tem secções).
   - **Os exemplos do documento**: pedidos e respostas de exemplo, tabelas de campos, mensagens de erro e códigos anotam-se tal como estão escritos. São os dados e as asserções dos testes (secção 2).
2. **Contrato**: procura OpenAPI/Swagger (`**/*openapi*.{yaml,yml,json}`, `**/*swagger*.{yaml,yml,json}`, `**/api/**/*.y*ml`). Anota paths, métodos, parâmetros, campos obrigatórios, enums, códigos de resposta documentados. Anota também **o que cada endpoint produz e o que consome**: um `POST` que devolve `id` alimenta os `GET /{id}`, `PUT`, `DELETE` do mesmo recurso; um campo de pedido que referencia outro recurso (`clienteId` no corpo, `{encomendaId}` no path) obriga a que esse recurso exista antes.
   - **O contrato antes da alteração.** Descobre o ramo base: o que o pedido ou os documentos indicam; senão o primeiro que existir de `origin/develop`, `origin/main`, `origin/master` (`git rev-parse --verify`). O ponto de partida é `git merge-base HEAD <base>`. Compara o contrato desse ponto com o atual, incluindo o que está por guardar: `git diff <merge-base> -- <ficheiro do contrato>` (ou `git show <merge-base>:<caminho>` para o ler inteiro). Anota cada diferença: endpoint ou campo novo ou removido, tipo mudado, campo que passou a obrigatório, valores de enum a mais ou a menos, código de resposta novo ou que desapareceu.
   - Cada diferença do contrato deve corresponder a um critério do documento. A que não corresponde é uma **alteração não documentada**: vai para as dúvidas (1b), e o que ela pode partir entra nos testes de regressão (2c).
   - Sem git, sem ramo base, ou com o contrato gerado a partir do código (sem ficheiro no repositório): diz-o, e a comparação faz-se só no passo 3, pelo código.
**Para aqui. Valida com o utilizador antes de continuar (secção 1b).**

3. **Código**: controladores ou handlers do endpoint em causa, classes de domínio e validadores, o handler global de erros (para saber o formato do corpo de erro e o mapeamento exceção → código HTTP), e as propriedades de configuração que afetam o comportamento (chaves de API, limites, tamanhos). Procura em especial **pré-condições de estado**: regras do tipo "só se o recurso X estiver no estado Y", "só se o cliente estiver ativo", "só se houver saldo ou quantidade disponível", transições de estado permitidas, e efeitos colaterais de uma operação sobre outro recurso (criar um pedido altera o estado do artigo; cancelar repõe a quantidade). Cada uma destas regras é uma dependência entre pedidos.
   - **O que mudou no código face ao ramo base**: `git diff --stat <merge-base>` (inclui o que está por guardar) e `git status --short` (ficheiros novos ainda fora do git); depois o diff dos ficheiros que interessam: controladores, DTOs e pedidos, validadores, serviços, repositórios e queries, migrações, configuração, handler de erros.
   - **A zona de impacto**: para cada classe ou método alterado, procura quem o usa (`grep` pelo nome) até chegares a um controlador. Os endpoints a que chegas são os que a alteração pode partir.
   - **O cruzamento com a documentação**, nos dois sentidos:
     - critério sem nenhuma alteração correspondente no código: provavelmente não implementado (o teste confirma-o);
     - alteração no código sem critério que a explique: **alteração não documentada**; regista-a (ficheiro e linha) e cobre o que ela pode partir com testes de regressão (2c).
4. **Coleção Bruno existente**: `bruno.json`, `environments/*.bru`, estrutura de pastas, numeração `seq`, nomes, como encadeiam variáveis, como limpam dados, se há `script:pre-request` para dados únicos. Lê `referencia/sintaxe-bruno.md` se precisares da sintaxe.
5. **Como correr a aplicação**: `README`, `AMBIENTE_LOCAL.md`, `docker-compose`, portas. Confirma se está a correr com um pedido simples ao endpoint de saúde ou à raiz da API.

## 1b. Validar os requisitos com o utilizador

Depois de ler o requisito e o contrato, e **antes de abrir qualquer ficheiro de código ou escrever qualquer teste**, apresenta ao utilizador o que entendeste e pede confirmação. Esta paragem é obrigatória, salvo se o pedido inicial disser explicitamente para avançar sem validar.

O que apresentar, curto e numerado:
1. **Requisitos e critérios encontrados**: a lista de critérios de aceitação derivados, com o identificador que lhes vais dar (`R7-1.1`, `R7-1.2`, …), uma linha cada, com o tipo (novo, alterado com o antes e o depois, removido, mantido) e a referência do documento. É esta numeração que vai aparecer na matriz e nos ficheiros, por isso o utilizador tem de a ver agora.
2. **Endpoints envolvidos**, tal como o contrato os descreve, e **as diferenças do contrato face ao ramo base** (qual é a base), cada uma com o critério que a explica; as que nenhum critério explica, marcadas como "não documentada".
3. **Dúvidas e assunções**: o que o requisito não diz e a leitura que vais assumir se o utilizador não responder; as alterações não documentadas do contrato ("é intencional?"); os critérios cujo tipo não ficou claro.
4. **O que ficou de fora**: partes do requisito que não dão teste por API, e porquê.
5. **Onde vão ficar os testes**: o microserviço correspondente, a coleção (`<microserviço>/bruno/`, a que já existe ou a que vais criar) e o nome da pasta nova do requisito (secção 3).

Termina com duas perguntas, exatamente estas:
- "Falta algum requisito ou critério, ou algum está mal entendido?"
- "Posso avançar para o código e para os testes?"

E depois **espera**. Não leias código, não cries ficheiros, não corras nada até teres resposta.

Com a resposta:
- Se o utilizador corrigir ou acrescentar, atualiza a lista, mostra só o que mudou, e volta a perguntar se podes avançar.
- Se disser que sim, segue para os passos 3 a 5 e para a secção 2, usando a lista confirmada como fonte de verdade. Os critérios confirmados não se renumeram.
- Se não houver forma de perguntar (execução não interativa, sem canal de resposta), não assumas o sim: entrega a lista com as dúvidas e assunções, diz que paraste à espera de confirmação, e explica como continuar: repetir o pedido com "lista confirmada, avança" e as correções que quiser.

Quando corres como subagente e não falas diretamente com o utilizador, a paragem faz-se devolvendo a lista ao agente que te chamou, com as duas perguntas, para ele as fazer ao utilizador. Continuas quando te for devolvida a confirmação.

## 2. Derivar os casos de teste

Para cada critério de aceitação, gera casos nesta ordem. Não saltes categorias; se uma não se aplica, diz porquê no ficheiro de cobertura.

| Categoria | O que cobre | Exemplo de asserção |
|---|---|---|
| Caminho feliz | O pedido correto devolve o resultado certo | status, campos do corpo, cabeçalhos |
| Validação de entrada | Cada regra de formato ou obrigatoriedade, nos limites (vazio, mínimo, máximo, máximo + 1, tipo errado) | status 400 e mensagem |
| Regra de negócio | Estados, transições, unicidade, dependências entre recursos | status 409/422 e mensagem |
| Não encontrado | Identificadores inexistentes em cada path param | status 404 |
| Autorização | Cabeçalhos ou tokens obrigatórios em falta ou inválidos | status 401/403 |
| Efeito secundário | O estado mudou de facto: confirmar com um GET a seguir ao POST/PUT/DELETE | corpo do GET |
| Formato de erro | O corpo de erro tem a estrutura definida no projeto | campos presentes e tipos |
| Idempotência e limpeza | Dados únicos por execução; apagar no fim o que se criou | status do DELETE |

Regras para escolher asserções:
- Afirmar o que o requisito diz, não tudo o que a resposta traz. Uma asserção por facto relevante.
- Nunca afirmar valores gerados (ids, datas, tokens) por igualdade; usar `isDefined`, `isNumber`, `matches`.
- Em listas, afirmar a presença do elemento criado no teste, não o tamanho total.
- Mensagens de erro: afirmar com `contains` numa palavra-chave estável, não com a frase inteira.
- **Os exemplos da documentação mandam nas asserções**: nomes de campos, formatos, códigos e mensagens tal como o documento os mostra; os pedidos de exemplo do documento são os dados dos testes (com os valores únicos trocados por variáveis). Se o documento e o contrato divergem, o teste segue o documento e a divergência vai para o relatório.

**O que cada tipo de critério precisa**, além das categorias da tabela:
- **novo**: as categorias da tabela.
- **alterado**: o comportamento novo **e** a prova de que o antigo deixou de valer: o pedido que antes era aceite e agora tem de ser recusado (campo que passou a obrigatório: o pedido sem ele dá 400), o valor no limite antigo (limite de 150 para 100: 101 é recusado), o formato antigo da resposta que já não vem.
- **removido**: a prova de que saiu: o endpoint responde 404 ou 405, o campo já não vem na resposta, o valor de enum é recusado, ou o que o documento disser que acontece agora.
- **mantido**: testes de regressão (2c).

## 2b. Ligar os pedidos: ordem e dados partilhados

Os testes de um requisito raramente são independentes. Antes de escrever ficheiros, desenha a cadeia de pedidos e só depois numeras.

**Como descobrir a ordem**
1. Para cada caso de teste, lista o que ele precisa que exista antes: recursos (um artigo, um cliente), estados (artigo disponível, cliente ativo, pedido aprovado), e valores gerados (ids, tokens, nomes únicos).
2. Para cada pré-condição, identifica o pedido que a produz. Vem de três sítios: o contrato (o `POST` que cria e devolve o `id`), o código (a regra que exige um estado, e a operação que o produz), e o próprio requisito (quando descreve um fluxo: "depois de aprovada, pode ser entregue").
3. Ordena por dependência: produtor antes de consumidor. Se A precisa de B e B precisa de C, a ordem é C, B, A. Se a ordem não for determinável, não a inventes: regista a dúvida e escolhe a mais conservadora (criar tudo primeiro).
4. Para fluxos com estados, a sequência é a máquina de estados do código: um pedido por transição, pela ordem em que as transições são permitidas. Os testes de transição inválida ficam no estado em que são inválidos (testar `criado → entregue` antes de aprovar; testar `aprovado → criado` depois de aprovar).

**Como passar dados entre pedidos**
- O pedido produtor guarda o que os seguintes precisam com `vars:post-response` (`artigoId: res.body.id`, `token: res.body`), com nomes com prefixo do requisito para não colidir com outras pastas (`r7ArtigoId`, não `artigoId`).
- O consumidor usa `{{r7ArtigoId}}` no URL, no corpo ou nos cabeçalhos.
- Nunca copies um id a mão nem assumas valores fixos de sequências. Se um teste precisa de um id inexistente, usa um valor impossível (`999999999`), não um que "provavelmente" não existe.
- Um valor que vem da resposta e muda em cada execução (token, data, id) só se afirma por forma, nunca por igualdade.

**Como organizar a cadeia na pasta**
- Primeiros ficheiros: preparação, um por recurso base, por ordem de dependência (cliente → artigo → pedido). O nome diz que é preparação: `01-prep-criar-cliente.bru`.
- A seguir, os casos de teste pela ordem da cadeia. Casos que não mudam estado (GET, validações 400, 404) podem ir em qualquer ponto depois da preparação; casos que mudam estado (PATCH, DELETE, operações com efeito colateral) ficam onde o estado está certo e **depois** dos casos que precisavam do estado anterior.
- Depois de cada operação com efeito colateral noutro recurso, um `GET` que confirma o efeito (criar pedido → `GET` do artigo mostra o estado reservado e a quantidade a menos).
- Últimos ficheiros: limpeza pela ordem inversa da criação (pedidos antes de artigos, artigos antes de clientes), porque as regras de integridade costumam impedir apagar o pai com filhos vivos. Se um recurso não puder ser apagado por desenho (histórico), diz no relatório.
- Se a cadeia for longa, parte-a em subpastas dentro da pasta do requisito (`REQ-7/1-artigos/`, `REQ-7/2-pedidos/`, `REQ-7/3-clientes/`), numeradas de forma a correrem pela ordem certa, cada uma com a sua preparação. A ordem entre subpastas é alfabética, por isso o prefixo numérico é obrigatório quando uma depende da outra. Para correr só um requisito: `bru run REQ-7 --env <ambiente>`.

**Regista a cadeia**
No `COBERTURA.md`, uma secção "Cadeia de pedidos" com a ordem e, por pedido, o que produz e o que consome. Exemplo:

```
01-prep-criar-cliente        produz r7Cliente
02-prep-ativar-cliente       consome r7Cliente              estado: ativo
03-prep-criar-artigo         produz r7ArtigoId              estado: disponível, quantidade 3
04-criar-pedido              consome r7ArtigoId, r7Cliente  produz r7PedidoId; efeito: artigo reservado, quantidade 1
05-get-artigo-reservado      consome r7ArtigoId             confirma o efeito de 04
06-aprovar-pedido            consome r7PedidoId             estado: aprovado
...
```

Com isto, quem ler a pasta percebe porque é que o `seq` é o que é, e o próximo requisito reutiliza a preparação em vez de a repetir.

## 2c. Testes de regressão

O que tem de continuar a funcionar vem de três sítios:
- os critérios **mantido** do documento;
- os endpoints da **zona de impacto** (passo 3) que a documentação não muda;
- o que o **contrato do ramo base** garantia e nenhum critério altera, sobretudo onde há alterações não documentadas.

Para cada um:
1. **Procura na coleção os testes que já o cobrem.** Se existem, são esses: não se duplicam. Ficam a constar da matriz como cobertura de regressão, e correm na execução (secção 4).
2. **Se não há nenhum, cria testes mínimos de regressão**: o caminho feliz e a forma da resposta (código, campos obrigatórios e tipos), tirados do **contrato do ramo base**, ou seja, do que era garantido antes, e não do código atual, que pode já ter partido. Um pedido por endpoint e método, e mais um por cada regra que o diff tocou sem a documentação a mudar (uma validação que mudou de sítio, uma query reescrita).
3. Ficam na pasta do requisito, depois dos testes das alterações e antes da limpeza, com nome `NN-regressao-<o que verifica>.bru` e com identificadores que continuam os do requisito: `R7-REG-1`, `R7-REG-2`. Usam a preparação da cadeia (2b) em vez de criar dados à parte.

Um teste de regressão afirma pouco e certo: o que o contrato da base garante e nada que a documentação mude. Uma regressão que falha nunca se "corrige" mexendo no teste: é a classificação 2 (secção 4), com a diferença face ao contrato da base e a linha do diff que a explica.

## 3. Escrever os ficheiros .bru

### Onde ficam: na coleção Bruno do microserviço correspondente

- **O microserviço correspondente** é o que serve o endpoint que o requisito descreve (pelo contrato e pelo código; se te deram uma lista de microserviços escolhidos, está lá). Se o requisito mexe em endpoints de mais do que um microserviço, cada um recebe os testes dos seus endpoints, na sua coleção, cada um com a sua pasta do requisito. Um pedido direto a outro microserviço só para confirmar um efeito (um `GET` ao serviço de dados depois do `POST` no de entrada) fica na pasta de quem o precisa, com o endereço desse outro serviço numa variável própria (`srUrl`), declarada no primeiro pedido da pasta (`vars:pre-request`, com o valor local por omissão) e que se pode trocar ao correr (`--env-var srUrl=...`).
- **A coleção** é a pasta do microserviço onde está o `bruno.json` (`find <microserviço> -name bruno.json -not -path '*/node_modules/*' -not -path '*/target/*'`; em geral `<microserviço>/bruno/`). Se houver mais do que uma, a que já tem pedidos desse endpoint; dizes qual escolheste.
- **Dentro dela, uma pasta nova para o requisito**, na raiz da coleção, com as regras abaixo. Os pedidos e os ambientes que já existiam na coleção ficam como estão, salvo os que o requisito partiu.
- **Se o microserviço não tiver coleção, crias uma** em `<microserviço>/bruno/`, só com o mínimo: `bruno.json` (`{ "version": "1", "name": "<microserviço>", "type": "collection" }`), `environments/local.bru` com o `baseUrl` da porta por omissão do serviço (a do `application.yaml`, `server.port`, ou a do `README`) e a pasta do requisito. O relatório diz que a criaste e onde.
- **O resultado da execução** (`--reporter-json`) não fica no repositório: vai para a pasta de resultados que te derem (dentro de uma plataforma) ou para a pasta de construção do microserviço, que o git ignora (`target/`, `build/`).
- **Sem commits nem mudanças de branch**: os ficheiros novos ficam por guardar no ramo em que o microserviço está, e o relatório lista-os.

### Como se escrevem

- **Uma pasta por requisito, na raiz da coleção, com o identificador do requisito como nome**: `REQ-7/`, `US-123/`, `JIRA-4512/`, tal como o requisito é conhecido no projeto, em minúsculas se a coleção já usar minúsculas. Todos os pedidos desse requisito ficam lá dentro: preparação, casos de teste, confirmações de efeito e limpeza. Nada do requisito fica espalhado por outras pastas.
- Se o requisito não tiver identificador, usa-se um nome curto derivado do título (`req-precos-e-stock`) e diz-se no relatório qual se escolheu.
- Se já existir uma pasta com esse nome, é o mesmo requisito a ser revisto: atualizam-se os pedidos que lá estão em vez de criar uma pasta nova. Pedidos que deixaram de fazer sentido com a nova versão do requisito apagam-se e o relatório lista-os.
- Dentro da pasta, ficheiros numerados `NN-nome.bru` com `seq` igual ao número, pela ordem da cadeia definida em 2b, porque o Bruno corre por `seq` dentro da pasta e as pastas por ordem alfabética.
- Pedidos de outras pastas que o requisito partiu (por exemplo, um campo que passou a ser obrigatório) corrigem-se no sítio onde estão, com a alteração mínima, e o relatório lista cada um. Não se copiam para a pasta do requisito. Só se corrige um pedido antigo quando um critério **alterado** ou **removido** o explica, e o `docs` desse pedido passa a citar o critério. Sem critério que o explique, a falha é uma regressão: o pedido fica como está e a falha vai para o relatório.
- Os primeiros pedidos da pasta são a preparação: criam os dados base pela ordem de dependência e guardam ids em variáveis com `vars:post-response`. Dados únicos por execução com `script:pre-request` e `Date.now().toString(36)`, definidos no primeiro pedido da pasta.
- Últimos pedidos da pasta limpam o que foi criado.
- Nome do ficheiro e `meta.name` dizem o que se testa: `03-criar-sem-email-400.bru`, não `03-teste3.bru`.
- Cabeçalhos com hífen não funcionam em `assert`; usar o bloco `tests` com `res.getHeader("nome")`.
- Ficheiros para upload ficam numa pasta da coleção e referenciam-se com caminho relativo à raiz da coleção.
- Um docs block curto em cada ficheiro liga o teste ao critério e à documentação: `docs { Critério R3.2 (alterado): o nome passa a obrigatório · Doc: requisito.md §3.2 }`; num teste de regressão, `docs { Regressão R3-REG-1: a listagem continua a devolver id, nome e estado · Origem: diff em ClienteRepository.java }`.

Antes de correr, valida a sintaxe lendo cada ficheiro novo uma vez. Erros comuns: `seq` repetido, chaveta por fechar, `body: json` sem bloco `body:json`, variável usada antes de ser definida.

## 4. Correr e classificar

```bash
cd <microserviço>/bruno && bru run <REQ-ID> --env <ambiente> --reporter-json <pasta de resultados>/resultados.json
```
Se a CLI não estiver instalada: `npx -y @usebruno/cli@2 run --env <ambiente>`. Se só interessa uma pasta: `bru run <pasta> --env <ambiente>`.

Se na secção 2c contaste com testes que já existiam noutras pastas para a regressão, corre também essas pastas (`bru run <pasta> --env <ambiente>`), com o resultado num ficheiro à parte.

Se a aplicação não estiver a correr, não a arranques às escondidas: diz como arrancar e para onde apontar o ambiente, e deixa os testes prontos.

Para cada falha, decide uma de três classificações e justifica com o que viste no código:
1. **Requisito não implementado**: o código não tem a validação ou regra. O teste fica, a falhar, e aparece na matriz como "em falta".
2. **Implementação diverge do requisito**: existe, mas com outro código HTTP, outra mensagem ou outra regra. O teste fica a seguir o requisito; a divergência vai para o relatório com a linha de código. Uma **regressão** que falha (2c) é sempre esta classificação: o que o contrato da base garantia e a documentação não mudou deixou de acontecer; o relatório diz o que era, o que é agora e a linha do diff que o explica.
3. **Teste errado**: pedido mal construído, variável não definida, dados que colidem. Corrige o teste e volta a correr.

Nunca "afrouxes" uma asserção para passar sem a justificares como classificação 3.

## 5. Registar cobertura

Cria ou atualiza `COBERTURA.md` na raiz da coleção do microserviço (uma por coleção, se o requisito tiver testes em mais do que um microserviço), com o modelo em `referencia/modelo-cobertura.md`. Tem obrigatoriamente estas partes:

1. **Matriz requisito → testes.** Uma linha por critério de aceitação e por regressão, com o identificador do requisito (`R7-1.1`, `US-123-3`, `R7-REG-1`), o tipo (novo, alterado, removido, mantido, regressão), o critério em texto, a referência do documento (numa regressão, a origem: o critério mantido, o ficheiro do diff ou o contrato da base), os testes que o cobrem, o estado (✅ coberto e a passar, ❌ coberto e a falhar, ⬜ em falta, ➖ não testável por API) e a observação. Cada teste é um **link para o ficheiro**, com o nome completo e caminho relativo à raiz da coleção: `[REQ-7/1-pet/06-criar-sem-price-400](REQ-7/1-pet/06-criar-sem-price-400.bru)`. Nunca abreviaturas como `06` ou `43 a 46`: quem lê tem de poder clicar e abrir o teste.
2. **Índice inverso teste → requisito.** Uma tabela por pasta ou subpasta do requisito, com todos os ficheiros `.bru` dessa pasta, o critério que cada um cobre e uma frase do que verifica. Preparação e limpeza marcam-se como "preparação da cadeia" e "limpeza da cadeia". Um teste sem critério é um erro: ou se lhe atribui o critério ou se justifica.
3. **Cadeia de pedidos.** A ordem de execução e os dados que passam entre pedidos, como em 2b.
4. **Dúvidas e divergências.**
5. **Alterações face ao ramo base.** A base usada; cada diferença do contrato e cada alteração relevante do código, com o critério que a explica ou "não documentada" (e a regressão que a cobre); e os critérios sem alteração no código.

Para a ligação ser verificável, cada ficheiro `.bru` leva no bloco `docs` o código do critério que cobre, no formato `Critério <ID> (<tipo>): <frase> · Doc: <documento §secção>`, os de regressão `Regressão <ID>: <frase> · Origem: <de onde vem>`, e os de preparação `Preparação para <ID>: ...`. O índice inverso lê-se daí, não de memória. No fim, confirma que cada link da matriz aponta para um ficheiro que existe e que cada ficheiro da pasta aparece no índice inverso.

## 6. Relatório final

Responde com, por esta ordem:
1. Lista dos critérios de aceitação derivados, com o tipo e a referência do documento, e as dúvidas assinaladas.
2. Onde ficaram os testes: o microserviço, a coleção (a que existia ou a que criaste) e a pasta do requisito, criada ou atualizada; e os ficheiros criados, alterados ou apagados, incluindo os de outras pastas que foi preciso corrigir.
3. Resultado da execução: totais, e por cada falha a classificação e a justificação.
4. **Alterações face ao ramo base**: a base usada, as alterações não documentadas (do contrato e do código, com ficheiro e linha) e os critérios sem alteração no código.
5. **Matriz requisito → testes**, completa, não resumida, com as linhas de regressão: para cada requisito e critério encontrado, os testes que o cobrem, com o nome completo do ficheiro, e o estado. É a mesma matriz do `COBERTURA.md`; no relatório pode ir sem os links, mas com os nomes inteiros. Agrupa por requisito quando houver mais do que um.
6. O que fica por fazer e precisa de decisão humana.

Sem floreados. Se tudo passou, diz isso em uma linha e mostra a matriz.
