
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/core';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({
  name: 'ledger_one_entry_per_wallet_transaction',
  properties: ['walletId', 'transactionId'],
})
export class WalletLedgerEntry {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Property({ type: 'text' })
  direction!: LedgerDirection;

  @Property({ columnType: 'numeric(20,2)' })
  amount!: string;

  @Property({ columnType: 'char(3)' })
  currency!: string;

  @Property({
    fieldName: 'balance_before',
    columnType: 'numeric(20,2)',
  })
  balanceBefore!: string;

  @Property({
    fieldName: 'balance_after',
    columnType: 'numeric(20,2)',
  })
  balanceAfter!: string;

  @Property({
    fieldName: 'created_at',
    type: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt!: Date;
}
