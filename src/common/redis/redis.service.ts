import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    const redisUriString =
      this.configService.get<string>('REDIS_URL') ||
      process.env.REDIS_URL ||
      this.configService.get<string>('REDISCLOUD_URL') ||
      process.env.REDISCLOUD_URL ||
      'redis://localhost:6379';

    this.client = new Redis(redisUriString, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: false,
      tls: redisUriString.startsWith('rediss://')
        ? {
            rejectUnauthorized: false,
          }
        : undefined,
    });

    this.client.on('ready', () => {
      this.logger.log('Redis client ready');
    });

    this.client.on('error', (error) => {
      this.logger.error(`Redis client error: ${error.message}`);
    });
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  getClient(): Redis {
    return this.client;
  }
}
