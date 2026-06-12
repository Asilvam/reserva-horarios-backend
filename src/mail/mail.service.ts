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

  async sendGuardianCredentials(email: string, password: string) {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT', 587);
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');
    const from = this.configService.get<string>('MAIL_FROM', 'no-reply@reserva-horarios.local');
    const secure = this.getBoolean('MAIL_SECURE', port === 465);
    const tls = this.getBoolean('MAIL_TLS', true);

    if (!host || !user || !pass) {
      this.logger.warn('SMTP no configurado. Correo omitido.');
      return;
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
      requireTLS: tls,
    });

    await transporter.sendMail({
      from,
      to: email,
      subject: 'Credenciales de acceso - Reserva Horarios',
      text: `Tu cuenta fue creada correctamente.\n\nCorreo: ${email}\nContrasena: ${password}\n\nEsta contrasena es tu clave de acceso actual.`,
      html: `<p>Tu cuenta fue creada correctamente.</p><p><strong>Correo:</strong> ${email}<br/><strong>Contrasena:</strong> ${password}</p><p>Esta contrasena es tu clave de acceso actual.</p>`,
    });
  }

  async sendResetPassword(email: string, password: string) {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT', 587);
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');
    const from = this.configService.get<string>('MAIL_FROM', 'no-reply@reserva-horarios.local');
    const secure = this.getBoolean('MAIL_SECURE', port === 465);
    const tls = this.getBoolean('MAIL_TLS', true);

    if (!host || !user || !pass) {
      this.logger.warn('SMTP no configurado. Correo de reset omitido.');
      return;
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
      requireTLS: tls,
    });

    await transporter.sendMail({
      from,
      to: email,
      subject: 'Nueva contrasena - Reserva Horarios',
      text: `Tu contrasena fue regenerada por un administrador.\n\nCorreo: ${email}\nNueva contrasena: ${password}`,
      html: `<p>Tu contrasena fue regenerada por un administrador.</p><p><strong>Correo:</strong> ${email}<br/><strong>Nueva contrasena:</strong> ${password}</p>`,
    });
  }
}
