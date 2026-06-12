import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GuardiansService } from './guardians.service';
import { GuardiansController } from './guardians.controller';
import { Guardian, GuardianSchema } from './entities/guardian.entity';

@Module({
  imports: [MongooseModule.forFeature([{ name: Guardian.name, schema: GuardianSchema }])],
  controllers: [GuardiansController],
  providers: [GuardiansService],
  exports: [MongooseModule, GuardiansService], // Exportamos por si otro módulo necesita validar a un Guardian
})
export class GuardiansModule {}
