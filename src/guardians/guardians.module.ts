import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GuardiansService } from './guardians.service';
import { GuardiansController } from './guardians.controller';
import { Guardian, GuardianSchema } from './entities/guardian.entity';
import { UsersModule } from '../users/users.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [MongooseModule.forFeature([{ name: Guardian.name, schema: GuardianSchema }]), UsersModule, MailModule],
  controllers: [GuardiansController],
  providers: [GuardiansService],
  exports: [MongooseModule, GuardiansService], // Exportamos por si otro módulo necesita validar a un Guardian
})
export class GuardiansModule {}
