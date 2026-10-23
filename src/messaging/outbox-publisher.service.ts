import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import {
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { OutboxMessage } from './entities/outbox-message.entity.js';

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private timer?: ReturnType<typeof setInterval>;
  private isPublishing = false;

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.publishPending().catch((error: unknown) => {
        this.logger.error(
          'Falha ao processar a outbox',
          error instanceof Error ? error.stack : String(error),
        );
      });
    }, 5000);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
  private readonly sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });

  constructor(private readonly em: EntityManager) {}

  async publishPending(limit = 10): Promise<number> {
    if (this.isPublishing) {
      return 0;
    }

    this.isPublishing = true;
    try {
      const em = this.em.fork();
      const queueUrl =
        process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL ??
        process.env.SQS_QUEUE_URL ??
        'http://localhost:4566/000000000000/wager-transactions.fifo';

      const messages = await em.find(
        OutboxMessage,
        { publishedAt: null },
        {
          orderBy: { createdAt: 'ASC' },
          limit,
        },
      );

      let published = 0;

      for (const message of messages) {
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: JSON.stringify({
                id: message.id,
                aggregateId: message.aggregateId,
                eventType: message.eventType,
                payload: message.payload,
                occurredAt: message.occurredAt.toISOString(),
              }),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
            }),
          );

          await em.nativeUpdate(
            OutboxMessage,
            { id: message.id, publishedAt: null },
            { publishedAt: new Date() },
          );

          published++;
        } catch (error) {
          this.logger.error(
            `Falha ao publicar evento ${message.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }

      return published;
    } finally {
      this.isPublishing = false;
    }
  }
}
