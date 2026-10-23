# Arquitetura — Distributed Wagering Processor

## Visão geral

O serviço usa NestJS para a API, PostgreSQL para os dados financeiros e uma Outbox para encaminhar eventos ao SQS. As seções abaixo descrevem o que está implementado, o que foi testado e o que ainda precisa de trabalho; configuração ou estrutura de banco, isoladamente, não significa que um fluxo esteja pronto.

Os resultados de teste mencionados são os últimos observados e não foram reexecutados durante esta revisão documental.

## Componentes e decisões presentes

- **Runtime e aplicação:** Bun, TypeScript estrito e NestJS. A inicialização configura `ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`.
- **Persistência:** PostgreSQL acessado por MikroORM. O caso de uso de submissão executa a operação em `EntityManager.transactional()`.
- **Dinheiro:** `Money` utiliza Decimal.js e recebe/serializa valores como strings decimais. As colunas persistidas de saldo e valor são `numeric(20,2)`.
- **Concorrência de carteira:** o processamento adquire `PESSIMISTIC_WRITE` na linha da carteira antes de validar e alterar o saldo. O campo `version` é incrementado quando a operação altera o saldo; não foi identificado uso de optimistic locking.
- **Mensageria local:** Docker Compose executa PostgreSQL e LocalStack. O script de inicialização configura filas SQS FIFO principal e DLQ.
- **Autenticação:** não implementada; a opção é compatível com o desafio, que não exige autenticação. Não há AuthGuard no-op nem port de identidade explícito no código atual.

## Transação financeira, saldo e ledger

Para uma submissão HTTP, o serviço faz dentro da transação SQL: busca idempotência, bloqueia a carteira, verifica jogador/moeda, valida as regras financeiras, persiste a transação, altera saldo quando aplicável, registra ledger quando há movimentação e persiste o evento Outbox aplicável. O commit é coordenado pelo MikroORM.

`BET` gera débito se houver saldo suficiente; caso contrário, grava `REJECTED` com `INSUFFICIENT_BALANCE`, cria `WagerTransactionRejected` e retorna sem mudança de saldo ou ledger. `WIN` e `REFUND` geram crédito; `LOSS` é registrada como processada sem mudança de saldo ou entrada no ledger. `ROLLBACK` inverte o efeito de referência elegível; quando o débito de um rollback de `WIN` ou `REFUND` excederia o saldo, grava `REJECTED` com `INSUFFICIENT_BALANCE` e cria `WagerTransactionRejected`, sem alterar saldo ou ledger. Uma referência ausente é persistida em `PENDING_REFERENCE` com evento `WagerTransactionPendingReference`.

Na criação da carteira, saldo inicial positivo gera uma transação interna `OPENING` e um lançamento `CREDIT` na mesma transação. A carteira com saldo inicial zero não recebe lançamento de abertura.

O ledger armazena direção, valor, moeda e saldos anterior/posterior. A migration inclui:

- unicidade de uma entrada por carteira/transação;
- checks de valor positivo, saldo não negativo e aritmética de `balance_before`, direção, valor e `balance_after`;
- chaves estrangeiras de carteira/moeda e transação;
- trigger `wallet_ledger_immutable`, que rejeita `UPDATE` e `DELETE`.

Essas regras são garantias declaradas no schema migrado, não uma validação de todos os cenários em produção. A verificação concorrente documentada cobre um cenário específico de duas apostas numa carteira; não cobre carga, múltiplos processos da aplicação nem todas as combinações de regras financeiras.

## Idempotência e identidade externa

O cabeçalho `Idempotency-Key` é obrigatório na submissão HTTP. A chave é persistida em `wager_transactions` com constraint única. O serviço calcula SHA-256 de um objeto JSON montado com os campos de negócio (`providerId`, IDs, carteira/jogador, rodada, jogo, tipo, valor, moeda e referência); a chave não entra no hash.

