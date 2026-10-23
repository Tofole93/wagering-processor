import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test';

const sentCommands: Array<{ input: Record<string, unknown> }> = [];

mock.module('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    async send(command: { input: Record<string, unknown> }) {
      sentCommands.push(command);
      return {};
    }
  },
  SendMessageCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));

let OutboxPublisherService: typeof import('../../src/messaging/outbox-publisher.service.js').OutboxPublisherService;

describe('OutboxPublisherService queue URL configuration', () => {
  const originalQueueUrl = process.env.SQS_QUEUE_URL;
  const originalWagerQueueUrl = process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL;

  beforeAll(async () => {
    ({ OutboxPublisherService } = await import(
      '../../src/messaging/outbox-publisher.service.js'
    ));
  });

  beforeEach(() => {
    sentCommands.length = 0;
  });

  afterEach(() => {
    if (originalQueueUrl === undefined) {
      delete process.env.SQS_QUEUE_URL;
    } else {
      process.env.SQS_QUEUE_URL = originalQueueUrl;
    }

    if (originalWagerQueueUrl === undefined) {
      delete process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL;
    } else {
      process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL = originalWagerQueueUrl;
    }
  });

  it('uses the documented queue URL and prefers it over the legacy setting', async () => {
    process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL =
      'http://localstack/queues/documented.fifo';
    process.env.SQS_QUEUE_URL = 'http://localstack/queues/legacy.fifo';

    const service = new OutboxPublisherService({
      fork: () => ({
        find: async () => [
          {
            id: 'outbox-message-id',
            aggregateId: 'wallet-id',
            eventType: 'WAGER_PROCESSED',
            payload: {},
            occurredAt: new Date('2026-10-22T12:00:00.000Z'),
          },
        ],
        nativeUpdate: async () => 1,
      }),
    } as never);

    expect(await service.publishPending()).toBe(1);
    expect(sentCommands[0]?.input.QueueUrl).toBe(
      'http://localstack/queues/documented.fifo',
    );
  });

  it('keeps supporting the legacy queue URL when the documented setting is absent', async () => {
    delete process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL;
    process.env.SQS_QUEUE_URL = 'http://localstack/queues/legacy.fifo';

    const service = new OutboxPublisherService({
      fork: () => ({
        find: async () => [
          {
            id: 'outbox-message-id',
            aggregateId: 'wallet-id',
            eventType: 'WAGER_PROCESSED',
            payload: {},
            occurredAt: new Date('2026-10-22T12:00:00.000Z'),
          },
        ],
        nativeUpdate: async () => 1,
      }),
    } as never);

    expect(await service.publishPending()).toBe(1);
    expect(sentCommands[0]?.input.QueueUrl).toBe(
      'http://localstack/queues/legacy.fifo',
    );
  });

  it('uses the local default when both queue URL settings are absent', async () => {
    delete process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL;
    delete process.env.SQS_QUEUE_URL;

    const service = new OutboxPublisherService({
      fork: () => ({
        find: async () => [
          {
            id: 'outbox-message-id',
            aggregateId: 'wallet-id',
            eventType: 'WAGER_PROCESSED',
            payload: {},
            occurredAt: new Date('2026-10-22T12:00:00.000Z'),
          },
        ],
        nativeUpdate: async () => 1,
      }),
    } as never);

    expect(await service.publishPending()).toBe(1);
    expect(sentCommands[0]?.input.QueueUrl).toBe(
      'http://localhost:4566/000000000000/wager-transactions.fifo',
    );
  });
});
