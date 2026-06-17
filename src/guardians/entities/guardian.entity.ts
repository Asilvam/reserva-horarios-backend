import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema()
export class Dependent {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  rut: string;

  @Prop({ required: true })
  age: number;
}

export const DependentSchema = SchemaFactory.createForClass(Dependent);

@Schema({ timestamps: true })
export class Guardian extends Document {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, unique: true })
  rut: string;

  @Prop({ required: true })
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

  @Prop({ type: [DependentSchema], default: [] })
  dependents: Dependent[];

  @Prop({ required: false, default: false })
  acceptMarketing?: boolean;

  @Prop({ required: false, default: false })
  acceptDataTerms?: boolean;
}

export const GuardianSchema = SchemaFactory.createForClass(Guardian);
