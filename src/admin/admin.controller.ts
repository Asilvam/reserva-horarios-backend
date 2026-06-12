import {
  Controller,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
export class AdminController {
  constructor(
    private readonly usersService: UsersService,
    private readonly mailService: MailService,
  ) {}

  @Post('users/:id/reset-password')
  async resetPassword(@Param('id') id: string) {
    const result = await this.usersService.resetPasswordById(id);

    if (!result) {
      throw new NotFoundException('Usuario no encontrado');
    }

    await this.mailService.sendResetPassword(result.user.email, result.plainPassword);

    return {
      message: 'Contrasena regenerada y enviada por correo',
    };
  }
}
