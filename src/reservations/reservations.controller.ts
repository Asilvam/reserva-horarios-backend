import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req, HttpCode, HttpStatus, Header, Res, NotFoundException, Query, BadRequestException } from '@nestjs/common';
import * as express from 'express';
import { ReservationsService } from './reservations.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { AuthUser } from '../auth/interfaces/auth-user.interface';

type RequestWithUser = express.Request & { user: AuthUser };

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Get('check-rut/:rut')
  async checkRut(@Param('rut') rut: string, @Query('eventType') eventType: string) {
    console.log(rut);
    if (!eventType) {
      throw new BadRequestException('eventType query parameter is required');
    }
    return this.reservationsService.checkRutRegistration(rut, eventType);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@Body() createReservationDto: CreateReservationDto, @Req() req: RequestWithUser) {
    const user = req.user;
    return this.reservationsService.enqueueReservation(createReservationDto, user);
  }

  @Get('by-guardian/:guardianId')
  async findByGuardian(@Param('guardianId') guardianId: string) {
    const reservation = await this.reservationsService.findByGuardianId(guardianId);
    if (!reservation) {
      throw new NotFoundException('Reserva no encontrada aún');
    }
    return reservation;
  }

  @Get(':id/qrcode')
  async getQrCode(@Param('id') id: string, @Res() res: express.Response) {
    const buffer = await this.reservationsService.getQrCodeBuffer(id);
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.Guardian)
  findAll(@Req() req: RequestWithUser) {
    return this.reservationsService.findAll(req.user);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.Guardian)
  findOne(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.reservationsService.findOne(id, req.user);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  update(@Param('id') id: string, @Body() updateReservationDto: UpdateReservationDto) {
    return this.reservationsService.update(+id, updateReservationDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.Guardian)
  remove(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.reservationsService.remove(id, req.user);
  }

  @Post(':id/check-in')
  @HttpCode(HttpStatus.OK)
  async performCheckIn(@Param('id') id: string, @Body('pin') pin: string) {
    return this.reservationsService.performCheckIn(id, pin);
  }

  @Post(':id/check-in-details')
  @HttpCode(HttpStatus.OK)
  async getCheckInDetails(@Param('id') id: string, @Body('pin') pin: string) {
    return this.reservationsService.getReservationCheckInDetails(id, pin);
  }

  @Get(':id/check-in')
  @Header('Content-Type', 'text/html')
  renderCheckInHtml() {
    return this.reservationsService.getCheckInHtmlPage();
  }

  @Get(':id/confirm-email')
  @Header('Content-Type', 'text/html')
  confirmEmail(@Param('id') id: string) {
    return this.reservationsService.confirmEmailHtmlPage(id);
  }

  @Get(':id/cancel-email')
  @Header('Content-Type', 'text/html')
  cancelEmail(@Param('id') id: string) {
    return this.reservationsService.cancelEmailHtmlPage(id);
  }
}
