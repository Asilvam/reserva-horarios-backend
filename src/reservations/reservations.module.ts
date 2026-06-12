import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';
import { SchedulesModule } from '../schedules/schedules.module'; // Importamos el módulo de Schedules
import { GuardiansModule } from '../guardians/guardians.module';
import { Reservation, ReservationSchema } from './entities/reservation.entity';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Reservation.name, schema: ReservationSchema }]),
    SchedulesModule, // Esto nos da acceso a inyectar el ScheduleModel en ReservationsService
    GuardiansModule,
  ],
  controllers: [ReservationsController],
  providers: [ReservationsService],
})
export class ReservationsModule {}
