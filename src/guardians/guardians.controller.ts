import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { GuardiansService } from './guardians.service';
import { CreateGuardianDto } from './dto/create-guardian.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';

@Controller('guardians')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
export class GuardiansController {
  constructor(private readonly guardiansService: GuardiansService) {}

  @Post()
  create(@Body() createGuardianDto: CreateGuardianDto) {
    return this.guardiansService.create(createGuardianDto);
  }

  @Get()
  findAll() {
    return this.guardiansService.findAll();
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.guardiansService.findById(id);
  }
}
