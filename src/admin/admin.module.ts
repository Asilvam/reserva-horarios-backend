import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { UsersModule } from '../users/users.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [UsersModule, MailModule],
  controllers: [AdminController],
})
export class AdminModule {}
