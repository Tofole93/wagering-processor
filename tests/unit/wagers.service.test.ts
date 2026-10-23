
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { WagersService } from '../../src/wagers/wagers.service.js';
import { Wallet } from '../../src/wallets/entities/wallet.entity.js';
import { WagerTransaction } from '../../src/wallets/entities/wager-transaction.entity.js';
import { WalletLedgerEntry } from '../../src/wallets/entities/wallet-ledger-entry.entity.js';
import type { SubmitWagerDto } from '../../src/wagers/dto/submit-wager.dto.js';
import { create } from 'domain';
import { OutboxMessage } from '../../src/messaging/entities/outbox-message.entity.js';

describe('WagersService', () => {
  const walletId = 'c377174e-915e-4688-bf0f-c814f291b4b8';
  const playerId = 'b2c3d4e5-f678-4901-8234-56789abcdef0';

  let wallet: Wallet;
  let createdTransaction: WagerTransaction | undefined;
  let createdLedgerEntry: WalletLedgerEntry | undefined;
  let createdOutboxMessage: OutboxMessage | undefined;
  let createdOutboxMessages: OutboxMessage[];
  let persistedEntities: unknown[];
  let service: WagersService;
  let em: any;
  let referenceTransaction: WagerTransaction | undefined;
  let transactions: WagerTransaction[];

  const dto: SubmitWagerDto = {
    providerId: 'test-provider',
    externalTransactionId: 'bet-test-001',
    idempotencyKey: 'idem-bet-test-001',
    walletId,
    playerId,
    roundId: 'round-001',
    gameId: 'game-001',
    kind: 'BET',
    amount: '30.00',
    currency: 'BRL',
  };

  beforeEach(() => {
    wallet = Object.assign(new Wallet(), {
      id: walletId,
      playerId,
      currency: 'BRL',
      balance: '100.00',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    createdTransaction = undefined;
    createdLedgerEntry = undefined;
    createdOutboxMessage = undefined;
    createdOutboxMessages = [];
    persistedEntities = [];
    referenceTransaction = undefined;
    transactions = [];

    const tx = {

      findOne: mock(async (entity: unknown, where: any) => {
        if (entity === WagerTransaction) {
          const found = transactions.find(
            (transaction) =>
              Object.entries(where).every(
                ([key, value]) =>
                  (transaction as any)[key] === value,
              ),
          );

          if (found) {
            return found;
          }
          if (
            referenceTransaction &&
            referenceTransaction.providerId === where.providerId &&
            referenceTransaction.externalTransactionId ===
            where.externalTransactionId
          ) {
            return referenceTransaction;
          }

          if (
            createdTransaction &&
            createdTransaction.idempotencyKey === where.idempotencyKey
          ) {
            return createdTransaction;
          }

          if (
            createdTransaction &&
            createdTransaction.providerId === where.providerId &&
            createdTransaction.externalTransactionId ===
            where.externalTransactionId
          ) {
            return createdTransaction;
          }

          return null;
        }

        if (entity === Wallet) {
          return where.id === wallet.id ? wallet : null;
        }

        return null;
      }),



      create: mock((entity: unknown, data: Record<string, any>) => {
        const instance = Object.assign(new (entity as any)(), data);

        if (entity === WagerTransaction) {
          createdTransaction = instance;
          transactions.push(instance);
        }

        if (entity === WalletLedgerEntry) {
          createdLedgerEntry = instance;
        }

        if (entity === OutboxMessage) {
          createdOutboxMessage = instance;
          createdOutboxMessages.push(instance);
        }
        return instance;
      }),
      persist: mock((entity: unknown) => {
        persistedEntities.push(entity);
      }),
      flush: mock(async () => undefined),
    };

    em = {
      transactional: mock(async (callback: (tx: any) => Promise<unknown>) =>
        callback(tx),
      ),
      findOne: mock(async () => createdTransaction ?? null),
    };

    service = new WagersService(em);
  });

  it('debita o saldo e registra a transação e o ledger ao processar uma BET', async () => {
    const result = await service.submit(dto);

    expect(result).toBeDefined();
    expect(result.kind).toBe('BET');
    expect(result.status).toBe('PROCESSED');
    expect(result.amount).toBe('30.00');

    expect(wallet.balance).toBe('70.00');
    expect(wallet.version).toBe(2);

    expect(createdTransaction).toBe(result);
    expect(createdLedgerEntry).toBeDefined();
    expect(createdLedgerEntry?.direction).toBe('DEBIT');
    expect(createdLedgerEntry?.amount).toBe('30.00');
    expect(createdLedgerEntry?.balanceBefore).toBe('100.00');
    expect(createdLedgerEntry?.balanceAfter).toBe('70.00');
    expect(createdOutboxMessage).toBeDefined();
    expect(createdOutboxMessage?.eventType).toBe('WAGER_PROCESSED');
    expect(createdOutboxMessage?.aggregateId).toBe(walletId);
    expect(createdOutboxMessage?.payload).toMatchObject({
      transactionId: result.id,
      status: 'PROCESSED',
      balance: '70.00',
      version: 2,
    });
  });


  it('rejeita uma BET com saldo insuficiente sem alterar a carteira', async () => {
    const oversizedBet: SubmitWagerDto = {
      ...dto,
      externalTransactionId: 'bet-test-insufficient',
      idempotencyKey: 'idem-bet-test-insufficient',
      amount: '150.00',
    };

    const result = await service.submit(oversizedBet);

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(result.processedAt).toBeDefined();

    const repeatedResult = await service.submit(oversizedBet);

    expect(repeatedResult).toBe(result);
    expect(transactions).toHaveLength(1);

    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(createdTransaction).toBe(result);
    expect(createdLedgerEntry).toBeUndefined();
    expect(createdOutboxMessages).toHaveLength(1);
    expect(createdOutboxMessages[0]).toMatchObject({
      aggregateId: result.id,
      eventType: 'WagerTransactionRejected',
      payload: {
        transactionId: result.id,
        providerId: oversizedBet.providerId,
        externalTransactionId: oversizedBet.externalTransactionId,
        walletId,
        playerId,
        kind: 'BET',
        amount: '150.00',
        currency: 'BRL',
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_BALANCE',
        balance: '100.00',
        version: 1,
      },
    });
    expect(persistedEntities).toContain(result);
    expect(persistedEntities).toContain(createdOutboxMessages[0]);
  });

  it('não debita o saldo novamente ao repetir a mesma aposta', async () => {
    const firstResult = await service.submit(dto);

    const balanceAfterFirstBet = wallet.balance;
    const versionAfterFirstBet = wallet.version;

    const secondResult = await service.submit(dto);

    expect(secondResult).toBe(firstResult);
    expect(wallet.balance).toBe(balanceAfterFirstBet);
    expect(wallet.balance).toBe('70.00');
    expect(wallet.version).toBe(versionAfterFirstBet);
    expect(wallet.version).toBe(2);
  });

    it('retorna a mesma transação ao repetir a mesma chave sem debitar novamente', async () => {
    const firstResult = await service.submit(dto);
    const repeatedResult = await service.submit(dto);

    expect(repeatedResult).toBe(firstResult);
    expect(wallet.balance).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(transactions).toHaveLength(1);
  });

  it('rejeita a mesma chave de idempotência com conteúdo diferente', async () => {
    await service.submit(dto);

    const modifiedDto: SubmitWagerDto = {
      ...dto,
      amount: '20.00',
    };

    await expect(service.submit(modifiedDto)).rejects.toThrow(
      'A chave de idempotência já foi usada com outro conteúdo.',
    );

    expect(wallet.balance).toBe('70.00');
    expect(wallet.version).toBe(2);
  });

  it('credita o saldo e registra um ledger CREDIT ao processar uma WIN', async () => {
    const winDto: SubmitWagerDto = {
      ...dto,
      externalTransactionId: 'win-test-001',
      idempotencyKey: 'idem-win-test-001',
      kind: 'WIN',
      amount: '50.00',
    };

    const result = await service.submit(winDto);

    expect(result.kind).toBe('WIN');
    expect(result.status).toBe('PROCESSED');
    expect(wallet.balance).toBe('150.00');
    expect(wallet.version).toBe(2);

    expect(createdLedgerEntry).toBeDefined();
    expect(createdLedgerEntry?.direction).toBe('CREDIT');
    expect(createdLedgerEntry?.balanceBefore).toBe('100.00');
    expect(createdLedgerEntry?.balanceAfter).toBe('150.00');
  });

  it('rejeita uma aposta quando a carteira não existe', async () => {
    const dtoWithMissingWallet: SubmitWagerDto = {
      ...dto,
      walletId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      externalTransactionId: 'bet-missing-wallet',
      idempotencyKey: 'idem-missing-wallet',
    };

    await expect(service.submit(dtoWithMissingWallet)).rejects.toThrow(
      'Carteira não encontrada.',
    );

    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(createdTransaction).toBeUndefined();
    expect(createdLedgerEntry).toBeUndefined();
  });

  it('rejeita uma aposta quando o jogador não corresponde à carteira', async () => {
    const dtoWithWrongPlayer: SubmitWagerDto = {
      ...dto,
      playerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      externalTransactionId: 'bet-wrong-player',
      idempotencyKey: 'idem-wrong-player',
    };

    await expect(service.submit(dtoWithWrongPlayer)).rejects.toThrow(
      'A carteira não corresponde ao jogador ou à moeda informados.',
    );

    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(createdTransaction).toBeUndefined();
    expect(createdLedgerEntry).toBeUndefined();
  });

  it('rejeita uma aposta quando a moeda não corresponde à carteira', async () => {
    const dtoWithWrongCurrency: SubmitWagerDto = {
      ...dto,
      currency: 'USD',
      externalTransactionId: 'bet-wrong-currency',
      idempotencyKey: 'idem-wrong-currency',
    };

    await expect(service.submit(dtoWithWrongCurrency)).rejects.toThrow(
      'A carteira não corresponde ao jogador ou à moeda informados.',
    );

    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(createdTransaction).toBeUndefined();
    expect(createdLedgerEntry).toBeUndefined();
  });

  it('rejeita uma aposta com valor zero', async () => {
    const zeroBet: SubmitWagerDto = {
      ...dto,
      amount: '0.00',
      externalTransactionId: 'bet-zero',
      idempotencyKey: 'idem-bet-zero',
    };

    await expect(service.submit(zeroBet)).rejects.toThrow(
      'O valor da transação deve ser maior que zero.',
    );

    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(createdTransaction).toBeUndefined();
    expect(createdLedgerEntry).toBeUndefined();
  });
  it('processa uma LOSS sem alterar o saldo nem criar lançamento no ledger', async () => {
    const lossDto: SubmitWagerDto = {
      ...dto,
      externalTransactionId: 'loss-test-001',
      idempotencyKey: 'idem-loss-test-001',
      kind: 'LOSS',
      amount: '30.00',
    };

    const result = await service.submit(lossDto);

    expect(result.kind).toBe('LOSS');
    expect(result.status).toBe('PROCESSED');
    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(createdLedgerEntry).toBeUndefined();
  });
  it('rejeita um REFUND quando a transação original não existe', async () => {
    const refundDto: SubmitWagerDto = {
      ...dto,
      externalTransactionId: 'refund-missing-original',
      idempotencyKey: 'idem-refund-missing-original',
      kind: 'REFUND',
      amount: '30.00',
      referenceExternalTransactionId: 'bet-that-does-not-exist',
    };

    const result = await service.submit(refundDto);

    expect(result.status).toBe('PENDING_REFERENCE');
    expect(result.kind).toBe('REFUND');
    expect(result.referenceExternalTransactionId).toBe(
      'bet-that-does-not-exist',
    );

    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(createdTransaction).toBe(result);
    expect(createdLedgerEntry).toBeUndefined();
    expect(createdOutboxMessages).toHaveLength(1);
    expect(createdOutboxMessages[0]).toMatchObject({
      aggregateId: result.id,
      eventType: 'WagerTransactionPendingReference',
      payload: {
        transactionId: result.id,
        providerId: refundDto.providerId,
        externalTransactionId: refundDto.externalTransactionId,
        walletId,
        playerId,
        kind: 'REFUND',
        amount: '30.00',
        currency: 'BRL',
        status: 'PENDING_REFERENCE',
        referenceExternalTransactionId: 'bet-that-does-not-exist',
      },
    });
    expect(persistedEntities).toContain(result);
    expect(persistedEntities).toContain(createdOutboxMessages[0]);
  });

  it('reprocessa um REFUND pendente quando a transação original chega', async () => {
    const refundDto: SubmitWagerDto = {
      ...dto,
      externalTransactionId: 'refund-pending-reprocess',
      idempotencyKey: 'idem-refund-pending-reprocess',
      kind: 'REFUND',
      amount: '30.00',
      referenceExternalTransactionId: 'bet-arrives-later',
    };

    const pendingResult = await service.submit(refundDto);

    expect(pendingResult.status).toBe('PENDING_REFERENCE');
    expect(wallet.balance).toBe('100.00');

    referenceTransaction = Object.assign(new WagerTransaction(), {
      id: 'original-bet-arrives-later',
      providerId: dto.providerId,
      externalTransactionId: 'bet-arrives-later',
      idempotencyKey: 'idem-bet-arrives-later',
      payloadHash: 'original-bet-hash',
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: 'BET',
      amount: '30.00',
      currency: dto.currency,
      status: 'PROCESSED',
    });

    const result = await service.submit(refundDto);

    expect(result.status).toBe('PROCESSED');
    expect(wallet.balance).toBe('130.00');
    expect(createdLedgerEntry?.direction).toBe('CREDIT');
    expect(
      createdOutboxMessages.filter(
        (message) => message.eventType === 'WagerTransactionPendingReference',
      ),
    ).toHaveLength(1);
  });

  it('processa um REFUND válido e credita o saldo', async () => {
    referenceTransaction = Object.assign(new WagerTransaction(), {
      id: 'original-bet-id',
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey: dto.idempotencyKey,
      payloadHash: 'original-hash',
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: 'BET',
      amount: dto.amount,
      currency: dto.currency,
      status: 'PROCESSED',
    });

    const refundDto: SubmitWagerDto = {
      ...dto,
      externalTransactionId: 'refund-test-001',
      idempotencyKey: 'idem-refund-test-001',
      kind: 'REFUND',
      referenceExternalTransactionId: dto.externalTransactionId,
    };

    await service.submit(refundDto);

    expect(wallet.balance).toBe('130.00');
    expect(createdTransaction?.kind).toBe('REFUND');
    expect(createdLedgerEntry?.direction).toBe('CREDIT');
  });

  it('rejeita um segundo REFUND para a mesma transação original', async () => {
    referenceTransaction = Object.assign(new WagerTransaction(), {
      id: 'original-bet-id',
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey: dto.idempotencyKey,
      payloadHash: 'original-hash',
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: 'BET',
      amount: dto.amount,
      currency: dto.currency,
      status: 'PROCESSED',
    });

    const firstRefund: SubmitWagerDto = {
      ...dto,
      externalTransactionId: 'refund-test-first',
      idempotencyKey: 'idem-refund-first',
      kind: 'REFUND',
      referenceExternalTransactionId: dto.externalTransactionId,
    };

    await service.submit(firstRefund);

    const secondRefund: SubmitWagerDto = {
      ...firstRefund,
      externalTransactionId: 'refund-test-second',
      idempotencyKey: 'idem-refund-second',
    };

    await expect(service.submit(secondRefund)).rejects.toThrow(
      'Já existe uma reversão para essa transação.',
    );

    expect(wallet.balance).toBe('130.00');
    expect(wallet.version).toBe(2);
  });

  it('processa um ROLLBACK de BET e devolve o valor à carteira', async () => {
    referenceTransaction = Object.assign(new WagerTransaction(), {
      id: 'original-bet-id',
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey: dto.idempotencyKey,
      payloadHash: 'original-hash',
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: 'BET',
      amount: dto.amount,
      currency: dto.currency,
      status: 'PROCESSED',
    });

    wallet.balance = '70.00';

    const rollbackDto: SubmitWagerDto = {
      ...dto,
      externalTransactionId: 'rollback-test-001',
      idempotencyKey: 'idem-rollback-test-001',
      kind: 'ROLLBACK',
      referenceExternalTransactionId: dto.externalTransactionId,
    };

    const result = await service.submit(rollbackDto);

    expect(result.kind).toBe('ROLLBACK');
    expect(result.status).toBe('PROCESSED');
    expect(result.referenceTransactionId).toBe('original-bet-id');
    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(2);
    expect(createdLedgerEntry?.direction).toBe('CREDIT');
    expect(createdLedgerEntry?.amount).toBe('30.00');
    expect(createdLedgerEntry?.balanceBefore).toBe('70.00');
    expect(createdLedgerEntry?.balanceAfter).toBe('100.00');
  });

  it('rejeita um ROLLBACK de WIN quando não há saldo suficiente', async () => {
    referenceTransaction = Object.assign(new WagerTransaction(), {
      id: 'original-win-id',
      providerId: dto.providerId,
      externalTransactionId: 'win-original-001',
      idempotencyKey: 'idem-win-original-001',
      payloadHash: 'original-hash',
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: 'WIN',
      amount: '150.00',
      currency: dto.currency,
      status: 'PROCESSED',
    });

    const rollbackDto: SubmitWagerDto = {
      ...dto,
      externalTransactionId: 'rollback-win-insufficient',
      idempotencyKey: 'idem-rollback-win-insufficient',
      kind: 'ROLLBACK',
      amount: '150.00',
      referenceExternalTransactionId: 'win-original-001',
    };

    const result = await service.submit(rollbackDto);

    expect(result.kind).toBe('ROLLBACK');
    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(result.referenceTransactionId).toBe('original-win-id');
    expect(result.processedAt).toBeDefined();

    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(createdTransaction).toBe(result);
    expect(createdLedgerEntry).toBeUndefined();
    expect(createdOutboxMessages).toHaveLength(1);
    expect(createdOutboxMessages[0]).toMatchObject({
      aggregateId: result.id,
      eventType: 'WagerTransactionRejected',
      payload: {
        transactionId: result.id,
        providerId: rollbackDto.providerId,
        externalTransactionId: rollbackDto.externalTransactionId,
        walletId,
        playerId,
        kind: 'ROLLBACK',
        amount: '150.00',
        currency: 'BRL',
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_BALANCE',
        balance: '100.00',
        version: 1,
      },
    });
    expect(persistedEntities).toContain(result);
    expect(persistedEntities).toContain(createdOutboxMessages[0]);
  });

  it('rejeita um segundo ROLLBACK para a mesma transação original', async () => {
    referenceTransaction = Object.assign(new WagerTransaction(), {
      id: 'original-win-id',
      providerId: dto.providerId,
      externalTransactionId: 'win-original-001',
      idempotencyKey: 'idem-win-original-001',
      payloadHash: 'original-hash',
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: 'WIN',
      amount: '50.00',
      currency: dto.currency,
      status: 'PROCESSED',
    });

    transactions.push(
      Object.assign(new WagerTransaction(), {
        id: 'previous-rollback-id',
        providerId: dto.providerId,
        externalTransactionId: 'rollback-win-previous',
        referenceExternalTransactionId: 'win-original-001',
        kind: 'ROLLBACK',
        status: 'PROCESSED',
      }),
    );

    const rollbackDto: SubmitWagerDto = {
      ...dto,
      externalTransactionId: 'rollback-win-second',
      idempotencyKey: 'idem-rollback-win-second',
      kind: 'ROLLBACK',
      amount: '50.00',
      referenceExternalTransactionId: 'win-original-001',
    };

    await expect(service.submit(rollbackDto)).rejects.toThrow();

    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(createdLedgerEntry).toBeUndefined();
  });

  it('processa um ROLLBACK de WIN quando há saldo suficiente', async () => {
    referenceTransaction = Object.assign(new WagerTransaction(), {
      id: 'original-win-success-id',
      providerId: dto.providerId,
      externalTransactionId: 'win-original-success',
      idempotencyKey: 'idem-win-original-success',
      payloadHash: 'original-win-success-hash',
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: 'WIN',
      amount: '30.00',
      currency: dto.currency,
      status: 'PROCESSED',
    });

    wallet.balance = '100.00';

    const rollbackDto: SubmitWagerDto = {
      ...dto,
      externalTransactionId: 'rollback-win-success',
      idempotencyKey: 'idem-rollback-win-success',
      kind: 'ROLLBACK',
      amount: '30.00',
      referenceExternalTransactionId: 'win-original-success',
    };

    const result = await service.submit(rollbackDto);

    expect(result.kind).toBe('ROLLBACK');
    expect(result.status).toBe('PROCESSED');
    expect(wallet.balance).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(createdLedgerEntry?.direction).toBe('DEBIT');
    expect(createdLedgerEntry?.amount).toBe('30.00');
  });

  it('processa um ROLLBACK de REFUND quando há saldo suficiente', async () => {
    referenceTransaction = Object.assign(new WagerTransaction(), {
      id: 'original-refund-id',
      providerId: dto.providerId,
      externalTransactionId: 'refund-original-001',
      idempotencyKey: 'idem-refund-original-001',
      payloadHash: 'original-refund-hash',
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: 'REFUND',
      amount: '30.00',
      currency: dto.currency,
      status: 'PROCESSED',
    });

    wallet.balance = '100.00';

    const rollbackDto: SubmitWagerDto = {
      ...dto,
      externalTransactionId: 'rollback-refund-success',
      idempotencyKey: 'idem-rollback-refund-success',
      kind: 'ROLLBACK',
      amount: '30.00',
      referenceExternalTransactionId: 'refund-original-001',
    };

    const result = await service.submit(rollbackDto);

    expect(result.kind).toBe('ROLLBACK');
    expect(result.status).toBe('PROCESSED');
    expect(wallet.balance).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(createdLedgerEntry?.direction).toBe('DEBIT');
    expect(createdLedgerEntry?.amount).toBe('30.00');
  });



});
