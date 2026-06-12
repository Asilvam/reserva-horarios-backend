import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { GuardiansService } from './guardians.service';
import { CreateGuardianDto } from './dto/create-guardian.dto';

@Controller('guardians')
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
