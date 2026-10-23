# Distributed Wagering Processor

API backend para processamento de transações de apostas, com foco em integridade financeira, idempotência, concorrência e rastreabilidade do saldo por meio de ledger.

A aplicação utiliza NestJS, TypeScript, PostgreSQL e MikroORM. As operações financeiras são transacionais, e os eventos de domínio são registrados na Outbox para publicação assíncrona no SQS.

O projeto implementa os principais fluxos financeiros e possui testes unitários e um teste de integração com PostgreSQL real. Os componentes ainda incompletos e as garantias não validadas integralmente estão identificados neste documento.

## Estado atual

| Estado | Significado |

| **Implementado e validado** | Existe implementação e há evidência de validação correspondente, descrita com seu contexto. |
| **Implementado parcialmente** | Existe parte do fluxo, mas faltam partes funcionais ou garantias previstas. |
| **Implementado, mas não validado integralmente** | Há código, mas a evidência disponível não cobre todos os cenários ou ambientes relevantes. |
| **Não implementado** | Não foi encontrada implementação no código atual. |

O fluxo HTTP e as principais regras financeiras estão implementados. Na última validação registrada, em 23/10/2026, `bun run test:unit` passou com **31 testes e 155 verificações**; o teste de integração PostgreSQL passou com **3 testes e 18 verificações**; `bun run typecheck` e `bun run build` também passaram. Esses são resultados observados anteriormente, não uma nova execução desta revisão.

O teste PostgreSQL cobre duas apostas concorrentes de `80.00` sobre saldo de `100.00`: uma é processada, a outra rejeitada, o saldo final é `20.00` e há um débito no ledger. Também verifica os eventos de BET rejeitada, `PENDING_REFERENCE` e ROLLBACK rejeitado por saldo insuficiente. Não cobre concorrência entre instâncias da aplicação, processamento SQS de ponta a ponta ou rollback provocado por falha de commit.

## Stack

- Bun 1.x para runtime, gerenciamento de dependências e testes.
- TypeScript em modo estrito.
- NestJS para a API HTTP.
- PostgreSQL e MikroORM para persistência e transações.
- Decimal.js para operações monetárias.
- Docker Compose para PostgreSQL e LocalStack.
- AWS SQS, com filas FIFO configuradas no ambiente local.

## Configuração local

Pré-requisitos: Bun 1.x e Docker Desktop com Docker Compose.

Na raiz do projeto, copie o exemplo de ambiente, instale as dependências e inicie PostgreSQL e LocalStack:

```powershell
Copy-Item .env.example .env
bun install
docker compose up -d
bun run dev
```

O serviço HTTP usa a porta `3000` por padrão. O Compose define PostgreSQL e LocalStack; a inicialização local do LocalStack cria `wager-transactions.fifo` e `wager-transactions-dlq.fifo`. Para preparar um banco novo, o script disponível é `bun run db:migrate`; no banco usado durante o desenvolvimento foi observada a divergência de metadados descrita abaixo.

**Configuração SQS:** o publicador prioriza `SQS_WAGER_TRANSACTIONS_QUEUE_URL`, usa `SQS_QUEUE_URL` como fallback legado e, se ambas estiverem ausentes, usa `http://localhost:4566/000000000000/wager-transactions.fifo`. Testes unitários cobrem a precedência, o fallback e a URL padrão. `.env.example` documenta a variável prioritária.

Em uma execução anterior, `bun run db:status` sinalizou divergência entre o schema e os metadados do MikroORM. A causa não foi determinada e a pendência continua aberta; esta revisão não executou o comando, migrations ou sincronização de schema.

## API disponível

| Método | Endpoint | Estado e comportamento observado |
|---|---|---|
| `POST` | `/wallets` | Implementado. Cria carteira; saldo inicial positivo gera transação `OPENING` e crédito no ledger na mesma transação SQL. |
| `GET` | `/wallets/:id` | Implementado. Consulta carteira por UUID. |
| `GET` | `/wallets/:id/ledger?page=1&limit=20` | Implementado. Paginação por página e limite; limite máximo efetivo de 50. Não é paginação por cursor opaco. |
| `POST` | `/wagering/transactions` | Implementado. Exige `Idempotency-Key` e aceita `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. `OPENING` não é aceito neste endpoint. |
| `GET` | `/health/live` | Implementado. Indica que o processo HTTP está ativo. |
| `GET` | `/health/ready` | Implementado. Verifica conexão com PostgreSQL e alcançabilidade do SQS. |

### Endpoints previstos, mas não implementados

Os endpoints abaixo aparecem na especificação do desafio, mas não foram encontrados nos controllers:

- `GET /wagering/transactions/:transactionId`
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
- `POST /wallets/:walletId/reconciliation`

### Exemplo de submissão

```http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
Content-Type: application/json
```

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": {
    "amount": "25.00",
    "currency": "BRL"
  }
}
```

