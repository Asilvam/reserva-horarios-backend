import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req, HttpCode, HttpStatus, Header, Res, NotFoundException, Query, BadRequestException } from '@nestjs/common';
import * as express from 'express';
import { JwtService } from '@nestjs/jwt';
import { ReservationsService } from './reservations.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { GetPatinesDaySummaryDto } from './dto/get-patines-day-summary.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { AuthUser } from '../auth/interfaces/auth-user.interface';

type RequestWithUser = express.Request & { user: AuthUser };

@Controller('reservations')
export class ReservationsController {
  constructor(
    private readonly reservationsService: ReservationsService,
    private readonly jwtService: JwtService,
  ) {}

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

  @Get('patines/day-summary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  getPatinesDaySummary(@Query() query: GetPatinesDaySummaryDto) {
    return this.reservationsService.getPatinesDaySummary(query.date);
  }

  @Get('action/token')
  @Header('Content-Type', 'text/html')
  async handleTokenAction(@Query('token') token: string): Promise<string> {
    if (!token) {
      return this.buildTokenErrorHtml('No se proporcionó un token de acción.');
    }

    try {
      const payload = this.jwtService.verify<{
        reservationId: string;
        action: 'confirm' | 'cancel';
      }>(token);

      if (payload.action === 'confirm') {
        return this.reservationsService.confirmEmailHtmlPage(payload.reservationId);
      }

      if (payload.action === 'cancel') {
        return this.reservationsService.cancelEmailHtmlPage(payload.reservationId);
      }

      return this.buildTokenErrorHtml('Acción no reconocida en el token.');
    } catch (error) {
      if (error?.name === 'TokenExpiredError') {
        return this.buildTokenErrorHtml(
          'El enlace ha expirado. El tiempo para confirmar o cancelar tu reserva ya ha pasado.',
        );
      }
      return this.buildTokenErrorHtml(
        'El enlace no es válido o ya fue utilizado. Si necesitas ayuda, contáctanos.',
      );
    }
  }

  private buildTokenErrorHtml(message: string): string {
    return `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Enlace no válido - Reserva Horarios</title>
      </head>
      <body style="font-family: Arial, sans-serif; background-color: #f8f9fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0;">
        <div style="max-width: 500px; background: #ffffff; border-radius: 8px; padding: 40px; text-align: center; box-shadow: 0 4px 8px rgba(0,0,0,0.1);">
          <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
          <h2 style="color: #dc2626; margin-bottom: 16px; font-size: 22px;">Enlace no válido</h2>
          <p style="color: #6b7280; font-size: 15px; line-height: 1.6;">${message}</p>
          <p style="color: #9ca3af; font-size: 13px; margin-top: 24px;">© ${new Date().getFullYear()} Reserva Horarios</p>
        </div>
      </body>
      </html>
    `;
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
