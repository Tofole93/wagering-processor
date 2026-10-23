
import 'reflect-metadata';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Wallet } from './src/wallets/entities/wallet.entity.js';
import { WagerTransaction } from './src/wallets/entities/wager-transaction.entity.js';
import { WalletLedgerEntry } from './src/wallets/entities/wallet-ledger-entry.entity.js';
import { InitialSchemaMigration } from './src/database/migrations/Migration20261020000000.js';
import { OutboxMessage } from './src/messaging/entities/outbox-message.entity.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://wagering:wagering@localhost:5432/wagering';

export default defineConfig({
  clientUrl: databaseUrl,
  entities: [Wallet, WagerTransaction, WalletLedgerEntry, OutboxMessage],
  extensions: [Migrator],
  migrations: {
    migrationsList: [
      {
        name: 'Migration20261020000000',
        class: InitialSchemaMigration,
      },
    ],
    transactional: true,
    allOrNothing: true,
    emit: 'ts',
  },
  debug: process.env.NODE_ENV === 'development',
});
