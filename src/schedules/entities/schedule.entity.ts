import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class Schedule extends Document {
  @Prop({ required: true })
  startTime: Date; // Ej: 2026-06-12T10:00:00.000Z

  @Prop({ required: true })
  durationMinutes: number; // Ej: 30

  @Prop({ required: true })
  totalCapacity: number; // Ej: 50

  @Prop({ required: true })
  availableSpots: number; // Se inicializa igual a totalCapacity

  @Prop({ required: true })
  maxDependentsPerReservation: number; // El límite "X" de cargas por reserva
}

export const ScheduleSchema = SchemaFactory.createForClass(Schedule);

ScheduleSchema.index({ startTime: 1 }, { unique: true });
