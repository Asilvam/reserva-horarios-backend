import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Reservation } from './entities/reservation.entity';
import { Schedule } from '../schedules/entities/schedule.entity';
import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
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
  authUser: AuthUser;
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

  async enqueueReservation(dto: CreateReservationDto, authUser: AuthUser): Promise<{ success: boolean; message: string; jobId: string | undefined }> {
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

  async createReservation(dto: CreateReservationDto, authUser: AuthUser) {
    this.logger.log(`Intento de reserva para scheduleId=${dto.scheduleId} por guardianId=${dto.guardianId}`);

    if (authUser.role === Role.Guardian) {
      if (!authUser.guardianId) {
        this.logger.warn(`Guardian sin guardianId asociado.`);
        throw new ForbiddenException('Tu usuario no tiene un apoderado asociado.');
      }

      if (dto.guardianId !== authUser.guardianId) {
        this.logger.warn(`Guardian  intentando reservar para otro apoderado (${dto.guardianId}).`);
        throw new ForbiddenException('No puedes crear reservas para otro apoderado.');
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

    const guardianDependentRuts = new Set(guardian.dependents.map((dependent) => dependent.rut));
    const invalidAttendingRut = attendingRuts.find((rut) => !guardianDependentRuts.has(rut));
    if (invalidAttendingRut) {
      this.logger.warn(`Asistente invalido (${invalidAttendingRut}) en reserva para guardianId=${guardianId}.`);
      throw new BadRequestException('Todos los asistentes deben pertenecer al apoderado.');
    }

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

      const uniquePatinesRuts = new Set(patinesRuts);
      const hasExactPatinesMatch = patinesRuts.length === attendingRuts.length && uniquePatinesRuts.size === patinesRuts.length && attendingRuts.every((rut) => uniquePatinesRuts.has(rut));

      if (!hasExactPatinesMatch) {
        throw new BadRequestException('metadata.patines debe coincidir 1:1 con attendingDependents por RUT.');
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
          })
          .session(session);

        if (existingReservationForDay) {
          this.logger.warn(`Conflicto: El apoderado ${guardianId} ya tiene reserva para el dia.`);
          throw new ConflictException('El apoderado ya tiene una reserva para ese dia.');
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
        });

        savedReservation = await newReservation.save({ session });
        updatedSchedule = updatedScheduleInTx;
        reservationStartTime = scheduleInTx.startTime;
      });
    } catch (error) {
      if (error?.code === 11000) {
        throw new ConflictException('El apoderado ya tiene una reserva para ese dia.');
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
    await this.sendReservationConfirmationNotifications(guardian, finalReservationStartTime, dto.attendingDependents);

    return finalReservation;
  }

  private async sendReservationConfirmationNotifications(guardian: { name: string; email: string; phone: string }, startTime: Date, attendingDependents: Array<{ name: string; rut: string }>) {
    const scheduleDateTime = this.formatDateTime(startTime);
    const companionsLine = attendingDependents.length > 0 ? attendingDependents.map((dependent) => `${dependent.name} (${dependent.rut})`).join(', ') : 'Sin acompanantes';

    try {
      await this.mailService.sendReservationConfirmation(guardian.email, guardian.name, scheduleDateTime, attendingDependents);
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
        throw new ForbiddenException('Tu usuario no tiene un apoderado asociado.');
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
        throw new ForbiddenException('No puedes ver una reserva de otro apoderado.');
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
            this.logger.warn(`Guardian intentando eliminar reserva de otro apoderado (${reservation.guardianId}).`);
            throw new ForbiddenException('No puedes eliminar una reserva de otro apoderado.');
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
}
