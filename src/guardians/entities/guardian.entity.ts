import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class Guardian extends Document {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, unique: true })
  rut: string;

  @Prop({ required: true, unique: true })
  email: string;

  @Prop({ required: true, unique: true })
  phone: string;

  @Prop({ required: false })
  address?: string;

  @Prop({ required: false })
  commune?: string;

  @Prop({ required: false })
  villa?: string;

  @Prop({ required: false })
  emergencyName?: string;

  @Prop({ required: false })
  emergencyPhone?: string;

  @Prop({ required: false, default: false })
  acceptMarketing?: boolean;
}

export const GuardianSchema = SchemaFactory.createForClass(Guardian);
