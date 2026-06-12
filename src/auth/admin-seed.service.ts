import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';

@Injectable()
export class AdminSeedService implements OnModuleInit {
  private readonly logger = new Logger(AdminSeedService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  async onModuleInit() {
    const email = this.configService.get<string>('ADMIN_EMAIL');
    const password = this.configService.get<string>('ADMIN_PASSWORD');

    if (!email || !password) {
      this.logger.warn('ADMIN_EMAIL o ADMIN_PASSWORD no estan definidos. Seed de admin omitido.');
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await this.usersService.createAdminIfMissing(email, passwordHash);
    this.logger.log(`Admin disponible: ${user.email}`);
  }
}
