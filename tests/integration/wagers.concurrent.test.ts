import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Wallet } from '../../src/wallets/entities/wallet.entity.js';
import { WagerTransaction } from '../../src/wallets/entities/wager-transaction.entity.js';
import { WalletLedgerEntry } from '../../src/wallets/entities/wallet-ledger-entry.entity.js';
import { OutboxMessage } from '../../src/messaging/entities/outbox-message.entity.js';
import { WagersService } from '../../src/wagers/wagers.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is required to run the PostgreSQL integration test.',
  );
}

const target = new URL(databaseUrl);

if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['localhost', '127.0.0.1', '::1'].includes(target.hostname) ||
  target.port !== '5432' ||
  target.pathname !== '/wagering' ||
  decodeURIComponent(target.username) !== 'wagering'
) {
  throw new Error(
    'TEST_DATABASE_URL must target the local wagering database on port 5432 as user wagering.',
  );
}

describe('WagersService PostgreSQL concurrency', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      clientUrl: databaseUrl,
      entities: [Wallet, WagerTransaction, WalletLedgerEntry, OutboxMessage],
    });
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  it('allows only one concurrent BET when the wallet can fund just one', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const uniqueSuffix = randomUUID();
    const providerId = `concurrency-${uniqueSuffix}`;
    const entityManager = orm.em.fork();

    await entityManager.persistAndFlush(
      entityManager.create(Wallet, {
        id: walletId,
        playerId,
        currency: 'BRL',
        balance: '100.00',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );

    const baseDto = {
      providerId,
      walletId,
      playerId,
      roundId: `round-${uniqueSuffix}`,
      gameId: 'concurrency-test',
      kind: 'BET' as const,
      amount: '80.00',
      currency: 'BRL',
    };
    const firstService = new WagersService(orm.em.fork());
    const secondService = new WagersService(orm.em.fork());

    const [first, second] = await Promise.all([
      firstService.submitWithResult({
        ...baseDto,
        externalTransactionId: `bet-first-${uniqueSuffix}`,
        idempotencyKey: `idem-first-${uniqueSuffix}`,
      }),
      secondService.submitWithResult({
        ...baseDto,
        externalTransactionId: `bet-second-${uniqueSuffix}`,
        idempotencyKey: `idem-second-${uniqueSuffix}`,
      }),
    ]);

    const verificationManager = orm.em.fork();
    const transactions = await verificationManager.find(
      WagerTransaction,
      { providerId, walletId, kind: 'BET' },
    );
    const processed = transactions.filter(
      (transaction) => transaction.status === 'PROCESSED',
    );
    const rejected = transactions.filter(
      (transaction) =>
        transaction.status === 'REJECTED' &&
        transaction.failureCode === 'INSUFFICIENT_BALANCE',
    );
    const finalWallet = await verificationManager.findOneOrFail(Wallet, {
      id: walletId,
    });
    const debitEntries = await verificationManager.find(WalletLedgerEntry, {
      walletId,
      direction: 'DEBIT',
    });

    expect(transactions).toHaveLength(2);
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(finalWallet.balance).toBe('20.00');
    expect(debitEntries).toHaveLength(1);
    expect(debitEntries[0]?.amount).toBe('80.00');
    expect(debitEntries[0]?.balanceBefore).toBe('100.00');
    expect(debitEntries[0]?.balanceAfter).toBe('20.00');
  });

  it('persists rejection and pending-reference events with their transactions', async () => {
    const uniqueSuffix = randomUUID();
    const rejectedWalletId = randomUUID();
    const rejectedPlayerId = randomUUID();
    const pendingWalletId = randomUUID();
    const pendingPlayerId = randomUUID();
    const entityManager = orm.em.fork();

    await entityManager.persistAndFlush([
      entityManager.create(Wallet, {
        id: rejectedWalletId,
        playerId: rejectedPlayerId,
        currency: 'BRL',
        balance: '100.00',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      entityManager.create(Wallet, {
        id: pendingWalletId,
        playerId: pendingPlayerId,
        currency: 'BRL',
        balance: '100.00',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ]);

    const providerId = `outbox-${uniqueSuffix}`;
    const rejectedResult = await new WagersService(orm.em.fork()).submitWithResult({
      providerId,
      externalTransactionId: `rejected-${uniqueSuffix}`,
      idempotencyKey: `idem-rejected-${uniqueSuffix}`,
      walletId: rejectedWalletId,
      playerId: rejectedPlayerId,
      roundId: `round-${uniqueSuffix}`,
      gameId: 'outbox-test',
      kind: 'BET',
      amount: '150.00',
      currency: 'BRL',
    });
    const pendingResult = await new WagersService(orm.em.fork()).submitWithResult({
      providerId,
      externalTransactionId: `pending-${uniqueSuffix}`,
      idempotencyKey: `idem-pending-${uniqueSuffix}`,
      walletId: pendingWalletId,
      playerId: pendingPlayerId,
      roundId: `round-${uniqueSuffix}`,
      gameId: 'outbox-test',
      kind: 'REFUND',
      amount: '25.00',
      currency: 'BRL',
      referenceExternalTransactionId: `missing-${uniqueSuffix}`,
    });

    const verificationManager = orm.em.fork();
    const rejectedTransaction = await verificationManager.findOneOrFail(
      WagerTransaction,
      { id: rejectedResult.transaction.id },
    );
    const rejectedEvent = await verificationManager.findOneOrFail(
      OutboxMessage,
      {
        aggregateId: rejectedTransaction.id,
        eventType: 'WagerTransactionRejected',
      },
    );
    const pendingTransaction = await verificationManager.findOneOrFail(
      WagerTransaction,
      { id: pendingResult.transaction.id },
    );
    const pendingEvent = await verificationManager.findOneOrFail(
      OutboxMessage,
      {
        aggregateId: pendingTransaction.id,
        eventType: 'WagerTransactionPendingReference',
      },
    );

    expect(rejectedTransaction.status).toBe('REJECTED');
    expect(rejectedEvent.payload).toMatchObject({
      transactionId: rejectedTransaction.id,
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_BALANCE',
      balance: '100.00',
      version: 1,
    });
    expect(pendingTransaction.status).toBe('PENDING_REFERENCE');
    expect(pendingEvent.payload).toMatchObject({
      transactionId: pendingTransaction.id,
      status: 'PENDING_REFERENCE',
      referenceExternalTransactionId: `missing-${uniqueSuffix}`,
    });
  });

  it('persists a rejected ROLLBACK event with its transaction', async () => {
    const uniqueSuffix = randomUUID();
    const walletId = randomUUID();
    const playerId = randomUUID();
    const providerId = `rollback-rejected-${uniqueSuffix}`;
    const roundId = `round-${uniqueSuffix}`;
    const referenceExternalTransactionId = `win-${uniqueSuffix}`;
    const entityManager = orm.em.fork();

    await entityManager.persistAndFlush(
      entityManager.create(Wallet, {
        id: walletId,
        playerId,
        currency: 'BRL',
        balance: '100.00',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );

    await entityManager.persistAndFlush(
      entityManager.create(WagerTransaction, {
        id: randomUUID(),
        providerId,
        externalTransactionId: referenceExternalTransactionId,
        idempotencyKey: `idem-reference-${uniqueSuffix}`,
        payloadHash: 'a'.repeat(64),
        walletId,
        playerId,
        roundId,
        gameId: 'rollback-test',
        kind: 'WIN',
        amount: '150.00',
        currency: 'BRL',
        status: 'PROCESSED',
        createdAt: new Date(),
        processedAt: new Date(),
      }),
    );

    const result = await new WagersService(orm.em.fork()).submitWithResult({
      providerId,
      externalTransactionId: `rollback-${uniqueSuffix}`,
      idempotencyKey: `idem-rollback-${uniqueSuffix}`,
      walletId,
      playerId,
      roundId,
      gameId: 'rollback-test',
      kind: 'ROLLBACK',
      amount: '150.00',
      currency: 'BRL',
      referenceExternalTransactionId,
    });

    const verificationManager = orm.em.fork();
    const rejectedTransaction = await verificationManager.findOneOrFail(
      WagerTransaction,
      { id: result.transaction.id },
    );
    const rejectionEvent = await verificationManager.findOneOrFail(
      OutboxMessage,
      {
        aggregateId: rejectedTransaction.id,
        eventType: 'WagerTransactionRejected',
      },
    );
    const wallet = await verificationManager.findOneOrFail(Wallet, { id: walletId });
    const ledgerEntries = await verificationManager.find(WalletLedgerEntry, {
      walletId,
    });

    expect(rejectedTransaction.status).toBe('REJECTED');
    expect(rejectedTransaction.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(rejectionEvent.payload).toMatchObject({
      transactionId: rejectedTransaction.id,
      providerId,
      externalTransactionId: `rollback-${uniqueSuffix}`,
      walletId,
      playerId,
      kind: 'ROLLBACK',
      amount: '150.00',
      currency: 'BRL',
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_BALANCE',
      balance: '100.00',
      version: 1,
    });
    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(ledgerEntries).toHaveLength(0);
  });
});
