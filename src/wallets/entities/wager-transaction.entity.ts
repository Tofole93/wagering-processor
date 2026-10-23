
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/core';

export type WagerTransactionKind =
  | 'OPENING'
  | 'BET'
  | 'WIN'
  | 'LOSS'
  | 'REFUND'
  | 'ROLLBACK';

export type WagerTransactionStatus =
  | 'PENDING'
  | 'PENDING_REFERENCE'
  | 'PROCESSED'
  | 'REJECTED'
  | 'FAILED';

@Entity({ tableName: 'wager_transactions' })
@Unique({
  name: 'wager_provider_external_unique',
  properties: ['providerId', 'externalTransactionId'],
})
@Unique({
  name: 'wager_transactions_idempotency_key_key',
  properties: ['idempotencyKey'],
})
export class WagerTransaction {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id', type: 'text' })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', type: 'text' })
  externalTransactionId!: string;

  @Property({
    fieldName: 'idempotency_key',
    type: 'text',
  })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash', columnType: 'char(64)' })
  payloadHash!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ fieldName: 'round_id', type: 'text' })
  roundId!: string;

  @Property({ fieldName: 'game_id', type: 'text' })
  gameId!: string;

  @Property({ type: 'text' })
  kind!: WagerTransactionKind;

  @Property({ columnType: 'numeric(20,2)' })
  amount!: string;

  @Property({ columnType: 'char(3)' })
  currency!: string;

  @Property({
    fieldName: 'reference_external_transaction_id',
    type: 'text',
    nullable: true,
  })
  referenceExternalTransactionId?: string;

  @Property({
    fieldName: 'reference_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  referenceTransactionId?: string;

  @Property({ type: 'text' })
  status!: WagerTransactionStatus;

  @Property({
    fieldName: 'failure_code',
    type: 'text',
    nullable: true,
  })
  failureCode?: string;

  @Property({
    fieldName: 'created_at',
    type: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt!: Date;

  @Property({
    fieldName: 'processed_at',
    type: 'timestamptz',
    nullable: true,
  })
  processedAt?: Date;
}
