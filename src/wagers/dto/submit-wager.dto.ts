
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class SubmitWagerDto {
  @IsString()
  @MaxLength(100)
  providerId!: string;

  @IsString()
  @MaxLength(200)
  externalTransactionId!: string;

  @IsString()
  @MaxLength(200)
  idempotencyKey!: string;

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

  @IsString()
  @Matches(/^(?:0|[1-9]\d*)\.\d{2}$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @ValidateIf(
    (dto: SubmitWagerDto) =>
      dto.kind === 'REFUND' || dto.kind === 'ROLLBACK',
  )
  @IsString()
  @MaxLength(200)
  referenceExternalTransactionId?: string;
}
