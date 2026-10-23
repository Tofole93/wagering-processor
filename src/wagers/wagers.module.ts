
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Wallet } from '../wallets/entities/wallet.entity.js';
import { WagerTransaction } from '../wallets/entities/wager-transaction.entity.js';
import { WalletLedgerEntry } from '../wallets/entities/wallet-ledger-entry.entity.js';
import { WagersService } from './wagers.service.js';
import { WagersController } from './wagers.controller.js';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      Wallet,
      WagerTransaction,
      WalletLedgerEntry,
    ]),
  ],
  controllers: [WagersController],
  providers: [WagersService],
  exports: [WagersService],
})
export class WagersModule {}
