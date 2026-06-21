import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Reservation } from '../reservations/entities/reservation.entity';

@Injectable()
export class RemindersCron {
  private readonly logger = new Logger(RemindersCron.name);

  constructor(
    @InjectModel(Reservation.name) private readonly reservationModel: Model<Reservation>,
    @InjectQueue('reminders-queue') private readonly remindersQueue: Queue,
  ) {}

  // Se ejecuta todos los días a las 12:00 PM (hora de Chile)
  @Cron('*/5 * * * *', { timeZone: 'America/Santiago' })
  async handleDailyReminders() {
    this.logger.log('Iniciando proceso diario de recordatorios...');

    // 1. Calcular el rango de fecha para "Mañana"
    const now = new Date();
    const tomorrowStart = new Date(now);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    tomorrowStart.setHours(0, 0, 0, 0);

    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setHours(23, 59, 59, 999);

    // 2. Consultar reservas activas para mañana donde al menos un recordatorio esté pendiente
    // Usamos $ne: true para incluir registros antiguos creados antes de la migración del esquema (donde los campos son undefined)
    const reservations = await this.reservationModel
      .find({
        state_reserve: true,
        $or: [{ reminderMailSent: { $ne: true } }, { reminderWspSent: { $ne: true } }],
        reservationDay: {
          $gte: tomorrowStart,
          $lte: tomorrowEnd,
        },
      })
      .exec();

    const totalReservations = reservations.length;
    this.logger.log(`Encontradas ${totalReservations} reservas elegibles para recordatorio.`);

    if (totalReservations === 0) {
      return;
    }

    // 3. Configurar algoritmo de esparcido dinámico
    const WINDOW_DURATION_MS = 5.5 * 60 * 60 * 1000; // 5.5 horas de ventana efectiva
    const DEFAULT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutos de espacio por defecto

    let intervalMs = DEFAULT_INTERVAL_MS;
    if (totalReservations * DEFAULT_INTERVAL_MS > WINDOW_DURATION_MS) {
      intervalMs = Math.floor(WINDOW_DURATION_MS / totalReservations);
      this.logger.warn(`Volumen alto de reservas detectado. Reduciendo intervalo de envío a ${intervalMs / 1000} segundos.`);
    }

    // 4. Encolar tareas con delay progresivo
    for (let i = 0; i < totalReservations; i++) {
      const reservation = reservations[i];
      const delay = i * intervalMs;

      // Usar el ID de la reserva en el jobId para asegurar idempotencia a nivel de cola
      const jobId = `reminder-${reservation._id.toString()}`;

      await this.remindersQueue.add(
        'send-reminder',
        { reservationId: reservation._id.toString() },
        {
          jobId,
          delay,
          attempts: 3, // Intentar hasta 3 veces en caso de fallo
          backoff: {
            type: 'exponential',
            delay: 10000, // Reintentar con retraso exponencial
          },
          removeOnComplete: true, // Auto-limpieza de la cola si es exitosa
          removeOnFail: false, // Mantener fallados para auditoría
        },
      );
    }

    this.logger.log(`Se han programado exitosamente ${totalReservations} recordatorios en la cola.`);
  }
}
