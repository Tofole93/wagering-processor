import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { SubmitWagerDto } from './dto/submit-wager.dto.js';
import { SubmitWagerRequestDto } from './dto/submit-wager-request.dto.js';
import { WagersService } from './wagers.service.js';

@Controller()
export class WagersController {
  constructor(private readonly wagersService: WagersService) { }

  @Post('wagering/transactions')
  @HttpCode(HttpStatus.OK)
  async submit(
    @Body() request: SubmitWagerRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException(
        'O cabeçalho Idempotency-Key é obrigatório.',
      );
    }

    const dto: SubmitWagerDto = {
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
      idempotencyKey: idempotencyKey.trim(),
      walletId: request.walletId,
      playerId: request.playerId,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: request.kind,
      amount: request.money.amount,
      currency: request.money.currency,
      ...(request.referenceExternalTransactionId !== undefined
        ? {
          referenceExternalTransactionId:
            request.referenceExternalTransactionId,
        }
        : {}),
    };

    const result = await this.wagersService.submitWithResult(dto);

    return {
      transactionId: result.transaction.id,
      status: result.transaction.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
    };
  }
}