
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Wallet } from './entities/wallet.entity.js';
import { WalletLedgerEntry } from './entities/wallet-ledger-entry.entity.js';
import { WalletsService } from './wallets.service.js';
import { WalletsController } from './wallets.controller.js';

@Module({
  imports: [MikroOrmModule.forFeature([Wallet, WalletLedgerEntry])],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
