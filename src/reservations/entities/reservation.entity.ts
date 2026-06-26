import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

@Schema({ _id: false })
export class AttendingDependent {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  age: number;
}

export const AttendingDependentSchema = SchemaFactory.createForClass(AttendingDependent);

@Schema({ timestamps: true })
export class Reservation extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Schedule', required: true })
  scheduleId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Guardian', required: true })
  guardianId: Types.ObjectId;

  @Prop({ required: true, default: true })
  guardianParticipates: boolean;

  @Prop({ type: [AttendingDependentSchema], default: [] })
  attendingDependents: AttendingDependent[];

  @Prop({ type: MongooseSchema.Types.Mixed })
  metadata?: Record<string, unknown>;

  @Prop({ required: true })
  totalSpotsConsumed: number;

  @Prop({ required: true })
  reservationDay: Date;

  @Prop({ required: true, default: false })
  isCheckedIn: boolean;

  @Prop({ required: false })
  checkInAt?: Date;

  @Prop({ required: true, default: true })
  state_reserve: boolean;

  @Prop({ required: false })
  eventType?: string;

  @Prop({ required: false, default: null })
  checkMail?: boolean;

  @Prop({ required: false })
  checkMailDate?: Date;

  @Prop({ required: false, default: null })
  checkWsp?: boolean;

  @Prop({ required: false })
  checkWspDate?: Date;

  @Prop({ required: true, default: false })
  reminderMailSent: boolean;

  @Prop({ required: false })
  reminderMailSentAt?: Date;

  @Prop({ required: true, default: false })
  reminderWspSent: boolean;

  @Prop({ required: false })
  reminderWspSentAt?: Date;

  @Prop({ required: true, default: false })
  reminder3hMailSent: boolean;

  @Prop({ required: false })
  reminder3hMailSentAt?: Date;

  @Prop({ required: true, default: false })
  reminder3hWspSent: boolean;

  @Prop({ required: false })
  reminder3hWspSentAt?: Date;
}

export const ReservationSchema = SchemaFactory.createForClass(Reservation);

ReservationSchema.index(
  { guardianId: 1, reservationDay: 1, eventType: 1 },
  {
    unique: true,
    partialFilterExpression: { state_reserve: true },
  },
);
