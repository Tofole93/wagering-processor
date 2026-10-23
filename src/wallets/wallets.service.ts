
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { Wallet } from './entities/wallet.entity.js';
import { WagerTransaction } from './entities/wager-transaction.entity.js';
import { WalletLedgerEntry } from './entities/wallet-ledger-entry.entity.js';
import { CreateWalletDto } from './dto/create-wallet.dto.js';
import { Money } from '../common/domain/money.js';

@Injectable()
export class WalletsService {
  constructor(private readonly em: EntityManager) {}

  async create(dto: CreateWalletDto): Promise<Wallet> {
    const initialBalance = Money.from({
      amount: dto.initialBalance ?? '0.00',
      currency: dto.currency,
    });

    if (initialBalance.isNegative()) {
      throw new ConflictException(
        'O saldo inicial não pode ser negativo.',
      );
    }

    try {
      return await this.em.transactional(async (tx) => {
        const existing = await tx.findOne(Wallet, {
          playerId: dto.playerId,
          currency: dto.currency,
        });

        if (existing) {
          throw new ConflictException(
            'Já existe uma carteira para este jogador e moeda.',
          );
        }

        const walletId = randomUUID();
        const now = new Date();

        const wallet = tx.create(Wallet, {
          id: walletId,
          playerId: dto.playerId,
          currency: dto.currency,
          balance: initialBalance.toJSON().amount,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });

        tx.persist(wallet);
          await tx.flush();

          if (initialBalance.isPositive()) {
          const transaction = tx.create(WagerTransaction, {
            id: randomUUID(),
            providerId: 'internal',
            externalTransactionId: `opening:${walletId}`,
            idempotencyKey: `opening:${walletId}`,
            payloadHash: '0'.repeat(64),
            walletId,
            playerId: dto.playerId,
            roundId: 'internal',
            gameId: 'internal',
            kind: 'OPENING',
            amount: initialBalance.toJSON().amount,
            currency: dto.currency,
            status: 'PROCESSED',
            createdAt: now,
            processedAt: now,
          });

          tx.persist(transaction);

            await tx.flush();

            tx.persist(tx.create(WalletLedgerEntry, {
            id: randomUUID(),
            walletId,
            transactionId: transaction.id,
            direction: 'CREDIT',
            amount: initialBalance.toJSON().amount,
            currency: dto.currency,
            balanceBefore: '0.00',
            balanceAfter: initialBalance.toJSON().amount,
            createdAt: now,
          }));
        }

        await tx.flush();

        return wallet;
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        throw error;
      }

      if (
        error instanceof Error &&
        (error.name === 'UniqueConstraintViolationException' ||
          error.message.includes('wallets_player_currency_unique'))
      ) {
        throw new ConflictException(
          'Já existe uma carteira para este jogador e moeda.',
        );
      }

      throw error;
    }
  }

  async findById(id: string): Promise<Wallet> {
    const wallet = await this.em.findOne(Wallet, { id });

    if (!wallet) {
      throw new NotFoundException('Carteira não encontrada.');
    }

    return wallet;
  }
  
  async findLedger(
    walletId: string,
    page = 1,
    limit = 20,
  ): Promise<{
    items: WalletLedgerEntry[];
    total: number;
    page: number;
    limit: number;
  }> {
    await this.findById(walletId);

    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));

    const [items, total] = await this.em.findAndCount(
      WalletLedgerEntry,
      { walletId },
      {
        orderBy: { createdAt: 'DESC', id: 'DESC' },
        limit: safeLimit,
        offset: (safePage - 1) * safeLimit,
      },
    );

    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

}
