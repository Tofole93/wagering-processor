import { Entity, PrimaryKey, Property, Index } from '@mikro-orm/core';

@Entity({ tableName: 'outbox_messages' })
@Index({
  name: 'outbox_pending_idx',
  properties: ['nextAttemptAt', 'createdAt'],
})
export class OutboxMessage {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Property({ fieldName: 'event_type', type: 'text' })
  eventType!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ fieldName: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Property({ type: 'integer', default: 0 })
  attempts = 0;

  @Property({
    fieldName: 'next_attempt_at',
    type: 'timestamptz',
    nullable: true,
  })
  nextAttemptAt?: Date | null;

  @Property({
    fieldName: 'published_at',
    type: 'timestamptz',
    nullable: true,
  })
  publishedAt?: Date | null;

  @Property({
    fieldName: 'created_at',
    type: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt!: Date;
}