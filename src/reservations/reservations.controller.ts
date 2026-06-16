import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req, HttpCode, HttpStatus, Header } from '@nestjs/common';
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
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@Body() createReservationDto: CreateReservationDto, @Req() req: RequestWithUser) {
    const user = req.user;
    return this.reservationsService.enqueueReservation(createReservationDto, user);
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

  @Get(':id/check-in')
  @Header('Content-Type', 'text/html')
  async renderCheckInHtml(@Param('id') id: string) {
    try {
      const result = await this.reservationsService.getReservationCheckInStatus(id);
      
      const formattedDate = result.reservation.startTime ? new Date(result.reservation.startTime).toLocaleString('es-CL', { timeZone: 'America/Santiago' }) : 'N/A';
      const checkInTime = result.reservation.checkInAt ? new Date(result.reservation.checkInAt).toLocaleString('es-CL', { timeZone: 'America/Santiago' }) : 'N/A';
      const isExpired = result.reservation.isExpired;
      const isCheckedIn = result.reservation.isCheckedIn;

      let statusColor = '#0284c7'; // Azul para pendiente
      let statusText = 'VIGENTE / PENDIENTE DE CHECK-IN';
      if (isExpired) {
        statusColor = '#dc2626'; // Rojo para expirado
        statusText = 'EXPIRADA / HORARIO PASADO';
      } else if (isCheckedIn) {
        statusColor = '#16a34a'; // Verde para completado
        statusText = 'CHECK-IN REALIZADO';
      }

      return `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Validación de Reserva</title>
            <style>
              body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f1f5f9; color: #1e293b; padding: 20px; display: flex; justify-content: center; }
              .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); width: 100%; max-width: 480px; overflow: hidden; }
              .header { background: #0f766e; color: white; padding: 20px; text-align: center; }
              .header h1 { margin: 0; font-size: 20px; }
              .content { padding: 24px; }
              .status-badge { display: inline-block; padding: 10px 12px; border-radius: 8px; font-weight: bold; color: white; background-color: ${statusColor}; margin-bottom: 20px; text-align: center; width: calc(100% - 24px); font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; }
              .info-group { margin-bottom: 16px; border-bottom: 1px solid #f1f5f9; padding-bottom: 12px; }
              .label { font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase; margin-bottom: 4px; }
              .value { font-size: 16px; font-weight: 500; }
              ul { margin: 0; padding-left: 20px; }
              li { font-size: 15px; margin-bottom: 4px; }
              
              /* PIN check-in form styling */
              .checkin-form { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-top: 10px; text-align: center; }
              .checkin-form h3 { margin-top: 0; margin-bottom: 12px; font-size: 15px; color: #0f766e; }
              .pin-input { width: calc(100% - 24px); padding: 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 16px; text-align: center; margin-bottom: 12px; letter-spacing: 0.2em; font-family: monospace; }
              .pin-input:focus { outline: none; border-color: #0f766e; box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.15); }
              .submit-btn { width: 100%; padding: 12px; background-color: #0f766e; color: white; border: none; border-radius: 6px; font-size: 15px; font-weight: bold; cursor: pointer; transition: background-color 0.2s; }
              .submit-btn:hover { background-color: #0d9488; }
              .submit-btn:disabled { background-color: #94a3b8; cursor: not-allowed; }
              .already-msg { text-align: center; font-weight: bold; color: #16a34a; background-color: #f0fdf4; border: 1px solid #bbf7d0; padding: 12px; border-radius: 8px; margin-top: 10px; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="header">
                <h1>Validador de Entrada</h1>
              </div>
              <div class="content">
                <div class="status-badge">
                  ${statusText}
                </div>
                
                <div class="info-group">
                  <div class="label">Apoderado</div>
                  <div class="value">${result.reservation.guardianName}</div>
                  <div class="value" style="font-size: 14px; color: #64748b; margin-top: 2px;">RUT: ${result.reservation.guardianRut}</div>
                </div>

                <div class="info-group">
                  <div class="label">Horario Reservado</div>
                  <div class="value">${formattedDate} hrs</div>
                  <div class="value" style="font-size: 14px; color: #64748b; margin-top: 2px;">Duración: ${result.reservation.durationMinutes} minutos</div>
                </div>

                <div class="info-group">
                  <div class="label">Estado de Check-In</div>
                  <div class="value">${isCheckedIn ? 'Realizado / Acceso Permitido' : 'Pendiente'}</div>
                  ${isCheckedIn ? `<div class="value" style="font-size: 14px; color: #64748b; margin-top: 2px;">Ingreso: ${checkInTime} hrs</div>` : ''}
                </div>

                <div class="info-group" style="border-bottom: none; padding-bottom: 0; margin-bottom: 20px;">
                  <div class="label">Acompañantes (${result.reservation.attendingDependents.length})</div>
                  ${result.reservation.attendingDependents.length > 0 ? `
                    <ul>
                      ${result.reservation.attendingDependents.map(d => `<li><strong>${d.name}</strong> (${d.rut})</li>`).join('')}
                    </ul>
                  ` : '<div class="value" style="font-style: italic; color: #64748b;">Sin acompañantes</div>'}
                </div>

                <!-- Formulario de Check-In con PIN -->
                ${isCheckedIn ? `
                  <div class="already-msg">
                    Check-in realizado el ${checkInTime}
                  </div>
                ` : (isExpired ? `
                  <div style="text-align: center; color: #dc2626; font-weight: bold; padding: 12px; background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px;">
                    Reserva Expirada - No es posible realizar Check-In
                  </div>
                ` : `
                  <div class="checkin-form">
                    <h3>Confirmación de Inspector</h3>
                    <input type="password" id="pin-input" class="pin-input" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="PIN" required />
                    <button id="submit-btn" class="submit-btn" onclick="submitCheckIn()">Autorizar Entrada</button>
                  </div>
                  <script>
                    async function submitCheckIn() {
                      const pin = document.getElementById('pin-input').value;
                      if (!pin) {
                        alert('Por favor ingrese el PIN de Inspector.');
                        return;
                      }
                      const btn = document.getElementById('submit-btn');
                      btn.disabled = true;
                      btn.innerText = 'Procesando...';
                      try {
                        const res = await fetch(window.location.pathname, {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json'
                          },
                          body: JSON.stringify({ pin })
                        });
                        const data = await res.json();
                        if (res.ok && data.success) {
                          alert(data.message);
                          window.location.reload();
                        } else {
                          alert(data.message || 'PIN incorrecto o error al realizar check-in.');
                          btn.disabled = false;
                          btn.innerText = 'Autorizar Entrada';
                        }
                      } catch (err) {
                        alert('Error de red al conectar con el servidor.');
                        btn.disabled = false;
                        btn.innerText = 'Autorizar Entrada';
                      }
                    }
                  </script>
                `)}
              </div>
            </div>
          </body>
        </html>
      `;
    } catch (error: any) {
      const errMsg = error.message || 'Error de validación';
      return `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Error de Validación</title>
            <style>
              body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f1f5f9; color: #1e293b; padding: 20px; display: flex; justify-content: center; }
              .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); width: 100%; max-width: 480px; overflow: hidden; }
              .header { background: #dc2626; color: white; padding: 20px; text-align: center; }
              .header h1 { margin: 0; font-size: 20px; }
              .content { padding: 24px; text-align: center; }
              .error-msg { color: #dc2626; font-weight: bold; background: #fef2f2; border: 1px solid #fecaca; padding: 16px; border-radius: 8px; margin-bottom: 20px; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="header">
                <h1>Error al Validar Entrada</h1>
              </div>
              <div class="content">
                <div class="error-msg">
                  \${errMsg}
                </div>
                <p style="color: #64748b; font-size: 14px;">El código QR escaneado podría ser inválido o haber expirado.</p>
              </div>
            </div>
          </body>
        </html>
      `;
    }
  }
}
