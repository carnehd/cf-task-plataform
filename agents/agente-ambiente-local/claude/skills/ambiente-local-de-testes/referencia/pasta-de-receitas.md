# A pasta de receitas do projeto

Esta skill não traz receitas de nenhum projeto. Como se levanta cada **tipo de microserviço** e cada **serviço de apoio** (base de dados, cache, mensagens, identidade, correio...) está numa pasta do projeto, mantida pela equipa: um ficheiro por tipo e um por serviço. Lês essa pasta em cada ambiente; não sabes as receitas de cor, não as copias para o relatório e não as inventas.

## 1. Onde está

Procuras por esta ordem, e paras na primeira que existir:

1. A pasta que o pedido indica, ou que os documentos da tarefa indicam ("receitas em ...").
2. A variável de ambiente `RECEITAS_AMBIENTE` (`echo "$RECEITAS_AMBIENTE"`).
3. `receitas-ambiente/` na pasta que contém os repositórios (a raiz dos microserviços).

Se nenhuma existe, não a adivinhas nem procuras pelo disco: dizes no plano "não encontrei a pasta de receitas; uso o método geral" e, na pergunta do fim do plano, perguntas onde está.

## 2. O que lá está

Ficheiros de texto (normalmente `.md`), em subpastas ou não, e às vezes um índice (`README.md`, `INDICE.md`). Lê primeiro o índice, se houver; depois a lista dos ficheiros (`find <pasta> -type f`), e só os que vais usar. Os ficheiros cujo nome começa por `_` (`_modelo.md`) são modelos para quem escreve receitas: ignora-os.

Cada receita diz **a que se aplica**:

- uma receita de **tipo de microserviço** diz que microserviços cobre (um padrão do nome do repositório, uma lista, ou a característica que os identifica);
- uma receita de **serviço** diz que sistema levanta (PostgreSQL, Redis, emulador Pub/Sub, Keycloak, correio de teste...).

E o resto do que precisas para a seguir: as **variáveis** (nome e de onde vem o valor), os **passos** (construir, arrancar, criar o que há dentro), como encontrar as **dependências** do microserviço, a **imagem**, e como saber que está **pronto**. O que a receita não disser, procuras como no método geral.

As secções costumam ter estes nomes (a ordem e o resto do texto são livres):

- **tipo de microserviço:** `Aplica-se a`, `Variáveis`, `Dependências`, `Construir`, `Imagem`, `Arrancar`, `Pronto quando`, `Notas`;
- **serviço de apoio:** `Aplica-se a`, `Reutilizar o que já corre`, `Imagem e arranque`, `Variáveis`, `Criar lá dentro`, `O que dar ao microserviço`, `Pronto quando`, `Notas`.

Nas receitas, `<nome>` é o nome do ambiente e os valores entre `<>` são variáveis; o que a skill acrescenta sempre (o nome `amb-<nome>-...`, as etiquetas, a rede, a publicação das portas do mapa em `127.0.0.1`, `--pull never`) não precisa de estar na receita.

## 3. Escolher a receita

- **Microserviço:** a receita de tipo que se aplica ao nome ou às características dele. Se duas se aplicam, a mais específica (uma lista que o nomeia ganha a um padrão); se continuam duas, perguntas. Se nenhuma se aplica: "sem receita".
- **Sistema de apoio:** depois de saberes que sistemas os microserviços precisam (a receita do tipo pode dizer como os encontrar), a receita de serviço desse sistema. Nenhuma: "sem receita".
- O índice da pasta, se existir e disser qual usar, manda.

## 4. Usar a receita

1. **Preencher as variáveis.** Cada valor vem de onde a receita diz (o nome do repositório, a configuração do microserviço, o mapa de portas...). Um valor tirado da configuração cita o ficheiro e a linha, como sempre (regra 5). Uma variável que não consegues preencher vai para as dúvidas; não a inventas.
2. **Seguir os passos** com as variáveis preenchidas. Com receita, da configuração do microserviço só lês o que ela pede: é isso que torna o levantamento rápido.
3. **As regras da skill estão por cima** de qualquer receita: os nomes `amb-<nome>-...`, as etiquetas `ambiente-local`, a rede `amb-<nome>`, as portas do mapa (só em `127.0.0.1`), `--pull never` e só imagens que já estão no computador, reutilizar os sistemas de apoio que já correm, os microserviços sempre em contentores novos com o jar construído agora, não alterar ficheiros dos projetos, os segredos, nada de testes da tarefa. Se uma receita pede o que uma regra proíbe (descarregar uma imagem, editar um ficheiro, correr um `docker compose up` de tudo, usar um ambiente partilhado), a regra ganha: fazes o que a regra permite e dizes no plano o que não seguiste e porquê.
4. **A pasta de receitas é só de leitura.** Nunca a alteras, nem para corrigir uma receita que esteja errada: dizes ao utilizador o que encontraste.

## 5. Sem receita

Um microserviço ou um sistema sem receita (ou sem pasta) levanta-se pelo método geral (`receitas-de-comandos.md`), lendo a documentação e a configuração como a skill descreve. No plano fica assinalado "sem receita", para a equipa saber que receita falta.

## 6. No plano e no relatório

O plano tem a tabela **Receitas** (`modelo-plano-e-relatorio.md`): a pasta e onde a encontraste; para cada microserviço e cada sistema, a receita usada (o caminho do ficheiro dentro da pasta) e as variáveis preenchidas com a origem de cada valor; ou "sem receita". Não copias o conteúdo das receitas para o plano: citas o ficheiro.
