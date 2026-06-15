import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema()
export class Dependent {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  rut: string;
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

  @Prop({ type: [DependentSchema], default: [] })
  dependents: Dependent[];
}

export const GuardianSchema = SchemaFactory.createForClass(Guardian);
