
import {
  IsString,
  IsUUID,
  Length,
  Matches,
  IsOptional,
} from 'class-validator';

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsOptional()
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)\.\d{2}$/)
  initialBalance?: string;
}