A resposta inclui `transactionId`, `status`, `balance` (`amount` e `currency`) e `idempotentReplay`. O contrato de entrada valida valores monetários como strings decimais não negativas com duas casas, moeda em três letras maiúsculas e os campos definidos no DTO.

## Modelo financeiro e regras presentes

- `Money` usa Decimal.js, é imutável e serializa o valor com duas casas decimais. Valores monetários do domínio não são calculados com `number`.
- Carteiras armazenam saldo como `numeric(20,2)`. A migration define saldo não negativo, moeda em maiúsculas e unicidade por jogador/moeda.
- O processamento de aposta ocorre em transação MikroORM e adquire lock pessimista de escrita na carteira. A operação valida também a identidade do jogador e a moeda informados.
- A chave `Idempotency-Key` é persistida em `wager_transactions`. O serviço calcula SHA-256 de um objeto JSON com os campos de negócio; a chave não integra o hash. Uma chave repetida com conteúdo diferente resulta em conflito. O JSON não é canonicalizado com ordenação genérica de chaves, como recomenda a especificação.
- No replay, o serviço devolve o saldo posterior registrado no ledger quando existe lançamento. Para operações sem ledger, como `LOSS` e rejeições, consulta o saldo atual da carteira; portanto, esse valor pode diferir do saldo visto na resposta original.
- `BET` debita somente quando há saldo suficiente; saldo insuficiente persiste transação rejeitada sem alterar a carteira nem criar ledger.
- `WIN` e `REFUND` creditam. `LOSS` registra transação sem alterar saldo nem criar lançamento. `ROLLBACK` inverte o efeito de uma referência elegível; saldo insuficiente também resulta em rejeição.
- `REFUND` e `ROLLBACK` exigem referência e verificam elegibilidade, identidade, rodada, moeda e valor. Referência ausente é persistida como `PENDING_REFERENCE`.
- A migration define unicidade de reversão por referência e tipo, e no máximo um lançamento por carteira/transação. Define ainda restrições aritméticas para o saldo antes/depois e trigger que impede atualização ou exclusão de lançamentos do ledger.
- Criação de carteira com saldo inicial positivo registra `OPENING` e o respectivo crédito no ledger na mesma transação SQL. A criação com saldo inicial zero não gera esse lançamento.

**Limite importante:** persistir uma referência ausente como `PENDING_REFERENCE` e seu evento está implementado, mas não foi encontrado worker que a reprocesse quando a referência chegar.

## Mensageria: Outbox, Inbox, consumidor e DLQ

### Outbox e publicador

**Implementado parcialmente; validação integral não comprovada.** O processamento financeiro bem-sucedido persiste `WAGER_PROCESSED` na tabela Outbox dentro da transação que atualiza a carteira e o ledger (quando há efeito no saldo). Uma BET ou ROLLBACK rejeitado por saldo insuficiente persiste `WagerTransactionRejected`; uma transação persistida em `PENDING_REFERENCE` persiste `WagerTransactionPendingReference`. Esses eventos são gravados na mesma transação SQL que a respectiva transação financeira. Um publicador periódico consulta mensagens não publicadas e envia eventos para SQS FIFO, usando `aggregateId` como `MessageGroupId` e o ID da Outbox como `MessageDeduplicationId`. Após envio bem-sucedido, marca `published_at`.

O publicador evita sobreposição de chamadas dentro da mesma instância, mas não coordena múltiplas instâncias. Duas instâncias podem ler e enviar a mesma mensagem antes de marcarem sua publicação; não há garantia de publicação única ou exactly-once. Embora a tabela tenha `attempts` e `next_attempt_at`, o publicador atual não aplica política de retry/backoff nem usa esses campos para selecionar mensagens.

Há filas FIFO principal e DLQ configuradas no LocalStack, com `maxReceiveCount` definido no script de inicialização. Isso é configuração de infraestrutura, não prova de consumidor ou de tratamento funcional da DLQ. O publicador é produtor; não foi encontrado consumidor SQS.

