# Tipo: <nome do tipo>

<!-- Modelo de receita de um tipo de microserviço. Copia para receitas-ambiente/tipos/<tipo>.md e preenche.
     O que está entre <> é uma variável; <nome> é sempre o nome do ambiente.
     A skill acrescenta sempre o nome amb-<nome>-..., as etiquetas, a rede, a publicação das portas do mapa em
     127.0.0.1 e --pull never: não precisas de os escrever aqui.
     Ficheiros começados por _ são modelos: a skill ignora-os. -->

## Aplica-se a
- Repositórios: `<prefixo>-*`          (padrão do nome da pasta; ou uma lista)
- Como confirmar: <o que o distingue, ex.: um só pom.xml na raiz; módulo `*-aplicacao`>

## Variáveis
| Variável | De onde vem o valor |
|---|---|
| `<repo>` | nome da pasta do repositório |
| `<config>` | `<caminho do application.yaml>` |
| `<porta>` | valor por omissão de `<CHAVE>` em `<config>` |
| `<porta-gestao>` | valor por omissão de `<CHAVE>` em `<config>` |
| `<jar>` | `<caminho do jar depois de construir>` |

## Dependências
Como encontrar os serviços de apoio e os microserviços que este chama:

| Se encontrares | Precisa de | Receita |
|---|---|---|
| <variável, chave ou módulo> | <sistema> | `servicos/<sistema>.md` |
| `<VAR>_BASE_URL` | o microserviço `<regra para o nome do repositório>` | a do tipo dele |

## Construir
```bash
cd <repo> && <comando de construção, sem testes>
```

## Imagem
`<imagem Java>` (a do `<Dockerfile>` do repositório)

## Arrancar
Porta(s) dentro do contentor: `<porta>`, `<porta-gestao>`

Comando: `java -jar /app/app.jar`

Variáveis a passar (além das que as receitas das dependências dão):

| Variável do microserviço | Valor |
|---|---|
| `<VAR>` | `<valor ou variável>` |

## Pronto quando
- `GET http://localhost:<porta-gestao-do-mapa>/<health>` responde `UP`
- Pedido só de leitura: `GET http://localhost:<porta-do-mapa>/<caminho>`

## Notas
<ordem de arranque, cuidados, o que costuma falhar>
