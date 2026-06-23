import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';
import { SchedulesModule } from '../schedules/schedules.module'; // Importamos el módulo de Schedules
import { GuardiansModule } from '../guardians/guardians.module';
import { Reservation, ReservationSchema } from './entities/reservation.entity';
import { MailModule } from '../mail/mail.module';
import { WspMetaModule } from '../wsp-meta/wsp-meta.module';
import { BullModule } from '@nestjs/bullmq';
import { ReservationProcessor } from './reservations.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'reservation-queue',
    }),
    MongooseModule.forFeature([{ name: Reservation.name, schema: ReservationSchema }]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET', 'dev-secret-change-me'),
      }),
    }),
    SchedulesModule, // Esto nos da acceso a inyectar el ScheduleModel en ReservationsService
    GuardiansModule,
    MailModule,
    WspMetaModule,
  ],
  controllers: [ReservationsController],
  providers: [ReservationsService, ReservationProcessor],
})
export class ReservationsModule {}
