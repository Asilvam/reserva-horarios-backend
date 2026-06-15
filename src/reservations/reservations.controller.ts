import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { Request } from 'express';
import { ReservationsService } from './reservations.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { AuthUser } from '../auth/interfaces/auth-user.interface';

type RequestWithUser = Request & { user: AuthUser };

@Controller('reservations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post()
  @Roles(Role.Admin, Role.Guardian)
  @HttpCode(HttpStatus.ACCEPTED)
  create(@Body() createReservationDto: CreateReservationDto, @Req() req: RequestWithUser) {
    return this.reservationsService.enqueueReservation(createReservationDto, req.user);
  }

  @Get()
  @Roles(Role.Admin, Role.Guardian)
  findAll(@Req() req: RequestWithUser) {
    return this.reservationsService.findAll(req.user);
  }

  @Get(':id')
  @Roles(Role.Admin, Role.Guardian)
  findOne(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.reservationsService.findOne(id, req.user);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateReservationDto: UpdateReservationDto) {
    return this.reservationsService.update(+id, updateReservationDto);
  }

  @Delete(':id')
  @Roles(Role.Admin, Role.Guardian)
  remove(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.reservationsService.remove(id, req.user);
  }
}
