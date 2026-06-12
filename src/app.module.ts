import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SchedulesModule } from './schedules/schedules.module';
import { ReservationsModule } from './reservations/reservations.module';
import { DatabaseModule } from './database/database.module';
import { ConfigModule } from '@nestjs/config';
import { GuardiansModule } from './guardians/guardians.module';

@Module({
  imports: [
    DatabaseModule,
    SchedulesModule,
    ReservationsModule,
    ConfigModule.forRoot({
      isGlobal: true, // Makes ConfigModule available globally
    }),
    GuardiansModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
