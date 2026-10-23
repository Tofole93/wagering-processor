import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
@Unique({
  name: 'wallets_player_currency_unique',
  properties: ['playerId', 'currency'],
})
export class Wallet {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ columnType: 'char(3)' })
  currency!: string;

  @Property({ columnType: 'numeric(20,2)', default: '0.00' })
  balance!: string;

  @Property({ default: 1 })
  version!: number;

  @Property({ fieldName: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt!: Date;

  @Property({ fieldName: 'updated_at', type: 'timestamptz', defaultRaw: 'now()' })
  updatedAt!: Date;
}