Se a chave já existir, payload com o mesmo hash pode retornar replay; hash diferente resulta em conflito. Há também unicidade por `(provider_id, external_transaction_id)` e tratamento de violação de unicidade no serviço. O objeto usado no hash é montado com propriedades em ordem fixa, mas o código não oferece canonicalização genérica de JSON conforme a recomendação do desafio. A idempotência persistente tem cobertura unitária; não foram validados todos os cenários de corrida e recuperação.

No replay, o serviço usa o saldo posterior salvo no ledger quando há lançamento. Em operações sem ledger, como `LOSS` e rejeições, consulta o saldo atual da carteira, que pode ser diferente do saldo retornado na resposta original.

## Outbox e SQS

### Registro e publicação

No fluxo processado, a linha `WAGER_PROCESSED` da Outbox é persistida na mesma transação SQL da operação financeira. O publicador consulta mensagens sem `published_at`, ordenadas por `created_at`, e envia para SQS FIFO o envelope com ID, agregado, tipo, payload e horário. Usa `aggregateId` como `MessageGroupId` e o ID da Outbox como `MessageDeduplicationId`; após o envio, atualiza `published_at`.

O publicador roda a cada cinco segundos. A flag `isPublishing` impede sobreposição somente dentro da mesma instância. Sem lock de linha, claim atômico ou lease, duas instâncias podem publicar a mesma mensagem. Também pode haver duplicidade se o SQS aceitar o envio, mas a atualização de `published_at` falhar. A deduplicação FIFO não substitui a idempotência do consumidor, e o sistema não oferece garantia exactly-once.

A entidade e tabela Outbox possuem `attempts` e `next_attempt_at`, mas o publicador não incrementa esses campos, não agenda backoff e não filtra mensagens pela data de próxima tentativa. Falhas de envio são registradas em log e a mensagem permanece sem `published_at`, podendo ser tentada no ciclo subsequente. Isso não constitui política efetiva de retry/backoff.

### Eventos e configuração

Os tipos atualmente persistidos na Outbox pelo serviço são:

- `WAGER_PROCESSED` para o caminho processado;
- `WagerTransactionRejected` para BET rejeitada por saldo insuficiente e ROLLBACK rejeitado por saldo insuficiente;
- `WagerTransactionPendingReference` quando a transação é persistida aguardando referência.

Os eventos de rejeição e referência pendente são persistidos junto à respectiva transação na mesma transação SQL. Ainda não há publisher para `WalletBalanceChanged`, previsto separadamente na especificação. Os testes verificam a persistência dos eventos, mas não provocam falha de commit para testar o rollback conjunto.

O publicador prioriza `SQS_WAGER_TRANSACTIONS_QUEUE_URL`, mantém `SQS_QUEUE_URL` como fallback legado e usa `http://localhost:4566/000000000000/wager-transactions.fifo` quando ambas não estão definidas. Testes unitários verificam os três casos. O Compose e o script do LocalStack criam a fila FIFO principal e a DLQ, com política de redrive e `maxReceiveCount` configurado. Isso descreve infraestrutura local; o ciclo de consumo e tratamento funcional da DLQ não está implementado nem validado.

## Inbox e referências fora de ordem

A migration cria `inbox_messages`, com chave primária composta por consumidor e ID da mensagem. A tabela ainda não tem entidade Inbox registrada no MikroORM, e não há consumidor SQS nem código para registrar ou processar mensagens recebidas. Portanto, a Inbox existe apenas como estrutura no banco; o fluxo funcional não foi implementado.

`REFUND` e `ROLLBACK` com referência ausente podem ser persistidos como `PENDING_REFERENCE`. Ainda não há worker para retomar a operação quando a referência chega, nem política de backoff, limite de tentativas, TTL ou evento de expiração.

## Limites das garantias do PostgreSQL

As garantias pretendidas no banco incluem saldo não negativo, moeda em maiúsculas, carteira única por jogador/moeda, unicidade de chave de idempotência, unicidade de identidade externa, integridade de referências/carteiras/ledger, consistência aritmética do ledger e imutabilidade dos lançamentos. A migration inicial contém constraints e trigger correspondentes, além de índices para referências pendentes, reversões, leitura de ledger e Outbox.

