import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Reservation extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Schedule', required: true })
  scheduleId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Guardian', required: true })
  guardianId: Types.ObjectId;

  @Prop({ required: true, default: true })
  guardianParticipates: boolean;

  @Prop({ type: [String], default: [] })
  attendingDependents: string[];

  @Prop({ required: true })
  totalSpotsConsumed: number;
}

export const ReservationSchema = SchemaFactory.createForClass(Reservation);
