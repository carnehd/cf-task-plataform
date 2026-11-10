# Sintaxe .bru, o essencial

```
meta {
  name: criar recurso
  type: http
  seq: 1
}

post {
  url: {{baseUrl}}/recursos
  body: json
}

headers {
  Authorization: Bearer {{token}}
  X-Api-Key: {{apiKey}}
}

params:query {
  estado: ativo
}

body:json {
  { "nome": "{{nome}}", "quantidade": 2 }
}

body:form-urlencoded {
  nome: valor
}

body:multipart-form {
  descricao: texto
  ficheiro: @file(ficheiros/exemplo.png)
}

vars:pre-request {
  quantidade: 2
}

vars:post-response {
  recursoId: res.body.id
}

script:pre-request {
  const sufixo = Date.now().toString(36);
  bru.setVar("nome", "teste_" + sufixo);
}

assert {
  res.status: eq 201
  res.body.id: isNumber
  res.body.nome: eq {{nome}}
  res.body.estado: eq ativo
  res.body.itens: length 2
  res.body.mensagem: contains obrigatório
  res.body.data: matches ^\d{4}-\d{2}-\d{2}
}

tests {
  test("cabeçalhos", function() {
    expect(res.getHeader("x-total-count")).to.equal("2");
    expect(res.getBody().id).to.be.a("number");
  });
}

docs {
  Critério R1.2: criar devolve 201 e o id gerado.
}
```

Métodos: `get`, `post`, `put`, `patch`, `delete`, `options`, `head`. O método é o nome do bloco.

Operadores de `assert`: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `contains`, `notContains`, `length`, `matches`, `notMatches`, `startsWith`, `endsWith`, `between`, `isEmpty`, `isNotEmpty`, `isNull`, `isUndefined`, `isDefined`, `isTruthy`, `isFalsy`, `isJson`, `isNumber`, `isString`, `isBoolean`, `isArray`.

Variáveis: `{{nome}}` em qualquer campo. Vêm do ambiente (`environments/<nome>.bru`, bloco `vars { }`), de `vars:pre-request`, de `vars:post-response`, ou de `bru.setVar` em scripts. `bru.getVar("x")` lê em script. `bru.getEnvVar("x")` lê do ambiente.

Objetos em script: `req` (`req.getUrl()`, `req.setHeader`, `req.setBody`), `res` (`res.status`, `res.body`, `res.getBody()`, `res.getHeader("nome")`, `res.responseTime`), `bru`.

Armadilhas:
- Em `assert`, `res.headers.x-total-count` é lido como subtração. Usa `tests` com `res.getHeader`.
- `@file(...)` é relativo à raiz da coleção (onde está `bruno.json`), não ao ficheiro `.bru`.
- Ordem de execução: pastas por ordem alfabética, ficheiros por `seq`. Prefixar com números.
- Uma variável definida com `vars:post-response` só existe depois desse pedido correr, dentro da mesma execução.
- `eq` com valores de texto: escreve o valor sem aspas (`eq ativo`). Com espaços também funciona (`eq João Silva`).
- Corpo JSON com `{{var}}` dentro de aspas quando é texto, sem aspas quando é número.

Correr: `bru run --env local`, `bru run pasta --env local`, `bru run --env local --reporter-json saida.json`, `bru run --env local --env-var baseUrl=http://outro:8080`.
