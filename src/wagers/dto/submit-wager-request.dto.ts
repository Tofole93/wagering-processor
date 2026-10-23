import {
  IsIn,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class MoneyRequestDto {
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)\.\d{2}$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class SubmitWagerRequestDto {
  @IsString()
  @MaxLength(100)
  providerId!: string;

  @IsString()
  @MaxLength(200)
  externalTransactionId!: string;

  @IsUUID()
  walletId!: string;

  @IsUUID()
  playerId!: string;

  @IsString()
  @MaxLength(100)
  roundId!: string;

  @IsString()
  @MaxLength(100)
  gameId!: string;

  @IsIn(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])
  kind!: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

  @IsObject()
  @ValidateNested()
  @Type(() => MoneyRequestDto)
  money!: MoneyRequestDto;

  @ValidateIf(
    (dto: SubmitWagerRequestDto) =>
      dto.kind === 'REFUND' || dto.kind === 'ROLLBACK',
  )
  @IsString()
  @MaxLength(200)
  referenceExternalTransactionId?: string;
}
