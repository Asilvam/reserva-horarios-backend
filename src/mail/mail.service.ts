import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
// import * as QRCode from 'qrcode';

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

  private _generateModernHtmlTemplate(title: string, content: string, headerColor = '#007BFF'): string {
    return `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; background-color: #f8f9fa; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 8px rgba(0,0,0,0.1);">
          <div style="background-color: ${headerColor}; color: #ffffff; padding: 25px; text-align: center;">
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

  async sendReservationConfirmation(email: string, guardianName: string, scheduleDateTime: string, companions: Array<{ name: string; rut: string; age?: number }>, reservationId: string, eventType?: string) {
    const from = this.configService.get<string>('MAIL_FROM', 'no-reply@reserva-horarios.local');
    const transporter = this.createTransport();

    if (!transporter) {
      this.logger.warn('SMTP no configurado. Correo de confirmacion de reserva omitido.');
      return;
    }

    const baseUrl = this.configService.get<string>('BACKEND_URL') || 'http://localhost:3500';

    // Configuraciones dinámicas por tipo de evento
    let subject = 'Confirma tu reserva - Reserva Horarios';
    let headerColor = '#007BFF'; // Azul por defecto
    let btnGradient = 'linear-gradient(135deg, #007BFF, #0056b3)'; // Gradiente azul
    let introText = 'tu reserva en <strong>Reserva Horarios</strong>.';

    if (eventType === 'selva') {
      subject = 'Confirma tu reserva en Selva Viva 🦎🦜';
      headerColor = '#fc0303'; // Turquesa Selva
      btnGradient = 'linear-gradient(135deg, #10b981, #059669)'; // Verde Selva
      introText = 'tu reserva en <strong>Selva Viva</strong>! 🦎 🦜';
    } else if (eventType === 'patines') {
      subject = 'Confirma tu reserva en la Pista de Hielo ❄️⛸️';
      headerColor = '#0284c7'; // Azul Hielo
      btnGradient = 'linear-gradient(135deg, #0ea5e9, #0284c7)'; // Celeste Pista
      introText = 'tu reserva en la <strong>Pista de Hielo</strong>! ❄️  ⛸️';
    }

    const companionsHtml = companions
      .map(
        (companion) => `
      <li style="margin-bottom: 6px; list-style-type: none; display: flex; align-items: center;">
        <span style="margin-right: 8px;">👤</span>
        <strong>${companion.name}</strong> ${companion.rut ? `(${companion.rut})` : ''}
      </li>
    `,
      )
      .join('');

    const companionsText = companions.map((companion) => `- ${companion.name} (${companion.rut})`).join('\n');

    const emailContent = `
  
      <!-- Banner de Urgencia (5 minutos) -->
      <div style="background-color: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px; padding: 18px; margin-bottom: 25px;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="vertical-align: middle; width: 45px; font-size: 36px; padding: 0; text-align: center;">⚠️</td>
            <td style="padding: 0 0 0 15px; vertical-align: middle;">
              <p style="margin: 0; color: #b45309; font-weight: bold; font-size: 17px;">Atención</p>
              <p style="margin: 6px 0 0 0; color: #78350f; font-size: 15px; line-height: 1.6;">
                Debes <strong>confirmar tu reserva dentro de los próximos 5 minutos</strong>. Si no la confirmas, los cupos se liberarán automáticamente.
              </p>
            </td>
          </tr>
        </table>
      </div>

      <!-- Detalles de la reserva -->
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
        <p style="margin: 0 0 12px 0; font-size: 14px; color: #475569;">
          <span style="margin-right: 8px;">📅</span><strong>Fecha y hora:</strong> ${scheduleDateTime} hrs.
        </p>
        <div style="margin: 0; font-size: 14px; color: #475569;">
          <p style="margin: 0 0 8px 0;"><span style="margin-right: 8px;">👥</span><strong>Integrantes:</strong></p>
          <ul style="margin: 0; padding-left: 10px;">
            ${companionsHtml || '<li style="list-style-type: none; color: #94a3b8;">Sin acompañantes</li>'}
          </ul>
        </div>
      </div>

      <!-- Botón de Confirmación -->
      <div style="text-align: center; margin: 30px 0 15px 0;">
        <p style="font-size: 14px; color: #64748b; margin-bottom: 18px;">👇 Presiona el botón para confirmar:</p>
        <a href="${baseUrl}/reservations/${reservationId}/confirm-email" 
           style="display: inline-block; padding: 14px 32px; background: ${btnGradient}; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px; box-shadow: 0 4px 6px rgba(16, 185, 129, 0.2);">
           CONFIRMAR RESERVA
        </a>
        <p style="font-size: 12px; color: #94a3b8; margin-top: 18px;">
          Una vez confirmada, recibirás el código QR de ingreso. 🎟️
        </p>
      </div>
    `;

    const html = this._generateModernHtmlTemplate('¡Estas a un paso de confirmar tu reserva!', emailContent, headerColor);

    await transporter.sendMail({
      from,
      to: email,
      subject,
      text: `¡Estás a un paso de confirmar tu reserva! \n\nDebes confirmar tu reserva dentro de los próximos 5 minutos. Si no la confirmas, los cupos se liberarán automáticamente.\n\nFecha y hora: ${scheduleDateTime} hrs.\n\nIntegrantes:\n${companionsText || '- Sin acompañantes'}\n\nPresiona el siguiente enlace para confirmar:\n${baseUrl}/reservations/${reservationId}/confirm-email\n\nUna vez confirmada, recibirás el código QR de ingreso.`,
      html,
    });
  }

  async sendActiveReservationMail(email: string, guardianName: string, scheduleDateTime: string, companions: Array<{ name: string; rut: string; age?: number }>, reservationId: string, qrBuffer: Buffer, eventType?: string) {
    const from = this.configService.get<string>('MAIL_FROM', 'no-reply@reserva-horarios.local');
    const transporter = this.createTransport();

    if (!transporter) {
      this.logger.warn('SMTP no configurado. Correo de confirmación final de reserva omitido.');
      return;
    }

    // Configuraciones dinámicas por tipo de evento
    let subject = 'Confirmación de Reserva Exitosa - Reserva Horarios';
    let headerColor = '#007BFF'; // Azul por defecto
    let eventName = 'Reserva Horarios';
    let eventEmoji = '🎟️';
    let footerEmoji = '🐍🐢';

    if (eventType === 'selva') {
      subject = 'Reserva Confirmada en Selva Viva! 🦎🦜';
      headerColor = '#0d9488'; // Turquesa Selva
      eventName = 'Selva Viva';
      eventEmoji = '🦎🦜';
      footerEmoji = '🐍🐢';
    } else if (eventType === 'patines') {
      subject = 'Reserva Confirmada en la Pista de Hielo! ❄️⛸️';
      headerColor = '#0284c7'; // Azul Hielo
      eventName = 'la Pista de Hielo';
      eventEmoji = '❄️⛸️';
      footerEmoji = '❄️⛸️';
    }

    const displayDateTime = scheduleDateTime ? scheduleDateTime.replace(/,/g, '').replace(/-/g, '·') : '';

    const companionsHtml = companions
      .map(
        (companion) => `
      <li style="margin-bottom: 6px; color: #475569; font-size: 14px;">
        <strong>${companion.name}</strong>${companion.rut ? ` (${companion.rut})` : ''}
      </li>
    `,
      )
      .join('');

    const textCompanions = companions.map((companion) => `* ${companion.name}${companion.rut ? ` (${companion.rut})` : ''}`).join('\n');

    const emailContent = `
      <p style="font-size: 16px; margin-bottom: 25px; font-weight: bold; color: #1e293b; text-align: center;">
        ¡Tu reserva para ${eventName} ha sido confirmada! ${eventEmoji}
      </p>

      <!-- Detalles de la reserva -->
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
        <p style="margin: 0 0 10px 0; font-size: 14px; color: #1e293b; font-weight: bold;">
          📅 Fecha y hora:
        </p>
        <p style="margin: 0 0 20px 0; font-size: 14px; color: #475569; padding-left: 10px;">
          ${displayDateTime} hrs.
        </p>
        
        <p style="margin: 0 0 10px 0; font-size: 14px; color: #1e293b; font-weight: bold;">
          Grupo registrado:
        </p>
        <ul style="margin: 0; padding-left: 20px; color: #475569; font-size: 14px; line-height: 1.6;">
          ${companionsHtml || '<li style="list-style-type: none; color: #94a3b8;">Sin acompañantes</li>'}
        </ul>
      </div>

      <!-- Código QR de ingreso -->
      <div style="text-align: center; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 25px; margin-bottom: 25px;">
        <p style="margin: 0 0 15px 0; font-weight: bold; font-size: 14px; color: #1e293b; text-transform: uppercase; letter-spacing: 0.5px;">
          🎫 Código QR de ingreso:
        </p>
        <img src="cid:qrcode" alt="Código QR" style="display: inline-block; max-width: 220px; height: auto;" />
      </div>

      <!-- Importante -->
      <div style="background-color: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 4px; padding: 15px 20px; margin: 25px 0;">
        <p style="margin: 0 0 8px 0; font-weight: bold; font-size: 14px; color: #b45309; text-transform: uppercase; letter-spacing: 0.5px;">
          ⚠️ Importante:
        </p>
        <ul style="margin: 0; padding-left: 15px; color: #78350f; font-size: 13.5px; line-height: 1.6;">
          <li style="margin-bottom: 6px;">Llega al menos 20 minutos antes de tu horario.</li>
          <li style="margin-bottom: 6px;">Presenta este código QR al ingresar.</li>
          <li style="margin-bottom: 6px;">Revisa las normas de uso antes de tu visita.</li>
        </ul>
      </div>

      <p style="font-size: 16px; font-weight: bold; color: #1e293b; text-align: center; margin-top: 30px; margin-bottom: 0;">
        ¡Te esperamos! ${footerEmoji}
      </p>
    `;

    const html = this._generateModernHtmlTemplate('Reserva Confirmada', emailContent, headerColor);

    await transporter.sendMail({
      from,
      to: email,
      subject,
      text:
        `¡Tu reserva para ${eventName} ha sido confirmada! ${eventEmoji}\n\n` +
        `📅 Fecha y hora:\n` +
        `${displayDateTime} hrs.\n\n` +
        `Grupo registrado:\n` +
        `${textCompanions || '* Sin acompañantes'}\n\n` +
        `🎟️ Código QR de ingreso:\n` +
        `(QR adjunto)\n\n` +
        `⚠️ Importante:\n` +
        `* Llega al menos 20 minutos antes de tu horario.\n` +
        `* Presenta este código QR al ingresar.\n` +
        `* Revisa las normas de uso antes de tu visita.\n\n` +
        `¡Te esperamos! ${footerEmoji}`,
      html,
      attachments: [
        {
          filename: `reserva-${reservationId}.png`,
          content: qrBuffer,
          cid: 'qrcode',
        },
      ],
    });
  }
}
