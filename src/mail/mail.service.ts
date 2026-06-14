import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

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

  async sendReservationConfirmation(
    email: string,
    guardianName: string,
    scheduleDateTime: string,
    companions: Array<{ name: string; rut: string }>,
  ) {
    const from = this.configService.get<string>('MAIL_FROM', 'no-reply@reserva-horarios.local');
    const transporter = this.createTransport();

    if (!transporter) {
      this.logger.warn('SMTP no configurado. Correo de confirmacion de reserva omitido.');
      return;
    }

    const companionsHtml = companions
      .map((companion) => `<li><strong>${companion.name}</strong> (${companion.rut})</li>`)
      .join('');

    const companionsText = companions.map((companion) => `- ${companion.name} (${companion.rut})`).join('\n');

    const emailContent = `<p>Hola ${guardianName}, tu reserva fue registrada correctamente.</p><p><strong>Fecha y hora:</strong> ${scheduleDateTime}</p><p><strong>Acompanantes:</strong></p><ul>${companionsHtml || '<li>Sin acompanantes</li>'}</ul>`;
    const html = this._generateModernHtmlTemplate('Confirmacion de Reserva', emailContent);

    await transporter.sendMail({
      from,
      to: email,
      subject: 'Reserva confirmada - Reserva Horarios',
      text: `Hola ${guardianName}, tu reserva fue registrada correctamente.\n\nFecha y hora: ${scheduleDateTime}\n\nAcompanantes:\n${companionsText || '- Sin acompanantes'}`,
      html,
    });
  }
}
