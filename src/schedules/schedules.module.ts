import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SchedulesService } from './schedules.service';
import { SchedulesController } from './schedules.controller';
import { Schedule, ScheduleSchema } from './entities/schedule.entity';

@Module({
  imports: [MongooseModule.forFeature([{ name: Schedule.name, schema: ScheduleSchema }])],
  controllers: [SchedulesController],
  providers: [SchedulesService],
  exports: [MongooseModule], // Exportamos MongooseModule para que Reservations pueda acceder al modelo Schedule
})
export class SchedulesModule {}
