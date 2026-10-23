import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { LockMode, UniqueConstraintViolationException } from "@mikro-orm/core";
import { randomUUID, createHash } from "node:crypto";
import { Wallet } from "../wallets/entities/wallet.entity.js";
import { WagerTransaction } from "../wallets/entities/wager-transaction.entity.js";
import { WalletLedgerEntry } from "../wallets/entities/wallet-ledger-entry.entity.js";
import { Money } from "../common/domain/money.js";
import { SubmitWagerDto } from "./dto/submit-wager.dto.js";
import { OutboxMessage } from "../messaging/entities/outbox-message.entity.js";

export interface SubmitWagerResult {
  transaction: WagerTransaction;
  balance: {
    amount: string;
    currency: string;
  };
  idempotentReplay: boolean;
}

@Injectable()
export class WagersService {
  constructor(private readonly em: EntityManager) {}

  async submit(dto: SubmitWagerDto): Promise<WagerTransaction> {
    const result = await this.submitWithResult(dto);
    return result.transaction;
  }

  async submitWithResult(dto: SubmitWagerDto): Promise<SubmitWagerResult> {
    const payloadHash = createHash("sha256")
      .update(
        JSON.stringify({
          providerId: dto.providerId,
          externalTransactionId: dto.externalTransactionId,
          walletId: dto.walletId,
          playerId: dto.playerId,
          roundId: dto.roundId,
          gameId: dto.gameId,
          kind: dto.kind,
          amount: dto.amount,
          currency: dto.currency,
          referenceExternalTransactionId:
            dto.referenceExternalTransactionId ?? null,
        }),
      )
      .digest("hex");

    try {
      return await this.em.transactional(async (tx) => {
        const existing = await tx.findOne(WagerTransaction, {
          idempotencyKey: dto.idempotencyKey,
        });

        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            throw new ConflictException(
              "A chave de idempotência já foi usada com outro conteúdo.",
            );
          }

          if (existing.status !== "PENDING_REFERENCE") {
            const ledgerEntry = await tx.findOne(WalletLedgerEntry, {
              walletId: existing.walletId,
              transactionId: existing.id,
            });

            const wallet = ledgerEntry
              ? null
              : await tx.findOne(Wallet, { id: existing.walletId });

            return {
              transaction: existing,
              balance: {
                amount: ledgerEntry?.balanceAfter ?? wallet?.balance ?? "0.00",
                currency: existing.currency,
              },
              idempotentReplay: true,
            };
          }
        }

        const wallet = await tx.findOne(
          Wallet,
          { id: dto.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (!wallet) {
          throw new NotFoundException("Carteira não encontrada.");
        }

        if (
          wallet.playerId !== dto.playerId ||
          wallet.currency !== dto.currency
        ) {
          throw new ConflictException(
            "A carteira não corresponde ao jogador ou à moeda informados.",
          );
        }

        let referenceTransaction: WagerTransaction | null = null;

        if (dto.kind === "REFUND" || dto.kind === "ROLLBACK") {
          if (!dto.referenceExternalTransactionId) {
            throw new ConflictException(
              "A transação de referência é obrigatória.",
            );
          }

          const reference = await tx.findOne(WagerTransaction, {
            providerId: dto.providerId,
            externalTransactionId: dto.referenceExternalTransactionId,
          });

          referenceTransaction = reference;

          if (!reference) {
            const pendingTransaction = tx.create(WagerTransaction, {
              id: randomUUID(),
              providerId: dto.providerId,
              externalTransactionId: dto.externalTransactionId,
              idempotencyKey: dto.idempotencyKey,
              payloadHash,
              walletId: wallet.id,
              playerId: dto.playerId,
              roundId: dto.roundId,
              gameId: dto.gameId,
              kind: dto.kind,
              amount: dto.amount,
              currency: dto.currency,
              referenceExternalTransactionId:
                dto.referenceExternalTransactionId,
              referenceTransactionId: null,
              status: "PENDING_REFERENCE",
              failureCode: "REFERENCE_NOT_FOUND",
              createdAt: new Date(),
            });

            tx.persist(pendingTransaction);
            const pendingReferenceEvent = tx.create(OutboxMessage, {
              id: randomUUID(),
              aggregateId: pendingTransaction.id,
              eventType: "WagerTransactionPendingReference",
              payload: {
                transactionId: pendingTransaction.id,
                providerId: pendingTransaction.providerId,
                externalTransactionId:
                  pendingTransaction.externalTransactionId,
                walletId: pendingTransaction.walletId,
                playerId: pendingTransaction.playerId,
                kind: pendingTransaction.kind,
                amount: pendingTransaction.amount,
                currency: pendingTransaction.currency,
                status: pendingTransaction.status,
                referenceExternalTransactionId:
                  pendingTransaction.referenceExternalTransactionId,
              },
              occurredAt: pendingTransaction.createdAt,
              attempts: 0,
              nextAttemptAt: null,
              publishedAt: null,
              createdAt: pendingTransaction.createdAt,
            });
            tx.persist(pendingReferenceEvent);
            await tx.flush();

            return {
              transaction: pendingTransaction,
              balance: {
                amount: wallet.balance,
                currency: wallet.currency,
              },
              idempotentReplay: false,
            };
          }

          const existingReversal = await tx.findOne(WagerTransaction, {
            providerId: dto.providerId,
            referenceExternalTransactionId: dto.referenceExternalTransactionId,
            kind: dto.kind,
          });

          if (
            existingReversal &&
            existingReversal.id !== existing?.id &&
            existingReversal.status !== "REJECTED"
          ) {
            throw new ConflictException(
              "Já existe uma reversão para essa transação.",
            );
          }

          const eligibleKind =
            dto.kind === "REFUND"
              ? reference.kind === "BET"
              : ["BET", "WIN", "REFUND"].includes(reference.kind);

          if (
            reference.status !== "PROCESSED" ||
            !eligibleKind ||
            reference.walletId !== dto.walletId ||
            reference.playerId !== dto.playerId ||
            reference.currency !== dto.currency ||
            reference.roundId !== dto.roundId ||
            reference.amount !== dto.amount
          ) {
            throw new ConflictException(
              dto.kind === "REFUND"
                ? "A transação original não é elegível para REFUND."
                : "A transação original não é elegível para ROLLBACK.",
            );
          }
        }

        const amount = Money.from({
          amount: dto.amount,
          currency: dto.currency,
        });

        if (!amount.isPositive()) {
          throw new ConflictException(
            "O valor da transação deve ser maior que zero.",
          );
        }

        let balanceAfter = Money.from({
          amount: wallet.balance,
          currency: wallet.currency,
        });

        let direction: "DEBIT" | "CREDIT" | null = null;

        if (dto.kind === "BET") {
          const newBalance = balanceAfter.subtract(amount);

          if (newBalance.isNegative()) {
            const rejectedTransaction = tx.create(WagerTransaction, {
              id: randomUUID(),
              providerId: dto.providerId,
              externalTransactionId: dto.externalTransactionId,
              idempotencyKey: dto.idempotencyKey,
              payloadHash,
              walletId: wallet.id,
              playerId: wallet.playerId,
              roundId: dto.roundId,
              gameId: dto.gameId,
              kind: dto.kind,
              amount: amount.toJSON().amount,
              currency: dto.currency,
              referenceExternalTransactionId:
                dto.referenceExternalTransactionId ?? null,
              referenceTransactionId: null,
              status: "REJECTED",
              failureCode: "INSUFFICIENT_BALANCE",
              createdAt: new Date(),
              processedAt: new Date(),
            });

            tx.persist(rejectedTransaction);
            const rejectionEvent = tx.create(OutboxMessage, {
              id: randomUUID(),
              aggregateId: rejectedTransaction.id,
              eventType: "WagerTransactionRejected",
              payload: {
                transactionId: rejectedTransaction.id,
                providerId: rejectedTransaction.providerId,
                externalTransactionId:
                  rejectedTransaction.externalTransactionId,
                walletId: rejectedTransaction.walletId,
                playerId: rejectedTransaction.playerId,
                kind: rejectedTransaction.kind,
                amount: rejectedTransaction.amount,
                currency: rejectedTransaction.currency,
                status: rejectedTransaction.status,
                failureCode: rejectedTransaction.failureCode,
                balance: wallet.balance,
                version: wallet.version,
              },
              occurredAt: rejectedTransaction.createdAt,
              attempts: 0,
              nextAttemptAt: null,
              publishedAt: null,
              createdAt: rejectedTransaction.createdAt,
            });
            tx.persist(rejectionEvent);
            await tx.flush();

            return {
              transaction: rejectedTransaction,
              balance: {
                amount: wallet.balance,
                currency: wallet.currency,
              },
              idempotentReplay: false,
            };
          }

          balanceAfter = newBalance;
          direction = "DEBIT";
        } else if (dto.kind === "WIN" || dto.kind === "REFUND") {
          balanceAfter = balanceAfter.add(amount);
          direction = "CREDIT";
        } else if (dto.kind === "ROLLBACK") {
          const reference = referenceTransaction;

          if (!reference) {
            throw new ConflictException(
              "A transação original não é elegível para ROLLBACK.",
            );
          }

          if (reference.kind === "BET") {
            balanceAfter = balanceAfter.add(amount);
            direction = "CREDIT";
          } else if (reference.kind === "WIN" || reference.kind === "REFUND") {
            const newBalance = balanceAfter.subtract(amount);

            if (newBalance.isNegative()) {
              const rejectedTransaction = tx.create(WagerTransaction, {
                id: randomUUID(),
                providerId: dto.providerId,
                externalTransactionId: dto.externalTransactionId,
                idempotencyKey: dto.idempotencyKey,
                payloadHash,
                walletId: wallet.id,
                playerId: wallet.playerId,
                roundId: dto.roundId,
                gameId: dto.gameId,
                kind: dto.kind,
                amount: amount.toJSON().amount,
                currency: dto.currency,
                referenceExternalTransactionId:
                  dto.referenceExternalTransactionId ?? null,
                referenceTransactionId: reference.id,
                status: "REJECTED",
                failureCode: "INSUFFICIENT_BALANCE",
                createdAt: new Date(),
                processedAt: new Date(),
              });

              tx.persist(rejectedTransaction);
              const rejectionEvent = tx.create(OutboxMessage, {
                id: randomUUID(),
                aggregateId: rejectedTransaction.id,
                eventType: "WagerTransactionRejected",
                payload: {
                  transactionId: rejectedTransaction.id,
                  providerId: rejectedTransaction.providerId,
                  externalTransactionId:
                    rejectedTransaction.externalTransactionId,
                  walletId: rejectedTransaction.walletId,
                  playerId: rejectedTransaction.playerId,
                  kind: rejectedTransaction.kind,
                  amount: rejectedTransaction.amount,
                  currency: rejectedTransaction.currency,
                  status: rejectedTransaction.status,
                  failureCode: rejectedTransaction.failureCode,
                  balance: wallet.balance,
                  version: wallet.version,
                },
                occurredAt: rejectedTransaction.createdAt,
                attempts: 0,
                nextAttemptAt: null,
                publishedAt: null,
                createdAt: rejectedTransaction.createdAt,
              });
              tx.persist(rejectionEvent);
              await tx.flush();

              return {
                transaction: rejectedTransaction,
                balance: {
                  amount: wallet.balance,
                  currency: wallet.currency,
                },
                idempotentReplay: false,
              };
            }

            balanceAfter = newBalance;
            direction = "DEBIT";
          } else {
            throw new ConflictException(
              "O tipo da transação original não permite ROLLBACK.",
            );
          }
        }

        const transaction =
          existing?.status === "PENDING_REFERENCE"
            ? Object.assign(existing, {
                amount: amount.toJSON().amount,
                referenceTransactionId: referenceTransaction?.id ?? null,
                status: "PROCESSED",
                failureCode: null,
                processedAt: new Date(),
              })
            : tx.create(WagerTransaction, {
                id: randomUUID(),
                providerId: dto.providerId,
                externalTransactionId: dto.externalTransactionId,
                idempotencyKey: dto.idempotencyKey,
                payloadHash,
                walletId: wallet.id,
                playerId: wallet.playerId,
                roundId: dto.roundId,
                gameId: dto.gameId,
                kind: dto.kind,
                amount: amount.toJSON().amount,
                currency: dto.currency,
                referenceExternalTransactionId:
                  dto.referenceExternalTransactionId ?? null,
                referenceTransactionId: referenceTransaction?.id ?? null,
                status: "PROCESSED",
                createdAt: new Date(),
                processedAt: new Date(),
              });

        tx.persist(transaction);

        await tx.flush();

        if (direction) {
          const balanceBefore = Money.from({
            amount: wallet.balance,
            currency: wallet.currency,
          });

          wallet.balance = balanceAfter.toJSON().amount;
          wallet.version += 1;
          wallet.updatedAt = new Date();

          tx.persist(
            tx.create(WalletLedgerEntry, {
              id: randomUUID(),
              walletId: wallet.id,
              transactionId: transaction.id,
              direction,
              amount: amount.toJSON().amount,
              currency: dto.currency,
              balanceBefore: balanceBefore.toJSON().amount,
              balanceAfter: balanceAfter.toJSON().amount,
              createdAt: new Date(),
            }),
          );
        }

        const outboxMessage = tx.create(OutboxMessage, {
          id: randomUUID(),
          aggregateId: wallet.id,
          eventType: "WAGER_PROCESSED",
          payload: {
            transactionId: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            kind: transaction.kind,
            amount: transaction.amount,
            currency: transaction.currency,
            status: transaction.status,
            balance: wallet.balance,
            version: wallet.version,
          },
          occurredAt: new Date(),
          attempts: 0,
          nextAttemptAt: null,
          publishedAt: null,
          createdAt: new Date(),
        });

        tx.persist(outboxMessage);
        await tx.flush();

        return {
          transaction,
          balance: {
            amount: wallet.balance,
            currency: wallet.currency,
          },
          idempotentReplay: false,
        };
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        const existing = await this.em.findOne(WagerTransaction, {
          idempotencyKey: dto.idempotencyKey,
        });

        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            throw new ConflictException(
              "A chave de idempotência já foi usada com outro conteúdo.",
            );
          }

          const ledgerEntry = await this.em.findOne(WalletLedgerEntry, {
            walletId: existing.walletId,
            transactionId: existing.id,
          });

          const wallet = ledgerEntry
            ? null
            : await this.em.findOne(Wallet, { id: existing.walletId });

          return {
            transaction: existing,
            balance: {
              amount: ledgerEntry?.balanceAfter ?? wallet?.balance ?? "0.00",
              currency: existing.currency,
            },
            idempotentReplay: true,
          };
        }

        throw new ConflictException(
          "O ID externo da transação já foi utilizado por este provedor.",
        );
      }

      throw error;
    }
  }
}
