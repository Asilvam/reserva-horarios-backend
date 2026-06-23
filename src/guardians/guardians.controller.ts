import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { GuardiansService } from './guardians.service';
import { CreateGuardianDto } from './dto/create-guardian.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';

@Controller('guardians')
export class GuardiansController {
  constructor(private readonly guardiansService: GuardiansService) {}

  @Post()
  create(@Body() createGuardianDto: CreateGuardianDto) {
    return this.guardiansService.create(createGuardianDto);
  }

  @Get('by-rut/:rut')
  findByRut(@Param('rut') rut: string) {
    return this.guardiansService.findByRut(rut);
  }

  @Get('check-email/:email')
  checkEmailAvailability(@Param('email') email: string) {
    return this.guardiansService.checkEmailAvailability(email);
  }

  @Get('check-phone/:phone')
  checkPhoneAvailability(@Param('phone') phone: string) {
    return this.guardiansService.checkPhoneAvailability(phone);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.Guardian)
  findAll() {
    return this.guardiansService.findAll();
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.Guardian)
  findById(@Param('id') id: string) {
    return this.guardiansService.findById(id);
  }
}