### Inbox e consumo SQS

**Não implementados.** A migration cria `inbox_messages`, mas não há entidade Inbox registrada no MikroORM, consumidor SQS, ACK após commit ou deduplicação de mensagens recebidas. A existência da tabela, por si só, não representa o fluxo Inbox.

## Autenticação

Autenticação não está implementada, o que é uma opção aceita pelo desafio. A API não configura guard ou identidade do provedor. A extensão futura recomendada é integrar um Identity Provider externo (por exemplo, OIDC) e introduzir validação de identidade/autorização nos endpoints de negócio; health checks devem continuar públicos. O ponto de extensão de autenticação ainda não está explicitamente codificado.

## Testes e validação

Scripts declarados em `package.json`:

| Comando | Uso |
|---|---|
| `bun run typecheck` | Verificação de tipos. Passou na última validação registrada. |
| `bun run build` | Build TypeScript. Passou na última validação registrada. |
| `bun run test:unit` | Executa somente `tests/unit`. Último resultado registrado: 31 testes aprovados e 155 verificações. |
| `bun test` ou `bun run test` | Executa a suíte completa, incluindo integração. O teste de integração exige `TEST_DATABASE_URL` apontando para o banco PostgreSQL local esperado; sem essa variável, a execução pode falhar antes dos testes. |
| `bun run db:migrate` | Aplica migrations. Não foi executado durante esta revisão documental. |
| `bun run db:status` | Verifica o estado das migrations; há divergência registrada entre schema e metadados MikroORM. |

O último resultado registrado para `tests/integration/wagers.concurrent.test.ts` foi **3 testes aprovados e 18 verificações**, contra PostgreSQL real. Além do cenário concorrente, o teste consulta a persistência dos eventos de BET rejeitada, referência pendente e ROLLBACK rejeitado. Ele não injeta uma falha durante o commit e, portanto, não testa o rollback conjunto da transação e do evento.

## Progresso em relação ao desafio

### Implementado e testado

- Typecheck, build e testes unitários, conforme os últimos resultados registrados acima.
- Regras unitárias de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- Concorrência entre duas apostas na mesma carteira, testada contra PostgreSQL real.
- Persistência dos eventos de rejeição e referência pendente, incluindo ROLLBACK rejeitado por saldo insuficiente.
- Seleção da URL SQS documentada, fallback legado e URL padrão local, testados com publisher e cliente SQS simulados.

### Implementado, com cobertura ou escopo parcial

O caso de uso grava a alteração financeira, ledger (quando há movimentação) e Outbox na mesma transação MikroORM. Os testes confirmam os fluxos descritos, mas não provocam falha no commit para verificar o rollback conjunto.

### Ainda não implementado ou não comprovado

- Endpoints para consultar transação por ID, consultar por provedor/ID externo e reconciliar carteira com ledger.
- Canonicalização genérica do payload para o hash de idempotência e snapshot do saldo original para replay de operações sem ledger.
- Worker para reprocessar transações `PENDING_REFERENCE`.
- Evento distinto `WalletBalanceChanged`.
- Consumidor SQS, Inbox funcional, ACK pós-commit e redelivery segura.
- Retry/backoff efetivo da Outbox e coordenação de publishers entre instâncias. Podem ocorrer publicações duplicadas; não há garantia exactly-once.
- Tratamento funcional da DLQ. A fila e a política de redrive existem na configuração local, mas não há consumidor nem validação do fluxo completo.
- Teste que provoque falha de commit e verifique rollback do evento e da transação financeira.
- Autenticação. A extensão com Identity Provider externo ainda não tem ponto de integração no código.

## Limitações conhecidas e próximos passos priorizados

1. Implementar o consumidor SQS com Inbox e confirmação após commit; validar redelivery e tratamento da DLQ.
2. Coordenar a publicação da Outbox entre instâncias e implementar retry/backoff.
3. Retomar automaticamente referências pendentes e publicar `WalletBalanceChanged`.
4. Completar as consultas de transação e a reconciliação do ledger; revisar a canonicalização do hash de idempotência e o saldo retornado em replays sem ledger.
5. Testar falhas de commit e outros cenários financeiros concorrentes. Investigar a divergência entre schema e metadados MikroORM; a causa ainda não está identificada.

A autenticação pode ser adicionada futuramente por meio de um Identity Provider externo, mantendo os health checks públicos.
