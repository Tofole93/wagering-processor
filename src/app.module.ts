
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { HealthController } from './health/health.controller.js';
import { Wallet } from './wallets/entities/wallet.entity.js';
import { WalletsModule } from './wallets/wallets.module.js';
import { WagerTransaction } from './wallets/entities/wager-transaction.entity.js';
import { WalletLedgerEntry } from './wallets/entities/wallet-ledger-entry.entity.js';
import { WagersModule } from './wagers/wagers.module.js';
import { OutboxMessage } from './messaging/entities/outbox-message.entity.js';
import { OutboxPublisherService } from './messaging/outbox-publisher.service.js';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      driver: PostgreSqlDriver,
      clientUrl:
        process.env.DATABASE_URL ??
        'postgresql://wagering:wagering@localhost:5432/wagering',
      entities: [Wallet, WagerTransaction, WalletLedgerEntry, OutboxMessage],
      extensions: [Migrator],
      debug: process.env.NODE_ENV === 'development',
    }),
    WalletsModule,
    WagersModule,
  ],
  controllers: [HealthController],
  providers: [OutboxPublisherService],
})
export class AppModule {}
