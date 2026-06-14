import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';
import { SchedulesModule } from '../schedules/schedules.module'; // Importamos el módulo de Schedules
import { GuardiansModule } from '../guardians/guardians.module';
import { Reservation, ReservationSchema } from './entities/reservation.entity';
import { MailModule } from '../mail/mail.module';
import { WspMetaModule } from '../wsp-meta/wsp-meta.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Reservation.name, schema: ReservationSchema }]),
    SchedulesModule, // Esto nos da acceso a inyectar el ScheduleModel en ReservationsService
    GuardiansModule,
    MailModule,
    WspMetaModule,
  ],
  controllers: [ReservationsController],
  providers: [ReservationsService],
})
export class ReservationsModule {}
