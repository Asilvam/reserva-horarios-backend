import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SchedulesModule } from './schedules/schedules.module';
import { ReservationsModule } from './reservations/reservations.module';
import { DatabaseModule } from './database/database.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GuardiansModule } from './guardians/guardians.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { MailModule } from './mail/mail.module';
import { AdminModule } from './admin/admin.module';
import { WspMetaModule } from './wsp-meta/wsp-meta.module';
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    DatabaseModule,
    SchedulesModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = new URL(configService.get<string>('REDIS_URL', 'redis://localhost:6379'));

        return {
          connection: {
            host: redisUrl.hostname,
            port: Number(redisUrl.port),
            password: redisUrl.password,
            // Para Heroku Redis con TLS, descomenta la siguiente línea.
            // tls: { rejectUnauthorized: false },
          },
        };
      },
    }),
    ReservationsModule,
    ConfigModule.forRoot({
      isGlobal: true, // Makes ConfigModule available globally
    }),
    UsersModule,
    AuthModule,
    MailModule,
    WspMetaModule,
    AdminModule,
    GuardiansModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
