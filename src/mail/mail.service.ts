import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import * as QRCode from 'qrcode';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly configService: ConfigService) {}

  private getBoolean(key: string, defaultValue: boolean): boolean {
    const value = this.configService.get<string>(key);

    if (value === undefined) {
      return defaultValue;
    }

    return value.toLowerCase() === 'true';
  }

  private _generateModernHtmlTemplate(title: string, content: string): string {
    return `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; background-color: #f8f9fa; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 8px rgba(0,0,0,0.1);">
          <div style="background-color: #007BFF; color: #ffffff; padding: 25px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">${title}</h1>
          </div>
          <div style="padding: 30px; color: #343a40;">
            ${content}
          </div>
          <div style="background-color: #343a40; color: #f8f9fa; text-align: center; padding: 20px; font-size: 12px;">
            <p style="margin: 0;">Este es un mensaje automático, por favor no respondas.</p>
            <p style="margin: 5px 0 0;">&copy; ${new Date().getFullYear()} Reserva Horarios. Todos los derechos reservados.</p>
          </div>
        </div>
      </div>
    `;
  }

  private createTransport() {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT', 587);
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');
    const secure = this.getBoolean('MAIL_SECURE', port === 465);
    const tls = this.getBoolean('MAIL_TLS', true);

    if (!host || !user || !pass) {
      return null;
    }

    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
      requireTLS: tls,
    });
  }

  async sendGuardianCredentials(email: string, password: string) {
    const from = this.configService.get<string>('MAIL_FROM', 'no-reply@reserva-horarios.local');
    const transporter = this.createTransport();

    if (!transporter) {
      this.logger.warn('SMTP no configurado. Correo omitido.');
      return;
    }

    const emailContent = `<p>Tu cuenta ha sido creada exitosamente.</p><p>Tus credenciales de acceso son:</p><p style="padding-left: 20px;"><strong>Correo:</strong> ${email}<br/><strong>Contraseña:</strong> ${password}</p><p>Puedes usar esta contraseña para iniciar sesión. Te recomendamos cambiarla después de tu primer acceso.</p>`;
    const html = this._generateModernHtmlTemplate('¡Bienvenido a Reserva Horarios!', emailContent);

    await transporter.sendMail({
      from,
      to: email,
      subject: 'Credenciales de acceso - Reserva Horarios',
      text: `Tu cuenta fue creada correctamente.\n\nCorreo: ${email}\nContrasena: ${password}\n\nEsta contrasena es tu clave de acceso actual.`,
      html,
    });
  }

  async sendResetPassword(email: string, password: string) {
    const from = this.configService.get<string>('MAIL_FROM', 'no-reply@reserva-horarios.local');
    const transporter = this.createTransport();

    if (!transporter) {
      this.logger.warn('SMTP no configurado. Correo de reset omitido.');
      return;
    }

    const emailContent = `<p>Se ha restablecido tu contraseña a petición de un administrador.</p><p>Tu nueva contraseña es:</p><p style="padding-left: 20px;"><strong>Nueva Contraseña:</strong> ${password}</p><p>Usa esta nueva contraseña para acceder a tu cuenta. Por seguridad, te recomendamos cambiarla lo antes posible.</p>`;
    const html = this._generateModernHtmlTemplate('Restablecimiento de Contraseña', emailContent);

    await transporter.sendMail({
      from,
      to: email,
      subject: 'Nueva contrasena - Reserva Horarios',
      text: `Tu contrasena fue regenerada por un administrador.\n\nCorreo: ${email}\nNueva contrasena: ${password}`,
      html,
    });
  }

  async sendReservationConfirmation(email: string, guardianName: string, scheduleDateTime: string, companions: Array<{ name: string; rut: string; age?: number }>, reservationId: string) {
    const from = this.configService.get<string>('MAIL_FROM', 'no-reply@reserva-horarios.local');
    const transporter = this.createTransport();

    if (!transporter) {
      this.logger.warn('SMTP no configurado. Correo de confirmacion de reserva omitido.');
      return;
    }

    const baseUrl = this.configService.get<string>('BACKEND_URL') || 'http://localhost:3500';
    const checkInUrl = `${baseUrl}/reservations/${reservationId}/check-in`;

    let qrBuffer: Buffer;
    try {
      qrBuffer = await QRCode.toBuffer(checkInUrl, {
        type: 'png',
        width: 250,
        margin: 1,
      });
    } catch (qrErr) {
      this.logger.error(`Error al generar codigo QR: ${qrErr instanceof Error ? qrErr.message : String(qrErr)}`);
      return;
    }

    const companionsHtml = companions.map((companion) => `<li><strong>${companion.name}</strong> (${companion.rut})</li>`).join('');

    const companionsText = companions.map((companion) => `- ${companion.name} (${companion.rut})`).join('\n');

    const emailContent = `
      <p>Hola <strong>${guardianName}</strong>, tu reserva fue registrada correctamente.</p>
      <p><strong>Fecha y hora:</strong> ${scheduleDateTime}</p>
      <p><strong>Acompañantes registrados:</strong></p>
      <ul>${companionsHtml || '<li>Sin acompañantes</li>'}</ul>
      <br/>
      
      <!-- Botones de Confirmación de Asistencia -->
      <div style="text-align: center; margin: 25px 0; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #f8fafc;">
        <h4 style="margin-top: 0; color: #0f766e; font-size: 16px;">¿Confirmas tu asistencia para este día?</h4>
        <p style="font-size: 13px; color: #64748b; margin-bottom: 15px;">Por favor, indícanos si asistirás para ayudarnos a gestionar el aforo:</p>
        <div style="margin-top: 15px;">
          <a href="${baseUrl}/reservations/${reservationId}/confirm-email" 
             style="display: inline-block; padding: 12px 24px; background-color: #10b981; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 14px; margin-right: 10px;">
             Sí, Confirmar Asistencia
          </a>
          <a href="${baseUrl}/reservations/${reservationId}/cancel-email" 
             style="display: inline-block; padding: 12px 24px; background-color: #ef4444; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 14px;">
             No podré asistir
          </a>
        </div>
      </div>

      <div style="text-align: center; margin-top: 20px; padding: 20px; border: 1px dashed #cccccc; border-radius: 8px; background-color: #fafafa;">
        <h3 style="margin-top: 0; color: #007BFF;">Pase de Entrada (Código QR)</h3>
        <p style="font-size: 13px; color: #555555; margin-bottom: 15px;">Presenta este código en la entrada para realizar tu Check-In:</p>
        <img src="cid:reservation-qr" style="width: 200px; height: 200px; display: block; margin: 0 auto; border: 1px solid #dddddd;" alt="Código QR de Reserva"/>
        <p style="font-size: 11px; color: #777777; margin-top: 10px;">ID de Reserva: ${reservationId}</p>
      </div>
    `;

    const html = this._generateModernHtmlTemplate('Confirmación de Reserva', emailContent);

    await transporter.sendMail({
      from,
      to: email,
      subject: 'Reserva confirmada - Reserva Horarios',
      text: `Hola ${guardianName}, tu reserva fue registrada correctamente.\n\nFecha y hora: ${scheduleDateTime}\n\nAcompanantes:\n${companionsText || '- Sin acompanantes'}\n\nID de Reserva: ${reservationId}\nEnlace de Check-In: ${checkInUrl}`,
      html,
      attachments: [
        {
          filename: 'qrcode.png',
          content: qrBuffer,
          cid: 'reservation-qr',
        },
      ],
    });
  }
}
