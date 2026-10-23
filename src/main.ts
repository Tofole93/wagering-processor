import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableShutdownHooks();

  const port = Number.parseInt(process.env.PORT ?? '3000', 10);

  await app.listen(port, '0.0.0.0');

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'application_started',
      port,
    }),
  );
}

void bootstrap();
