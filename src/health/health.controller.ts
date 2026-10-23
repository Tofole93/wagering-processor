
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { SQSClient, ListQueuesCommand } from '@aws-sdk/client-sqs';

@Controller('health')
export class HealthController {
  private readonly sqs: SQSClient;

  constructor(private readonly em: EntityManager) {
    this.sqs = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    try {
      await this.em.getConnection().execute('select 1');
      await this.sqs.send(new ListQueuesCommand({ MaxResults: 1 }));
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
  }
}
