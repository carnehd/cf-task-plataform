# Serviço: <sistema>

<!-- Modelo de receita de um serviço de apoio (base de dados, cache, mensagens, identidade, correio...).
     Copia para receitas-ambiente/servicos/<sistema>.md e preenche.
     O que está entre <> é uma variável; <nome> é sempre o nome do ambiente.
     A skill acrescenta sempre o nome amb-<nome>-..., as etiquetas, a rede, a publicação das portas do mapa em
     127.0.0.1 e --pull never, e reutiliza um sistema que já corra (se servir) antes de criar um novo.
     Não escrevas palavras-passe reais: diz de onde vem o valor local.
     Ficheiros começados por _ são modelos: a skill ignora-os. -->

## Aplica-se a
- Sistema: <sistema> (aparece como: `<palavras na configuração, ex.: jdbc:postgresql, REDIS_HOST>`)

## Reutilizar o que já corre
Serve um que já corre se: <imagem e versão>, <porta habitual>, <como confirmar o protocolo, ex.: pg_isready>

## Imagem e arranque
(só quando nenhum serve)

| | |
|---|---|
| Imagem | `<imagem:versão>` |
| Porta interna | `<porta>` |
| Variáveis do contentor | `<VAR>` = <de onde vem o valor local> |
| Comando | <vazio = o da imagem> |

## Variáveis
(por cada microserviço que o usa)

| Variável | De onde vem o valor |
|---|---|
| `<base>` | <ex.: nome do repositório> |

## Criar lá dentro
(por cada microserviço; tem de poder correr duas vezes sem erro)

```bash
<comandos ou SQL idempotentes>
```

## O que dar ao microserviço
| Variável do microserviço | Sistema criado pelo ambiente | Sistema que já corria |
|---|---|---|
| `<VAR>` | `amb-<nome>-<sistema>:<porta-interna>` | `host.docker.internal:<porta>` |

## Pronto quando
<comando que confirma, ex.: `pg_isready -U postgres`>

## Notas
<cuidados>
