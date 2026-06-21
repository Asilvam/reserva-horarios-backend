import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reservation } from '../reservations/entities/reservation.entity';
import { MailService } from '../mail/mail.service';
import { WspMetaService } from '../wsp-meta/wsp-meta.service';

@Processor('reminders-queue')
export class RemindersProcessor extends WorkerHost {
  private readonly logger = new Logger(RemindersProcessor.name);

  constructor(
    @InjectModel(Reservation.name) private readonly reservationModel: Model<Reservation>,
    private readonly mailService: MailService,
    private readonly wspMetaService: WspMetaService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {
    super();
  }

  async process(job: Job<{ reservationId: string }>): Promise<void> {
    const { reservationId } = job.data;

    // 1. Cargar la reserva poblando los datos del Guardian y del Schedule
    const reservation = await this.reservationModel
      .findById(reservationId)
      .populate('guardianId') // Obtener email y phone del guardián
      .populate('scheduleId') // Obtener el horario de la reserva
      .exec();

    if (!reservation) {
      this.logger.warn(`Reserva ${reservationId} no encontrada. Omitiendo.`);
      return;
    }

    // 2. Verificar estado de la reserva
    if (!reservation.state_reserve) {
      this.logger.log(`Reserva ${reservationId} fue cancelada. Omitiendo recordatorio.`);
      return;
    }

    const guardian: any = reservation.guardianId;
    if (!guardian) {
      this.logger.warn(`Reserva ${reservationId} no contiene un guardián asociado. Omitiendo.`);
      return;
    }

    const schedule: any = reservation.scheduleId;
    if (!schedule) {
      this.logger.error(`Horario no encontrado para enviar recordatorio de la reserva ${reservationId}`);
      return;
    }

    // Validación estricta de información de contacto (correo y teléfono siempre considerados)
    let saveNeeded = false;

    if (!guardian.email) {
      if (!reservation.reminderMailSent) {
        this.logger.warn(`[INCONSISTENCIA] El guardián ${guardian.name} (ID: ${guardian._id}) de la reserva ${reservationId} no posee un correo electrónico registrado. Marcando recordatorio de email como omitido de inmediato.`);
        reservation.reminderMailSent = true;
        saveNeeded = true;
      }
    }

    const wspEnabled = this.wspMetaService.isEnabled();
    if (!guardian.phone) {
      if (!reservation.reminderWspSent) {
        this.logger.warn(`[INCONSISTENCIA] El guardián ${guardian.name} (ID: ${guardian._id}) de la reserva ${reservationId} no posee un teléfono registrado. Marcando recordatorio de WhatsApp como omitido de inmediato.`);
        reservation.reminderWspSent = true;
        saveNeeded = true;
      }
    } else if (!wspEnabled && !reservation.reminderWspSent) {
      this.logger.log(`Servicio de WhatsApp de Meta deshabilitado globalmente. Omitiendo recordatorio de WhatsApp para reserva ${reservationId}.`);
      reservation.reminderWspSent = true;
      saveNeeded = true;
    }

    if (saveNeeded) {
      await reservation.save();
    }

    // Si ambos ya fueron enviados u omitidos, finalizar el job
    if (reservation.reminderMailSent && reservation.reminderWspSent) {
      this.logger.log(`Recordatorios para la reserva ${reservationId} ya fueron completamente procesados (enviados u omitidos).`);
      return;
    }

    // Formatear Fecha y Hora según el estándar exacto (Viernes 19 de junio de 2026 · 12:00 hrs.)
    const startTimeDate = new Date(schedule.startTime);
    const optionsDate: Intl.DateTimeFormatOptions = {
      timeZone: 'America/Santiago',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    };
    const optionsTime: Intl.DateTimeFormatOptions = {
      timeZone: 'America/Santiago',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    };
    const dateLabel = startTimeDate.toLocaleDateString('es-CL', optionsDate);
    const timeLabel = startTimeDate.toLocaleTimeString('es-CL', optionsTime);
    const capitalizedDateLabel = dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1);
    const formattedDateTime = `${capitalizedDateLabel} · ${timeLabel} hrs.`;

    // Formatear el grupo y acompañantes: Grupo Titi + 3 acompañantes.
    const companionCount = reservation.attendingDependents.length;
    const groupText = companionCount > 0 ? `Grupo ${guardian.name} + ${companionCount} acompañante${companionCount > 1 ? 's' : ''}` : `Grupo ${guardian.name}`;

    // Preparar lista de acompañantes para el correo electrónico (guardián + adicionales)
    const mailCompanions = [
      {
        name: guardian.name,
        rut: guardian.rut,
      },
      ...reservation.attendingDependents,
    ];

    // Generar tokens JWT firmados temporales (Expiran en 10 minutos exactos)
    const confirmToken = this.jwtService.sign({ reservationId: reservation._id.toString(), action: 'confirm' }, { expiresIn: '10m' });

    const cancelToken = this.jwtService.sign({ reservationId: reservation._id.toString(), action: 'cancel' }, { expiresIn: '10m' });

    const baseUrl = (this.configService.get<string>('BACKEND_URL') || 'http://localhost:3500').trim();
    const confirmUrl = `${baseUrl}/reservations/action/token?token=${confirmToken}`;
    const cancelUrl = `${baseUrl}/reservations/action/token?token=${cancelToken}`;

    let emailError: Error | null = null;
    let wspError: Error | null = null;

    // 3. Enviar Correo Electrónico (si está pendiente)
    if (guardian.email && !reservation.reminderMailSent) {
      try {
        await this.mailService.sendReservationReminderMail(
          guardian.email,
          guardian.name,
          formattedDateTime, // Usamos la misma fecha formateada y amigable
          mailCompanions,
          confirmToken, // Enviamos el token en lugar del ID plano para el link de confirmación
          reservation.eventType,
          cancelToken, // Enviamos el token de cancelación para el botón de cancelar
        );
        reservation.reminderMailSent = true;
        reservation.reminderMailSentAt = new Date();
        await reservation.save();
        this.logger.log(`Correo de recordatorio enviado con éxito a ${guardian.email} para la reserva ${reservationId}`);
      } catch (error) {
        this.logger.error(`Error enviando correo a ${guardian.email}: ${error.message}`);
        emailError = error;
      }
    }

    // 4. Enviar Mensaje por WhatsApp (si está pendiente)
    if (guardian.phone && wspEnabled && !reservation.reminderWspSent) {
      try {
        let message = '';
        if (reservation.eventType === 'selva') {
          message =
            `¡Tu visita a Selva Viva es mañana! 🐢\n\n` +
            `📅 Fecha y hora:\n` +
            `${formattedDateTime}\n\n` +
            `👥 ${groupText}.\n\n` +
            `Por favor, confirma si asistirás:\n\n` +
            `[CONFIRMAR ASISTENCIA]\n` +
            `${confirmUrl}\n\n` +
            `[CANCELAR RESERVA]\n` +
            `${cancelUrl}\n\n` +
            `Si no podrás asistir, te agradecemos cancelar para liberar el cupo.\n\n` +
            `¡Gracias por tu respuesta! 🦎`;
        } else if (reservation.eventType === 'patines') {
          message =
            `¡Tu visita a la Pista de Hielo es mañana! ❄️⛸️\n\n` +
            `📅 Fecha y hora:\n` +
            `${formattedDateTime}\n\n` +
            `👥 ${groupText}.\n\n` +
            `Por favor, confirma si asistirás:\n\n` +
            `[CONFIRMAR ASISTENCIA]\n` +
            `${confirmUrl}\n\n` +
            `[CANCELAR RESERVA]\n` +
            `${cancelUrl}\n\n` +
            `Si no podrás asistir, te agradecemos cancelar para liberar el cupo.\n\n` +
            `¡Gracias por tu respuesta! ❄️`;
        } else {
          message =
            `¡Tu visita es mañana! 📅\n\n` +
            `📅 Fecha y hora:\n` +
            `${formattedDateTime}\n\n` +
            `👥 ${groupText}.\n\n` +
            `Por favor, confirma si asistirás:\n\n` +
            `[CONFIRMAR ASISTENCIA]\n` +
            `${confirmUrl}\n\n` +
            `[CANCELAR RESERVA]\n` +
            `${cancelUrl}\n\n` +
            `Si no podrás asistir, te agradecemos cancelar para liberar el cupo.\n\n` +
            `¡Gracias por tu respuesta!`;
        }

        await this.wspMetaService.sendTextMessage(guardian.phone, message);

        reservation.reminderWspSent = true;
        reservation.reminderWspSentAt = new Date();
        await reservation.save();
        this.logger.log(`WhatsApp de recordatorio enviado con éxito a ${guardian.phone} para la reserva ${reservationId}`);
      } catch (error) {
        this.logger.error(`Error enviando WhatsApp a ${guardian.phone}: ${error.message}`);
        wspError = error;
      }
    }

    // Si alguno de los envíos falló, relanzar el error para que BullMQ gestione el reintento de forma idempotente
    if (emailError) {
      throw emailError;
    }
    if (wspError) {
      throw wspError;
    }

    this.logger.log(`Recordatorios completamente procesados y registrados con éxito para la reserva ${reservationId}`);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`Job de recordatorio ${job.id} procesado exitosamente.`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error) {
    this.logger.error(`Job de recordatorio ${job?.id ?? 'unknown'} falló: ${err.message}`);
  }
}