O lock pessimista aplicado pelo serviço protege a atualização concorrente da mesma carteira no PostgreSQL testado. A constraint de saldo não negativo é uma segunda defesa no banco. A verificação concorrente observada usou duas chamadas do serviço com gerenciadores separados contra um PostgreSQL real: de duas apostas de `80.00` sobre saldo `100.00`, uma processou, outra foi rejeitada, saldo terminou em `20.00` e houve um débito no ledger.

Esse teste cobre uma situação específica; não valida execução em várias instâncias, coordenação dos publicadores, recuperação entre commit e publicação, nem todos os invariantes sob falhas.

Em uma execução anterior, `bun run db:status` reportou divergência entre o schema e os metadados do MikroORM. A causa ainda não foi identificada, e o alinhamento do banco continua pendente de investigação. Esta revisão não executou migrations nem sincronização de schema.

## API e autenticação

Controllers encontrados:

- Carteiras: `POST /wallets`, `GET /wallets/:id` e `GET /wallets/:id/ledger`.
- Apostas: `POST /wagering/transactions`, com `Idempotency-Key` obrigatório.
- Health: `GET /health/live` e `GET /health/ready`; readiness consulta PostgreSQL e SQS.

Ledger usa parâmetros `page` e `limit`, com página padrão 1, limite padrão 20 e limite efetivo máximo 50. Cursor opaco não está implementado. Não foram encontrados endpoints para consulta de transação por ID, consulta por provedor/ID externo ou reconciliação.

Os endpoints não têm autenticação atualmente. Para extensão futura, a decisão compatível com o desafio é integrar um Identity Provider externo (por exemplo, OIDC), aplicar guardas de autenticação/autorização às rotas de negócio e validar identidade do provedor no domínio. Health checks devem permanecer abertos. Esse desenho é orientação para trabalho futuro, não componente existente; não há atualmente guard/port de identidade explícito. Também não há canal de mensagens consumidas, apesar de o desafio tratá-lo como canal interno confiável.

## Evidências de validação registradas

| Verificação | Resultado conhecido | Escopo e limite |
|---|---|---|
| `bun run typecheck` | Passou | Último resultado observado; não substitui testes comportamentais. |
| `bun run build` | Passou | Último resultado observado. |
| `bun run test:unit` | **31 testes, 0 falhas, 155 verificações** | Último resultado observado em 22/10/2026. |
| `bun test tests/integration/wagers.concurrent.test.ts` | **3 testes aprovados, 18 verificações** | Último resultado observado em 22/10/2026, contra PostgreSQL real. Inclui concorrência BET e persistência de eventos de BET rejeitada, referência pendente e ROLLBACK rejeitado. |
| Teste de falha de commit | Não executado/não implementado | A atomicidade é estruturada pelo uso da transação MikroORM, mas o rollback provocado por falha de commit ainda não foi testado. |
| Publicação no LocalStack/SQS FIFO | Há registro de validação local de publicação | Não comprova coordenação entre publishers, retries, recuperação após falha, consumidor ou DLQ de ponta a ponta. |
| `GET /health/ready` | Há registro de validação | Não representa teste exaustivo de indisponibilidade e recuperação dos serviços dependentes. |
| `bun run db:status` | Divergência detectada | A causa ainda precisa ser investigada; esta revisão não alterou o schema por sincronização automática. |

Os resultados acima são os últimos observados e não foram reexecutados ao atualizar a documentação. `bun test` pode falhar se `TEST_DATABASE_URL` não estiver configurada; `bun run test:unit` executa somente a suíte unitária.

## Próximos passos

1. Completar o fluxo assíncrono: consumidor com Inbox, confirmação após commit, coordenação da Outbox, retry/backoff e tratamento da DLQ.
2. Implementar `WalletBalanceChanged`, reprocessamento de `PENDING_REFERENCE`, consulta de transações e reconciliação do ledger.
3. Ampliar a validação para falha de commit, múltiplas instâncias e falhas entre commit e publicação.
4. Investigar a divergência entre schema e metadados do MikroORM; a causa ainda não foi identificada.
5. Definir futuramente a extensão de autenticação com um Identity Provider externo.
