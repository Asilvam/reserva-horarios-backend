import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Reservation } from './entities/reservation.entity';
import { Schedule } from '../schedules/entities/schedule.entity';
import * as QRCode from 'qrcode';
import { Injectable, BadRequestException, ConflictException, NotFoundException, ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';
import { GuardiansService } from '../guardians/guardians.service';
import { AuthUser } from '../auth/interfaces/auth-user.interface';
import { Role } from '../auth/enums/role.enum';
import { MailService } from '../mail/mail.service';
import { getChileDateTimeLabel, getChileStartOfDayUtc } from '../common/datetime/chile-time.util';
import { WspMetaService } from '../wsp-meta/wsp-meta.service';
import { SchedulesGateway } from '../schedules/schedules.gateway';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export type ReservationQueuePayload = {
  dto: CreateReservationDto;
  authUser?: AuthUser;
};

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    @InjectModel(Reservation.name) private reservationModel: Model<Reservation>,
    @InjectModel(Schedule.name) private scheduleModel: Model<Schedule>,
    @InjectQueue('reservation-queue') private readonly reservationQueue: Queue,
    private guardiansService: GuardiansService,
    private mailService: MailService,
    private wspMetaService: WspMetaService,
    private schedulesGateway: SchedulesGateway,
  ) {}

  async enqueueReservation(dto: CreateReservationDto, authUser?: AuthUser): Promise<{ success: boolean; message: string; jobId: string | undefined }> {
    // 1. Validaciones preliminares de seguridad
    if (authUser && authUser.role === Role.Guardian) {
      if (!authUser.guardianId) {
        this.logger.warn(`Guardian sin guardianId asociado en encolamiento.`);
        throw new ForbiddenException('Tu usuario no tiene un inscrito asociado.');
      }

      if (dto.guardianId !== authUser.guardianId) {
        this.logger.warn(`Guardian intentando reservar para otro inscrito en encolamiento (${dto.guardianId}).`);
        throw new ForbiddenException('No puedes crear reservas para otro inscrito.');
      }
    }

    // 2. Validar existencia del horario
    const schedule = await this.scheduleModel.findById(dto.scheduleId);
    if (!schedule) {
      this.logger.error(`Horario no encontrado al encolar: scheduleId=${dto.scheduleId}`);
      throw new BadRequestException('Horario no encontrado');
    }

    // 3. Validar si el horario ya caducó
    const now = new Date();
    if (schedule.startTime <= now) {
      this.logger.warn(`Intento de reserva para horario caducado al encolar: scheduleId=${dto.scheduleId}`);
      throw new BadRequestException('No se puede reservar un horario que ya caducó.');
    }

    // 4. Validar consumo de cupos
    const spotsToConsume = (dto.guardianParticipates ? 1 : 0) + dto.attendingDependents.length;
    if (spotsToConsume === 0) {
      this.logger.warn(`Reserva sin consumo de cupos al encolar para guardianId=${dto.guardianId}.`);
      throw new BadRequestException('La reserva debe consumir al menos 1 cupo.');
    }

    if (schedule.availableSpots < spotsToConsume) {
      this.logger.warn(`Sin cupos suficientes al encolar para guardianId=${dto.guardianId} en scheduleId=${dto.scheduleId}.`);
      throw new ConflictException('No hay suficientes cupos disponibles para esta reserva.');
    }

    // 5. Validar si ya existe reserva activa para el día y evento específico
    const reservationDay = getChileStartOfDayUtc(schedule.startTime);
    const nextReservationDay = new Date(reservationDay.getTime() + 24 * 60 * 60 * 1000);

    const existingReservationForDay = await this.reservationModel.exists({
      guardianId: dto.guardianId,
      reservationDay: {
        $gte: reservationDay,
        $lt: nextReservationDay,
      },
      eventType: schedule.eventType,
      state_reserve: true,
    });

    if (existingReservationForDay) {
      this.logger.warn(`Conflicto al encolar: El inscrito ${dto.guardianId} ya tiene reserva para el dia.`);
      throw new ConflictException('La persona ya tiene una reserva para ese dia.');
    }

    // Validar si alguno de los acompañantes ya tiene una reserva activa para ese mismo día y evento
    const attendingRuts = dto.attendingDependents?.map((d) => d.rut) || [];
    if (attendingRuts.length > 0) {
      const duplicateDependentReservation = await this.reservationModel.findOne({
        reservationDay: {
          $gte: reservationDay,
          $lt: nextReservationDay,
        },
        eventType: schedule.eventType,
        state_reserve: true,
        'attendingDependents.rut': { $in: attendingRuts },
      });

      if (duplicateDependentReservation) {
        const duplicateRut = duplicateDependentReservation.attendingDependents
          .map((d) => d.rut)
          .find((rut) => attendingRuts.includes(rut));
        this.logger.warn(`Conflicto al encolar: El acompañante con RUT ${duplicateRut} ya tiene reserva para el dia.`);
        throw new ConflictException(`El acompañante con RUT ${duplicateRut} ya tiene una reserva para ese dia.`);
      }
    }

    const jobName = 'process-single-reservation';

    const job = await this.reservationQueue.add(
      jobName,
      {
        dto,
        authUser,
      },
      {
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      },
    );

    this.logger.log(`Job '${jobName}' enqueued for guardian ${dto.guardianId}`);

    return {
      success: true,
      message: 'Your reservation request is being processed.',
      jobId: job.id?.toString(),
    };
  }

  async createReservation(dto: CreateReservationDto, authUser?: AuthUser) {
    this.logger.log(`Intento de reserva para scheduleId=${dto.scheduleId} por guardianId=${dto.guardianId}`);

    if (authUser && authUser.role === Role.Guardian) {
      if (!authUser.guardianId) {
        this.logger.warn(`Guardian sin guardianId asociado.`);
        throw new ForbiddenException('Tu usuario no tiene un inscrito asociado.');
      }

      if (dto.guardianId !== authUser.guardianId) {
        this.logger.warn(`Guardian  intentando reservar para otro inscrito (${dto.guardianId}).`);
        throw new ForbiddenException('No puedes crear reservas para otro inscrito.');
      }
    }

    const guardianId = dto.guardianId;

    const guardian = await this.guardiansService.findById(guardianId);

    const schedule = await this.scheduleModel.findById(dto.scheduleId);
    if (!schedule) {
      this.logger.error(`Horario no encontrado: scheduleId=${dto.scheduleId}`);
      throw new BadRequestException('Horario no encontrado');
    }

    const now = new Date();
    if (schedule.startTime <= now) {
      this.logger.warn(`Intento de reserva para horario caducado: scheduleId=${dto.scheduleId}`);
      throw new BadRequestException('No se puede reservar un horario que ya caducó.');
    }

    const attendingDependentsCount = dto.attendingDependents.length;

    const attendingRuts = dto.attendingDependents.map((dependent) => dependent.rut);
    const uniqueAttendingRuts = new Set(attendingRuts);
    if (uniqueAttendingRuts.size !== attendingRuts.length) {
      this.logger.warn(`RUTs duplicados en la reserva para guardianId=${guardianId}.`);
      throw new BadRequestException('No se permiten RUTs duplicados en asistentes.');
    }

    // Ya no se requiere validar que los acompañantes pertenezcan rígidamente al inscrito.
    // Esta validación restrictiva ha sido removida para flexibilizar grupos familiares.

    if (attendingDependentsCount > schedule.maxDependentsPerReservation) {
      this.logger.warn(`Exceso de cargas para guardianId=${guardianId} en scheduleId=${dto.scheduleId}.`);
      throw new BadRequestException(`Máximo ${schedule.maxDependentsPerReservation} cargas permitidas.`);
    }

    if (dto.metadata?.eventType === 'patines') {
      const patines = dto.metadata.patines;
      if (!Array.isArray(patines)) {
        throw new BadRequestException('Para evento patines, metadata.patines es obligatorio.');
      }

      const patinesRuts: string[] = [];
      for (const item of patines) {
        if (!item || typeof item !== 'object') {
          throw new BadRequestException('Cada elemento de metadata.patines debe ser un objeto valido.');
        }

        const { rut, shoeSize } = item as { rut?: unknown; shoeSize?: unknown };

        if (typeof rut !== 'string' || rut.trim().length === 0) {
          throw new BadRequestException('Cada elemento de metadata.patines debe incluir un rut valido.');
        }

        if (typeof shoeSize !== 'number' || !Number.isFinite(shoeSize) || shoeSize <= 0) {
          throw new BadRequestException('Cada elemento de metadata.patines debe incluir shoeSize numerico mayor a 0.');
        }

        patinesRuts.push(rut);
      }

      const expectedRuts = [...attendingRuts];
      if (dto.guardianParticipates) {
        expectedRuts.push(guardian.rut);
      }

      const uniquePatinesRuts = new Set(patinesRuts);
      const hasExactPatinesMatch = patinesRuts.length === expectedRuts.length && uniquePatinesRuts.size === patinesRuts.length && expectedRuts.every((rut) => uniquePatinesRuts.has(rut));

      if (!hasExactPatinesMatch) {
        throw new BadRequestException('metadata.patines debe coincidir 1:1 con los asistentes (incluyendo al inscrito si participa) por RUT.');
      }
    }

    const spotsToConsume = (dto.guardianParticipates ? 1 : 0) + attendingDependentsCount;

    if (spotsToConsume === 0) {
      this.logger.warn(`Reserva sin consumo de cupos para guardianId=${guardianId}.`);
      throw new BadRequestException('La reserva debe consumir al menos 1 cupo.');
    }

    const session = await this.reservationModel.db.startSession();
    let savedReservation: Reservation | null = null;
    let updatedSchedule: Schedule | null = null;
    let reservationStartTime: Date | null = null;

    try {
      await session.withTransaction(async () => {
        const scheduleInTx = await this.scheduleModel.findById(dto.scheduleId).session(session);

        if (!scheduleInTx) {
          this.logger.error(`Horario no encontrado en transaccion: scheduleId=${dto.scheduleId}`);
          throw new BadRequestException('Horario no encontrado');
        }

        const reservationDay = getChileStartOfDayUtc(scheduleInTx.startTime);
        const nextReservationDay = new Date(reservationDay.getTime() + 24 * 60 * 60 * 1000);

        const existingReservationForDay = await this.reservationModel
          .exists({
            guardianId,
            reservationDay: {
              $gte: reservationDay,
              $lt: nextReservationDay,
            },
            eventType: scheduleInTx.eventType,
            state_reserve: true,
          })
          .session(session);

        if (existingReservationForDay) {
          this.logger.warn(`Conflicto: El inscrito ${guardianId} ya tiene reserva para el dia.`);
          throw new ConflictException('La persona ya tiene una reserva para ese dia.');
        }

        // Validar en la transacción que ningún acompañante ya tenga una reserva activa el mismo día y evento
        if (attendingRuts.length > 0) {
          const duplicateDependentReservation = await this.reservationModel
            .findOne({
              reservationDay: {
                $gte: reservationDay,
                $lt: nextReservationDay,
              },
              eventType: scheduleInTx.eventType,
              state_reserve: true,
              'attendingDependents.rut': { $in: attendingRuts },
            })
            .session(session);

          if (duplicateDependentReservation) {
            const duplicateRut = duplicateDependentReservation.attendingDependents
              .map((d) => d.rut)
              .find((rut) => attendingRuts.includes(rut));
            this.logger.warn(`Conflicto: El acompañante con RUT ${duplicateRut} ya tiene reserva para el dia.`);
            throw new ConflictException(`El acompañante con RUT ${duplicateRut} ya tiene una reserva para ese dia.`);
          }
        }

        const updatedScheduleInTx = await this.scheduleModel.findOneAndUpdate(
          {
            _id: dto.scheduleId,
            startTime: { $gt: now },
            availableSpots: { $gte: spotsToConsume },
          },
          {
            $inc: { availableSpots: -spotsToConsume },
          },
          { returnDocument: 'after', session },
        );

        if (!updatedScheduleInTx) {
          const scheduleExpired = await this.scheduleModel
            .exists({
              _id: dto.scheduleId,
              startTime: { $lte: now },
            })
            .session(session);

          if (scheduleExpired) {
            this.logger.warn(`Intento de reserva para horario caducado (carrera): scheduleId=${dto.scheduleId}`);
            throw new BadRequestException('No se puede reservar un horario que ya caducó.');
          }

          this.logger.warn(`Sin cupos suficientes para guardianId=${guardianId} en scheduleId=${dto.scheduleId}.`);
          throw new ConflictException('No hay suficientes cupos disponibles para esta reserva.');
        }

        const newReservation = new this.reservationModel({
          ...dto,
          totalSpotsConsumed: spotsToConsume,
          reservationDay,
          eventType: scheduleInTx.eventType,
        });

        savedReservation = await newReservation.save({ session });
        updatedSchedule = updatedScheduleInTx;
        reservationStartTime = scheduleInTx.startTime;
      });
    } catch (error) {
      if (error?.code === 11000) {
        throw new ConflictException('La persona ya tiene una reserva para ese dia.');
      }

      this.logger.error(`Error al guardar reserva: ${error}`);
      throw error;
    } finally {
      await session.endSession();
    }

    if (!savedReservation || !updatedSchedule || !reservationStartTime) {
      throw new InternalServerErrorException('No se pudo completar la reserva.');
    }

    const finalReservation = savedReservation as Reservation;
    const finalSchedule = updatedSchedule as Schedule;
    const finalReservationStartTime = reservationStartTime as Date;

    this.logger.log(`Cupos actualizados para scheduleId=${dto.scheduleId}. Disponibles: ${finalSchedule.availableSpots}`);
    this.schedulesGateway.broadcastSpotsUpdate(finalSchedule._id.toString(), finalSchedule.availableSpots);

    this.logger.log(`Reserva creada exitosamente: reservationId=${finalReservation._id}`);
    await this.sendReservationConfirmationNotifications(guardian, finalReservationStartTime, dto.attendingDependents, finalReservation._id.toString());

    // Programar la expiración automática en 30 minutos con reintentos para alta concurrencia
    try {
      await this.reservationQueue.add(
        'expire-reservation',
        { reservationId: finalReservation._id.toString() },
        { 
          delay: 5 * 60 * 1000, // 30 minutos (1800000 ms)
          attempts: 3,           // Intentar hasta 3 veces si falla por WriteConflict
          backoff: {
            type: 'exponential',
            delay: 5000,         // Reintentar tras 5s, luego 10s, etc.
          },
        }
      );
      this.logger.log(`Job de expiración programado para la reserva: ${finalReservation._id}`);
    } catch (queueErr) {
      this.logger.error(`Error al programar la expiración de la reserva ${finalReservation._id}: ${queueErr instanceof Error ? queueErr.message : String(queueErr)}`);
    }

    return finalReservation;
  }

  private async sendReservationConfirmationNotifications(
    guardian: { name: string; email: string; phone: string },
    startTime: Date,
    attendingDependents: Array<{ name: string; rut: string; age?: number }>,
    reservationId: string,
  ) {
    const scheduleDateTime = this.formatDateTime(startTime);
    const companionsLine = attendingDependents.length > 0 ? attendingDependents.map((dependent) => `${dependent.name} (${dependent.rut})`).join(', ') : 'Sin acompanantes';

    try {
      await this.mailService.sendReservationConfirmation(
        guardian.email,
        guardian.name,
        scheduleDateTime,
        attendingDependents,
        reservationId,
      );
    } catch (error) {
      this.logger.error(`No se pudo enviar correo de confirmacion para guardianId=${guardian.email}: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const message = `Reserva confirmada para ${scheduleDateTime}. Acompanantes: ${companionsLine}.`;
      const wspMetaStatus = this.wspMetaService.getStatus();

      if (wspMetaStatus.enabled && wspMetaStatus.configured) {
        try {
          await this.wspMetaService.sendTextMessage(guardian.phone, message);
        } catch (metaError) {
          this.logger.error(`Fallo wspMETA para phone=${guardian.phone}. No hay fallback wspWEB configurado en este flujo: ${metaError instanceof Error ? metaError.message : String(metaError)}`);
        }
      }
    } catch (error) {
      this.logger.error(`No se pudo enviar WhatsApp de confirmacion para phone=${guardian.phone}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private formatDateTime(date: Date): string {
    return getChileDateTimeLabel(date);
  }

  findAll(authUser: AuthUser) {
    if (authUser.role === Role.Guardian) {
      if (!authUser.guardianId) {
        throw new ForbiddenException('Tu usuario no tiene un inscrito asociado.');
      }

      return this.reservationModel.find({ guardianId: authUser.guardianId }).sort({ createdAt: -1 }).exec();
    }

    return this.reservationModel.find().sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string, authUser: AuthUser) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Id de reserva invalido');
    }

    const reservation = await this.reservationModel.findById(id).exec();

    if (!reservation) {
      throw new NotFoundException('Reserva no encontrada');
    }

    if (authUser.role === Role.Guardian) {
      if (!authUser.guardianId || authUser.guardianId !== reservation.guardianId.toString()) {
        throw new ForbiddenException('No puedes ver una reserva de otro inscrito.');
      }
    }

    return reservation;
  }

  update(id: number, updateReservationDto: UpdateReservationDto) {
    return `This action updates a #${id} reservation`;
  }

  async remove(id: string, authUser: AuthUser) {
    this.logger.log(`Intento de eliminacion de reserva: reservationId=${id} `);

    if (!Types.ObjectId.isValid(id)) {
      this.logger.warn(`Intento de eliminacion con Id de reserva invalido: ${id}`);
      throw new BadRequestException('Id de reserva invalido');
    }

    const session = await this.reservationModel.db.startSession();
    let updatedScheduleAfterDelete: Schedule | null = null;
    let removedReservationScheduleId: string | null = null;

    try {
      await session.withTransaction(async () => {
        const reservation = await this.reservationModel.findById(id).session(session);

        if (!reservation) {
          this.logger.warn(`Reserva no encontrada para eliminacion: reservationId=${id}`);
          throw new NotFoundException('Reserva no encontrada');
        }

        if (authUser.role === Role.Guardian) {
          if (!authUser.guardianId || authUser.guardianId !== reservation.guardianId.toString()) {
            this.logger.warn(`Guardian intentando eliminar reserva de otro inscrito (${reservation.guardianId}).`);
            throw new ForbiddenException('No puedes eliminar una reserva de otro inscrito.');
          }
        }

        await this.reservationModel.findByIdAndDelete(id, { session });

        const updatedSchedule = await this.scheduleModel.findByIdAndUpdate(
          reservation.scheduleId,
          {
            $inc: { availableSpots: reservation.totalSpotsConsumed },
          },
          {
            returnDocument: 'after',
            session,
          },
        );

        updatedScheduleAfterDelete = updatedSchedule;
        removedReservationScheduleId = reservation.scheduleId.toString();
      });
    } finally {
      await session.endSession();
    }

    this.logger.log(`Reserva eliminada: reservationId=${id}`);

    const finalUpdatedScheduleAfterDelete = updatedScheduleAfterDelete as Schedule | null;
    const finalRemovedReservationScheduleId = removedReservationScheduleId;

    if (finalUpdatedScheduleAfterDelete && finalRemovedReservationScheduleId) {
      this.logger.log(`Cupos restaurados para scheduleId=${finalRemovedReservationScheduleId}. Disponibles: ${finalUpdatedScheduleAfterDelete.availableSpots}`);
      this.schedulesGateway.broadcastSpotsUpdate(finalUpdatedScheduleAfterDelete._id.toString(), finalUpdatedScheduleAfterDelete.availableSpots);
    } else {
      this.logger.warn(`No se pudo restaurar cupos para scheduleId=${finalRemovedReservationScheduleId ?? 'desconocido'} tras eliminar reserva.`);
    }

    return {
      message: 'Reserva eliminada correctamente.',
    };
  }

  async getReservationCheckInStatus(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Id de reserva invalido');
    }

    const reservation = await this.reservationModel.findById(id).exec();
    if (!reservation || reservation.state_reserve === false) {
      throw new NotFoundException('Reserva no encontrada o inactiva');
    }

    const guardian = await this.guardiansService.findById(reservation.guardianId.toString());
    const schedule = await this.scheduleModel.findById(reservation.scheduleId).exec();

    const now = new Date();
    const startTime = schedule ? new Date(schedule.startTime) : null;
    const endTime = startTime && schedule ? new Date(startTime.getTime() + (schedule.durationMinutes || 30) * 60000) : null;
    const isExpired = endTime ? endTime < now : false;

    return {
      reservation: {
        id: reservation._id.toString(),
        guardianName: guardian.name,
        guardianRut: guardian.rut,
        guardianEmail: guardian.email,
        guardianPhone: guardian.phone,
        startTime,
        durationMinutes: schedule?.durationMinutes ?? 30,
        attendingDependents: reservation.attendingDependents,
        isCheckedIn: reservation.isCheckedIn,
        checkInAt: reservation.checkInAt,
        isExpired,
        status: isExpired ? 'EXPIRADA' : (reservation.isCheckedIn ? 'CHECKED_IN' : 'VIGENTE'),
        eventType: schedule?.eventType,
      },
    };
  }

  async performCheckIn(id: string, pin: string) {
    const statusResult = await this.getReservationCheckInStatus(id);
    const { reservation } = statusResult;

    const expectedPin = process.env.INSPECTOR_PIN || '1234';
    if (!pin || pin.trim() !== expectedPin.trim()) {
      throw new ForbiddenException('PIN de inspector incorrecto o no suministrado.');
    }

    if (reservation.isCheckedIn) {
      return {
        success: true,
        message: 'El check-in ya habia sido realizado previamente.',
        reservation,
      };
    }

    if (reservation.isExpired) {
      throw new BadRequestException('El horario de la reserva ya expiro.');
    }

    // Actualizar en BD
    const dbReservation = await this.reservationModel.findById(id);
    if (!dbReservation) {
      throw new NotFoundException('Reserva no encontrada');
    }
    dbReservation.isCheckedIn = true;
    dbReservation.checkInAt = new Date();
    await dbReservation.save();

    // Obtener estado actualizado
    const updatedStatus = await this.getReservationCheckInStatus(id);
    return {
      success: true,
      message: 'Check-in realizado exitosamente.',
      reservation: updatedStatus.reservation,
    };
  }

  async getReservationCheckInDetails(id: string, pin: string) {
    const expectedPin = process.env.INSPECTOR_PIN || '1234';
    if (!pin || pin.trim() !== expectedPin.trim()) {
      throw new ForbiddenException('PIN de inspector incorrecto o no suministrado.');
    }
    return this.getReservationCheckInStatus(id);
  }

  getCheckInHtmlPage(): string {
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
            .status-badge { display: inline-block; padding: 10px 12px; border-radius: 8px; font-weight: bold; color: white; margin-bottom: 20px; text-align: center; width: calc(100% - 24px); font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; }
            .info-group { margin-bottom: 16px; border-bottom: 1px solid #f1f5f9; padding-bottom: 12px; }
            .label { font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase; margin-bottom: 4px; }
            .value { font-size: 16px; font-weight: 500; }
            ul { margin: 0; padding-left: 20px; }
            li { font-size: 15px; margin-bottom: 4px; }
            
            .pin-form { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; text-align: center; margin-top: 10px; }
            .pin-form h3 { margin-top: 0; margin-bottom: 12px; font-size: 16px; color: #0f766e; }
            .pin-input { width: calc(100% - 24px); padding: 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 18px; text-align: center; margin-bottom: 16px; letter-spacing: 0.25em; font-family: monospace; font-weight: bold; }
            .pin-input:focus { outline: none; border-color: #0f766e; box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.15); }
            .submit-btn { width: 100%; padding: 12px; background-color: #0f766e; color: white; border: none; border-radius: 6px; font-size: 15px; font-weight: bold; cursor: pointer; transition: background-color 0.2s; }
            .submit-btn:hover { background-color: #0d9488; }
            .submit-btn:disabled { background-color: #94a3b8; cursor: not-allowed; }
            
            .already-msg { text-align: center; font-weight: bold; color: #16a34a; background-color: #f0fdf4; border: 1px solid #bbf7d0; padding: 12px; border-radius: 8px; margin-top: 10px; }
            .error-msg { color: #dc2626; font-weight: bold; background: #fef2f2; border: 1px solid #fecaca; padding: 16px; border-radius: 8px; margin-bottom: 20px; text-align: center; }
            
            .hidden { display: none; }
            .spinner { border: 4px solid rgba(0, 0, 0, 0.1); width: 36px; height: 36px; border-radius: 50%; border-left-color: #0f766e; animation: spin 1s linear infinite; margin: 20px auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="header">
              <h1>Validador de Entrada</h1>
            </div>
            
            <div class="content">
              <!-- SECCIÓN DE CARGA (Visible por defecto) -->
              <div id="loading-section">
                <div class="spinner"></div>
                <p style="text-align: center; color: #64748b;">Verificando credenciales...</p>
              </div>

              <!-- SECCIÓN PIN (SOLICITUD) -->
              <div id="pin-section" class="pin-form hidden">
                <h3>Ingresar PIN de Inspector</h3>
                <p style="font-size: 13px; color: #64748b; margin-bottom: 16px;">Ingrese el PIN de seguridad para visualizar la información confidencial de la reserva.</p>
                <input type="password" id="pin-input" class="pin-input" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="PIN" required />
                <button id="unlock-btn" class="submit-btn" onclick="unlockDetails()">Verificar PIN</button>
              </div>

              <!-- SECCIÓN DE DETALLES (DESBLOQUEADA) -->
              <div id="details-section" class="hidden">
                <div id="status-badge" class="status-badge"></div>
                
                <div class="info-group">
                  <div class="label">Evento</div>
                  <div id="event-name" class="value" style="font-weight: bold; color: #0f766e;"></div>
                </div>

                <div class="info-group">
                  <div class="label">Inscrito</div>
                  <div id="guardian-name" class="value"></div>
                  <div id="guardian-rut-email" class="value" style="font-size: 14px; color: #64748b; margin-top: 2px;"></div>
                </div>

                <div class="info-group">
                  <div class="label">Horario Reservado</div>
                  <div id="reservation-time" class="value"></div>
                  <div id="reservation-duration" class="value" style="font-size: 14px; color: #64748b; margin-top: 2px;"></div>
                </div>

                <div class="info-group">
                  <div class="label">Estado de Check-In</div>
                  <div id="checkin-status" class="value"></div>
                  <div id="checkin-time" class="value" style="font-size: 14px; color: #64748b; margin-top: 2px;"></div>
                </div>

                <div class="info-group" style="border-bottom: none; padding-bottom: 0; margin-bottom: 20px;">
                  <div id="dependents-label" class="label">Acompañantes</div>
                  <div id="dependents-list-container"></div>
                </div>

                <!-- Acciones de Check-In -->
                <div id="action-container"></div>
              </div>

              <!-- SECCIÓN DE ERROR -->
              <div id="error-section" class="hidden">
                <div id="error-msg-box" class="error-msg"></div>
                <p id="error-subtitle" style="color: #64748b; font-size: 14px; text-align: center;"></p>
                <button id="retry-btn" class="submit-btn" onclick="resetView()" style="margin-top: 10px;">Reintentar</button>
              </div>
            </div>
          </div>

          <script>
            let justCheckedIn = false;
            
            function format24h(dateVal, includeSeconds) {
              if (!dateVal) return 'N/A';
              const options = {
                timeZone: 'America/Santiago',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
              };
              if (includeSeconds) {
                options.second = '2-digit';
              }
              return new Intl.DateTimeFormat('es-CL', options).format(new Date(dateVal)).replace(',', '');
            }

            // Extraer ID de reserva de forma robusta por strings
            const path = window.location.pathname;
            const prefix = '/reservations/';
            const idx = path.indexOf(prefix);
            const reservationId = idx !== -1 ? path.substring(idx + prefix.length).split('/')[0] : '';

            // Safe helper to show a section
            function showSection(sectionId) {
              const sections = ['loading-section', 'pin-section', 'details-section', 'error-section'];
              sections.forEach(function(id) {
                const el = document.getElementById(id);
                if (el) {
                  if (id === sectionId) {
                    el.classList.remove('hidden');
                  } else {
                    el.classList.add('hidden');
                  }
                }
              });
            }

            async function fetchDetails(pin) {
              showSection('loading-section');
              try {
                const res = await fetch('/reservations/' + reservationId + '/check-in-details', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ pin: pin })
                });
                
                if (!res.ok) {
                  const data = await res.json();
                  throw new Error(data.message || 'Código PIN inválido.');
                }

                const responseData = await res.json();
                const reservation = responseData.reservation;
                
                sessionStorage.setItem('inspector_pin', pin);
                
                const eventNames = {
                  selva: 'Selva Viva',
                  patines: 'Pista de Hielo'
                };
                const eventNameText = eventNames[reservation.eventType] || 'Evento General';
                const elEvent = document.getElementById('event-name');
                if (elEvent) elEvent.innerText = eventNameText;

                const elName = document.getElementById('guardian-name');
                if (elName) elName.innerText = reservation.guardianName;

                const elRutEmail = document.getElementById('guardian-rut-email');
                if (elRutEmail) elRutEmail.innerText = 'RUT: ' + reservation.guardianRut + ' | ' + reservation.guardianEmail;
                
                const formattedDate = format24h(reservation.startTime, false);
                const elTime = document.getElementById('reservation-time');
                if (elTime) elTime.innerText = formattedDate + ' hrs';

                const elDuration = document.getElementById('reservation-duration');
                if (elDuration) elDuration.innerText = 'Duración: ' + reservation.durationMinutes + ' minutos';
                
                const isExpired = reservation.isExpired;
                const isCheckedIn = reservation.isCheckedIn;
                
                const badge = document.getElementById('status-badge');
                if (badge) {
                  let statusText = 'VIGENTE / PENDIENTE DE CHECK-IN';
                  let badgeColor = '#0284c7';
                  
                  if (isExpired) {
                    statusText = 'EXPIRADA / HORARIO PASADO';
                    badgeColor = '#dc2626';
                  } else if (isCheckedIn) {
                    if (justCheckedIn) {
                      statusText = 'CHECK-IN REALIZADO';
                      badgeColor = '#16a34a';
                    } else {
                      statusText = 'CHECK-IN REALIZADO PREVIAMENTE';
                      badgeColor = '#dc2626';
                    }
                  }
                  badge.innerText = statusText;
                  badge.style.backgroundColor = badgeColor;
                }

                const elStatus = document.getElementById('checkin-status');
                if (elStatus) elStatus.innerText = isCheckedIn ? 'Realizado / Acceso Permitido' : 'Pendiente';

                const elCheckInTime = document.getElementById('checkin-time');
                if (elCheckInTime) {
                  if (isCheckedIn && reservation.checkInAt) {
                    const checkInTime = format24h(reservation.checkInAt, false);
                    elCheckInTime.innerText = 'Ingreso: ' + checkInTime + ' hrs';
                    elCheckInTime.classList.remove('hidden');
                  } else {
                    elCheckInTime.innerText = '';
                    elCheckInTime.classList.add('hidden');
                  }
                }

                const deps = reservation.attendingDependents || [];
                const elDepsLabel = document.getElementById('dependents-label');
                if (elDepsLabel) elDepsLabel.innerText = 'Acompañantes (' + deps.length + ')';

                const container = document.getElementById('dependents-list-container');
                if (container) {
                  if (deps.length > 0) {
                    let html = '<ul>';
                    deps.forEach(function(d) {
                      html += '<li><strong>' + d.name + '</strong> (' + d.rut + ')</li>';
                    });
                    html += '</ul>';
                    container.innerHTML = html;
                  } else {
                    container.innerHTML = '<div class="value" style="font-style: italic; color: #64748b;">Sin acompañantes</div>';
                  }
                }

                const actionContainer = document.getElementById('action-container');
                if (actionContainer) {
                  if (isCheckedIn) {
                    const checkInTime = format24h(reservation.checkInAt, true);
                    if (justCheckedIn) {
                      actionContainer.innerHTML = \`
                        <div class="already-msg" style="background-color: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; padding: 18px; border-radius: 10px; text-align: center; margin-top: 15px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                          <div style="font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; color: #15803d;">¡Check-in Registrado Ahora!</div>
                          <div style="font-size: 18px; font-weight: 800; color: #166534; margin: 6px 0; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">\${checkInTime}</div>
                          <div style="font-size: 13px; color: #14532d; font-weight: 500;">Entrada autorizada exitosamente.</div>
                        </div>
                      \`;
                    } else {
                      actionContainer.innerHTML = \`
                        <div class="already-msg" style="background-color: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 18px; border-radius: 10px; text-align: center; margin-top: 15px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                          <div style="font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; color: #b91c1c;">Check-In Realizado Anteriormente</div>
                          <div style="font-size: 18px; font-weight: 800; color: #b91c1c; margin: 6px 0; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">\${checkInTime}</div>
                          <div style="font-size: 13px; color: #7f1d1d; font-weight: 600; margin-top: 8px;">⚠️ ALERTA: Esta entrada ya fue utilizada.</div>
                        </div>
                      \`;
                    }
                  } else if (isExpired) {
                    actionContainer.innerHTML = '<div style="text-align: center; color: #dc2626; font-weight: bold; padding: 12px; background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px;">Reserva Expirada - No es posible realizar Check-In</div>';
                  } else {
                    actionContainer.innerHTML = '<div class="pin-form" style="border: none; padding: 0;"><button id="submit-btn" class="submit-btn">Autorizar Entrada</button></div>';
                    const btn = document.getElementById('submit-btn');
                    if (btn) {
                      btn.onclick = function() {
                        submitCheckIn(pin);
                      };
                    }
                  }
                }

                showSection('details-section');

              } catch (err) {
                sessionStorage.removeItem('inspector_pin');
                const elErrorMsg = document.getElementById('error-msg-box');
                if (elErrorMsg) elErrorMsg.innerText = err.message || 'Error de autenticación';
                const elErrorSub = document.getElementById('error-subtitle');
                if (elErrorSub) elErrorSub.innerText = 'El código QR podría ser inválido, o el PIN ingresado no es correcto.';
                showSection('error-section');
              }
            }

            async function submitCheckIn(pin) {
              const btn = document.getElementById('submit-btn');
              if (btn) {
                btn.disabled = true;
                btn.innerText = 'Procesando...';
              }
              try {
                const res = await fetch('/reservations/' + reservationId + '/check-in', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ pin: pin })
                });
                const data = await res.json();
                if (res.ok && data.success) {
                  justCheckedIn = true;
                  alert(data.message);
                  fetchDetails(pin);
                } else {
                  alert(data.message || 'Error al realizar check-in.');
                  if (btn) {
                    btn.disabled = false;
                    btn.innerText = 'Autorizar Entrada';
                  }
                }
              } catch (err) {
                alert('Error de red al conectar con el servidor.');
                if (btn) {
                  btn.disabled = false;
                  btn.innerText = 'Autorizar Entrada';
                }
              }
            }

            function resetView() {
              sessionStorage.removeItem('inspector_pin');
              const elPinInput = document.getElementById('pin-input');
              if (elPinInput) elPinInput.value = '';
              showSection('pin-section');
            }

            function unlockDetails() {
              const elPinInput = document.getElementById('pin-input');
              const pin = elPinInput ? elPinInput.value : '';
              if (!pin) {
                alert('Por favor ingrese el PIN.');
                return;
              }
              fetchDetails(pin);
            }

            function init() {
              if (!reservationId) {
                const elErrorMsg = document.getElementById('error-msg-box');
                if (elErrorMsg) elErrorMsg.innerText = 'ID de Reserva inválido o no suministrado.';
                const elErrorSub = document.getElementById('error-subtitle');
                if (elErrorSub) elErrorSub.innerText = 'El código QR podría estar dañado o mal formado.';
                showSection('error-section');
                return;
              }
              const storedPin = sessionStorage.getItem('inspector_pin');
              if (storedPin) {
                fetchDetails(storedPin);
              } else {
                showSection('pin-section');
              }
            }

            // Asegura que la inicialización ocurra sólo cuando el DOM esté listo
            if (document.readyState === 'complete' || document.readyState === 'interactive') {
              init();
            } else {
              document.addEventListener('DOMContentLoaded', init);
            }
          </script>
        </body>
      </html>
    `;
  }

  async confirmEmailHtmlPage(id: string): Promise<string> {
    try {
      const reservation = await this.confirmEmail(id);
      const formattedDate = reservation.reservationDay
        ? new Date(reservation.reservationDay).toLocaleDateString('es-CL', { timeZone: 'America/Santiago', day: 'numeric', month: 'long', year: 'numeric' })
        : 'N/A';

      return `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Asistencia Confirmada</title>
            <style>
              body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f1f5f9; color: #1e293b; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
              .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); width: 100%; max-width: 480px; overflow: hidden; text-align: center; }
              .header { background: #10b981; color: white; padding: 24px; }
              .header h1 { margin: 0; font-size: 22px; }
              .content { padding: 30px; }
              .icon { font-size: 48px; color: #10b981; margin-bottom: 16px; }
              .info { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 15px; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="header">
                <h1>¡Asistencia Confirmada!</h1>
              </div>
              <div class="content">
                <div class="icon">✓</div>
                <p style="font-size: 16px; line-height: 1.5; color: #334155;">Muchas gracias. Hemos registrado la confirmación de tu asistencia para la reserva.</p>
                <div class="info">
                  <strong>Fecha de Reserva:</strong><br/>
                  ${formattedDate}
                </div>
                <p style="font-size: 13px; color: #64748b;">Te sugerimos llegar con 20 minutos de anticipación al recinto.</p>
              </div>
            </div>
          </body>
        </html>
      `;
    } catch (error: any) {
      if (error.status === 409 || error.message?.includes('anteriormente por correo')) {
        return `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Reserva Ya Gestionada</title>
              <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f1f5f9; color: #1e293b; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
                .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); width: 100%; max-width: 480px; overflow: hidden; text-align: center; }
                .header { background: #d97706; color: white; padding: 24px; }
                .header h1 { margin: 0; font-size: 22px; }
                .content { padding: 30px; }
                .icon { font-size: 48px; color: #d97706; margin-bottom: 16px; }
                .warning-box { background-color: #fffbeb; border: 1px solid #fef3c7; color: #b45309; border-radius: 8px; padding: 16px; margin: 10px 0; font-size: 15px; line-height: 1.5; text-align: left; }
              </style>
            </head>
            <body>
              <div class="card">
                <div class="header">
                  <h1>Reserva Ya Gestionada</h1>
                </div>
                <div class="content">
                  <div class="icon">⚠</div>
                  <p style="font-size: 16px; line-height: 1.5; color: #334155;">Esta invitación ya ha sido respondida previamente.</p>
                  <div class="warning-box">
                    <strong>Detalle:</strong><br/>
                    ${error.message}
                  </div>
                  <p style="font-size: 13px; color: #64748b; margin-top: 15px;">No se permiten más cambios de estado desde el correo electrónico. Si tienes dudas o necesitas modificar tu respuesta, comunícate con soporte.</p>
                </div>
              </div>
            </body>
          </html>
        `;
      }

      return `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Error al Confirmar</title>
            <style>
              body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f1f5f9; color: #1e293b; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
              .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); width: 100%; max-width: 480px; overflow: hidden; text-align: center; }
              .header { background: #dc2626; color: white; padding: 24px; }
              .header h1 { margin: 0; font-size: 22px; }
              .content { padding: 30px; }
              .error-box { background-color: #fef2f2; border: 1px solid #fecaca; color: #991b1b; border-radius: 8px; padding: 16px; margin: 10px 0; font-size: 15px; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="header">
                <h1>Error</h1>
              </div>
              <div class="content">
                <div class="error-box">
                  ${error.message || 'No se pudo procesar la confirmación. Por favor, intenta de nuevo o comunícate con soporte.'}
                </div>
              </div>
            </div>
          </body>
        </html>
      `;
    }
  }

  async cancelEmailHtmlPage(id: string): Promise<string> {
    try {
      await this.cancelEmail(id);
      return `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Reserva Cancelada</title>
            <style>
              body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f1f5f9; color: #1e293b; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
              .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); width: 100%; max-width: 480px; overflow: hidden; text-align: center; }
              .header { background: #ef4444; color: white; padding: 24px; }
              .header h1 { margin: 0; font-size: 22px; }
              .content { padding: 30px; }
              .icon { font-size: 48px; color: #ef4444; margin-bottom: 16px; }
              .info { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 15px; color: #475569; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="header">
                <h1>Reserva Cancelada</h1>
              </div>
              <div class="content">
                <div class="icon">✓</div>
                <p style="font-size: 16px; line-height: 1.5; color: #334155;">Tu reserva ha sido cancelada exitosamente y los cupos han sido liberados.</p>
                <div class="info">
                  Hemos actualizado el sistema para notificar al equipo que no asistirás. Puedes realizar una nueva reserva en nuestro sitio web cuando lo desees.
                </div>
              </div>
            </div>
          </body>
        </html>
      `;
    } catch (error: any) {
      if (error.status === 409 || error.message?.includes('anteriormente por correo')) {
        return `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Reserva Ya Gestionada</title>
              <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f1f5f9; color: #1e293b; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
                .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); width: 100%; max-width: 480px; overflow: hidden; text-align: center; }
                .header { background: #d97706; color: white; padding: 24px; }
                .header h1 { margin: 0; font-size: 22px; }
                .content { padding: 30px; }
                .icon { font-size: 48px; color: #d97706; margin-bottom: 16px; }
                .warning-box { background-color: #fffbeb; border: 1px solid #fef3c7; color: #b45309; border-radius: 8px; padding: 16px; margin: 10px 0; font-size: 15px; line-height: 1.5; text-align: left; }
              </style>
            </head>
            <body>
              <div class="card">
                <div class="header">
                  <h1>Reserva Ya Gestionada</h1>
                </div>
                <div class="content">
                  <div class="icon">⚠</div>
                  <p style="font-size: 16px; line-height: 1.5; color: #334155;">Esta invitación ya ha sido respondida previamente.</p>
                  <div class="warning-box">
                    <strong>Detalle:</strong><br/>
                    ${error.message}
                  </div>
                  <p style="font-size: 13px; color: #64748b; margin-top: 15px;">No se permiten más cambios de estado desde el correo electrónico. Si tienes dudas o necesitas modificar tu respuesta, comunícate con soporte.</p>
                </div>
              </div>
            </body>
          </html>
        `;
      }

      return `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Error al Cancelar</title>
            <style>
              body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f1f5f9; color: #1e293b; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
              .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); width: 100%; max-width: 480px; overflow: hidden; text-align: center; }
              .header { background: #dc2626; color: white; padding: 24px; }
              .header h1 { margin: 0; font-size: 22px; }
              .content { padding: 30px; }
              .error-box { background-color: #fef2f2; border: 1px solid #fecaca; color: #991b1b; border-radius: 8px; padding: 16px; margin: 10px 0; font-size: 15px; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="header">
                <h1>Error</h1>
              </div>
              <div class="content">
                <div class="error-box">
                  ${error.message || 'No se pudo procesar la cancelación. Por favor, intenta de nuevo o comunícate con soporte.'}
                </div>
              </div>
            </div>
          </body>
        </html>
      `;
    }
  }

  async findByGuardianId(guardianId: string) {
    if (!Types.ObjectId.isValid(guardianId)) {
      throw new BadRequestException('Id de inscrito invalido');
    }
    return this.reservationModel.findOne({ guardianId }).sort({ createdAt: -1 }).exec();
  }

  async getQrCodeBuffer(id: string): Promise<Buffer> {
    const baseUrl = process.env.BACKEND_URL || 'http://localhost:3500';
    const checkInUrl = `${baseUrl}/reservations/${id}/check-in`;
    return QRCode.toBuffer(checkInUrl, {
      type: 'png',
      width: 400,
      margin: 1,
    });
  }

  async confirmEmail(id: string): Promise<Reservation> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Id de reserva inválido');
    }

    const reservation = await this.reservationModel.findById(id).exec();
    if (!reservation) {
      throw new NotFoundException('Reserva no encontrada');
    }

    if (reservation.checkMail !== null && reservation.checkMail !== undefined) {
      throw new ConflictException(
        `Esta reserva ya fue ${reservation.checkMail ? 'confirmada' : 'cancelada'} anteriormente por correo.`
      );
    }

    if (!reservation.state_reserve) {
      throw new BadRequestException('Esta reserva ya no está activa.');
    }

    reservation.checkMail = true;
    reservation.checkMailDate = new Date();
    return await reservation.save();
  }

  async cancelEmail(id: string): Promise<Reservation> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Id de reserva inválido');
    }

    const session = await this.reservationModel.db.startSession();
    let updatedScheduleAfterCancel: any = null;
    let cancelledReservation: any = null;

    try {
      await session.withTransaction(async () => {
        const reservation = await this.reservationModel.findById(id).session(session);

        if (!reservation) {
          throw new NotFoundException('Reserva no encontrada');
        }

        if (reservation.checkMail !== null && reservation.checkMail !== undefined) {
          throw new ConflictException(
            `Esta reserva ya fue ${reservation.checkMail ? 'confirmada' : 'cancelada'} anteriormente por correo.`
          );
        }

        if (!reservation.state_reserve) {
          throw new BadRequestException('Esta reserva ya fue cancelada.');
        }

        // Marcar la reserva como inactiva y registrar la cancelación por correo
        reservation.state_reserve = false;
        reservation.checkMail = false;
        reservation.checkMailDate = new Date();
        cancelledReservation = await reservation.save({ session });

        // Devolver los cupos al schedule correspondiente
        const updatedSchedule = await this.scheduleModel.findByIdAndUpdate(
          reservation.scheduleId,
          {
            $inc: { availableSpots: reservation.totalSpotsConsumed },
          },
          {
            returnDocument: 'after',
            session,
          },
        );
        updatedScheduleAfterCancel = updatedSchedule;
      });
    } finally {
      await session.endSession();
    }

    if (updatedScheduleAfterCancel && cancelledReservation) {
      this.logger.log(`Cupos restaurados tras cancelación por email de la reserva ${id}. Nuevos disponibles: ${updatedScheduleAfterCancel.availableSpots}`);
      this.schedulesGateway.broadcastSpotsUpdate(
        cancelledReservation.scheduleId.toString(),
        updatedScheduleAfterCancel.availableSpots
      );
    }

    if (!cancelledReservation) {
      throw new InternalServerErrorException('No se pudo cancelar la reserva.');
    }

    return cancelledReservation;
  }

  async expireReservation(id: string): Promise<{ success: boolean; message: string }> {
    if (!Types.ObjectId.isValid(id)) {
      this.logger.warn(`Id de reserva inválido para expiración: ${id}`);
      return { success: false, message: 'Id de reserva inválido.' };
    }

    const session = await this.reservationModel.db.startSession();
    let updatedScheduleAfterExpiry: any = null;
    let expiredReservation: any = null;
    let skipReason = '';

    try {
      await session.withTransaction(async () => {
        const reservation = await this.reservationModel.findById(id).session(session);

        if (!reservation) {
          skipReason = 'Reserva no encontrada';
          return;
        }

        // Si ya fue confirmada (por correo o Whatsapp), no hacemos nada y cancelamos expiración
        if (reservation.checkMail === true || reservation.checkWsp === true) {
          skipReason = 'Reserva confirmada anteriormente por correo o Whatsapp';
          return;
        }

        // Si la reserva ya fue cancelada/inactivada por otra razón, no hacemos nada
        if (!reservation.state_reserve) {
          skipReason = 'Reserva ya se encuentra inactiva';
          return;
        }

        // Expirar la reserva: setear state_reserve = false
        reservation.state_reserve = false;
        // Marcamos checkMail como false para registrar que quedó cancelada/expirada por tiempo
        reservation.checkMail = false;
        reservation.checkMailDate = new Date();
        expiredReservation = await reservation.save({ session });

        // Devolver los cupos al schedule correspondiente
        const updatedSchedule = await this.scheduleModel.findByIdAndUpdate(
          reservation.scheduleId,
          {
            $inc: { availableSpots: reservation.totalSpotsConsumed },
          },
          {
            returnDocument: 'after',
            session,
          },
        );
        updatedScheduleAfterExpiry = updatedSchedule;
      });
    } catch (err) {
      this.logger.error(`Error al procesar la expiración automática de la reserva ${id}: ${err instanceof Error ? err.message : String(err)}`);
      throw err; // Lanzamos el error para que BullMQ registre el fallo y reintente si corresponde
    } finally {
      await session.endSession();
    }

    if (skipReason) {
      this.logger.log(`Expiración de reserva ${id} omitida. Razón: ${skipReason}`);
      return { success: false, message: `Expiración omitida: ${skipReason}` };
    }

    if (updatedScheduleAfterExpiry && expiredReservation) {
      this.logger.log(`Reserva ${id} EXPIRADA automáticamente por falta de confirmación en 30 minutos. Cupos devueltos al scheduleId=${expiredReservation.scheduleId}. Disponibles: ${updatedScheduleAfterExpiry.availableSpots}`);
      this.schedulesGateway.broadcastSpotsUpdate(
        expiredReservation.scheduleId.toString(),
        updatedScheduleAfterExpiry.availableSpots
      );
      return { success: true, message: 'Reserva expirada automáticamente por inactividad y cupos liberados.' };
    }

    return { success: false, message: 'No se pudo expirar la reserva.' };
  }
}
