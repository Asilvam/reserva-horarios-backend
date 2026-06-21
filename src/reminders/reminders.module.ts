import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RemindersCron } from './reminders.cron';
import { RemindersProcessor } from './reminders.processor';
import { Reservation, ReservationSchema } from '../reservations/entities/reservation.entity';
import { MailModule } from '../mail/mail.module';
import { WspMetaModule } from '../wsp-meta/wsp-meta.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { GuardiansModule } from '../guardians/guardians.module';

@Module({
  imports: [
    ScheduleModule.forRoot(), // Habilita el soporte para Cron Jobs en el backend
    BullModule.registerQueue({
      name: 'reminders-queue',
    }),
    MongooseModule.forFeature([{ name: Reservation.name, schema: ReservationSchema }]),
    MailModule,
    WspMetaModule,
    SchedulesModule,
    GuardiansModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET', 'dev-secret-change-me'),
      }),
    }),
  ],
  providers: [RemindersCron, RemindersProcessor],
  exports: [RemindersCron],
})
export class RemindersModule {}
