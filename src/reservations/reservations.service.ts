import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Reservation } from './entities/reservation.entity';
import { Schedule } from '../schedules/entities/schedule.entity';
import * as QRCode from 'qrcode';
import { Injectable, BadRequestException, ConflictException, NotFoundException, ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';
import { GuardiansService } from '../guardians/guardians.service';
import { ConfigService } from '@nestjs/config';
import { AuthUser } from '../auth/interfaces/auth-user.interface';
import { Role } from '../auth/enums/role.enum';
import { MailService } from '../mail/mail.service';
import { chileLocalDateTimeToUtc, getChileDateTimeLabel, getChileStartOfDayUtc } from '../common/datetime/chile-time.util';
import { WspMetaService } from '../wsp-meta/wsp-meta.service';
import { SchedulesGateway } from '../schedules/schedules.gateway';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RedisService } from '../common/redis/redis.service';
import { PrecheckReservationDto } from './dto/precheck-reservation.dto';

export type ReservationQueuePayload = {
  dto: CreateReservationDto;
  authUser?: AuthUser;
};

type PrecheckResult = {
  rutRegisteredByValue: Record<string, boolean>;
  emailAvailable: boolean;
  phoneAvailable: boolean;
  source: 'redis' | 'mongo-fallback';
};

type ReservationIdentityPayload = {
  eventType: string;
  ruts: string[];
  email?: string;
  phone?: string;
};

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);
  private readonly rutCountKeyPrefix = 'event';
  private readonly reservationConfirmTtlSec: number;

  constructor(
    @InjectModel(Reservation.name) private reservationModel: Model<Reservation>,
    @InjectModel(Schedule.name) private scheduleModel: Model<Schedule>,
    @InjectQueue('reservation-queue') private readonly reservationQueue: Queue,
    private guardiansService: GuardiansService,
    private mailService: MailService,
    private wspMetaService: WspMetaService,
    private schedulesGateway: SchedulesGateway,
    private configService: ConfigService,
    private redisService: RedisService,
  ) {
    const configuredTtl = Number(this.configService.get<string>('RESERVATION_CONFIRM_TTL_SEC') || 300);
    this.reservationConfirmTtlSec = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 300;
  }

  private getReservationConfirmTtlLabel(): string {
    if (this.reservationConfirmTtlSec % 60 === 0) {
      const minutes = this.reservationConfirmTtlSec / 60;
      return `${minutes} minuto${minutes === 1 ? '' : 's'}`;
    }

    return `${this.reservationConfirmTtlSec} segundo${this.reservationConfirmTtlSec === 1 ? '' : 's'}`;
  }

  private getRutCountKey(eventType: string): string {
    return `${this.rutCountKeyPrefix}:${eventType}:rut-count`;
  }

  private getEmailCountKey(eventType: string): string {
    return `${this.rutCountKeyPrefix}:${eventType}:email-count`;
  }

  private getPhoneCountKey(eventType: string): string {
    return `${this.rutCountKeyPrefix}:${eventType}:phone-count`;
  }

  private maskRut(rut: string): string {
    if (!rut) return '***';
    if (rut.length <= 4) return `***${rut}`;
    return `${rut.slice(0, 2)}***${rut.slice(-2)}`;
  }

  private maskEmail(email: string): string {
    if (!email) return '***';
    const [name, domain] = email.split('@');
    if (!domain) return '***';
    const maskedName = name.length <= 2 ? `${name[0] ?? '*'}*` : `${name.slice(0, 2)}***`;
    return `${maskedName}@${domain}`;
  }

  private maskPhone(phone: string): string {
    if (!phone) return '***';
    return phone.length <= 4 ? `***${phone}` : `${phone.slice(0, 3)}***${phone.slice(-2)}`;
  }

  private toNumber(value: string | null): number {
    if (!value) return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private normalizeEventType(eventType: string): string {
    return eventType.trim().toLowerCase();
  }

  private normalizeRut(rut: string): string {
    return rut.trim().toUpperCase();
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private normalizePhone(phone: string): string {
    return phone.trim();
  }

  private parseRutVariants(rut: string): { clean: string; variants: string[] } | null {
    const clean = rut.replace(/[^0-9kK]/g, '').toUpperCase();
    if (clean.length < 2) {
      return null;
    }

    const body = clean.slice(0, -1);
    const dv = clean.slice(-1);
    const formatted = `${body}-${dv}`;

    let formattedBody = '';
    let count = 0;
    for (let i = body.length - 1; i >= 0; i--) {
      formattedBody = body[i] + formattedBody;
      count++;
      if (count % 3 === 0 && i !== 0) {
        formattedBody = `.${formattedBody}`;
      }
    }
    const dotted = `${formattedBody}-${dv}`;

    return {
      clean,
      variants: Array.from(new Set([this.normalizeRut(rut), clean, formatted, dotted])),
    };
  }

  private async checkRutsRegistrationBatch(ruts: string[], eventTypeInput: string): Promise<Record<string, boolean>> {
    const eventType = this.normalizeEventType(eventTypeInput);
    const normalizedRuts = Array.from(new Set((ruts || []).map((rut) => this.normalizeRut(rut)).filter(Boolean)));
    const result: Record<string, boolean> = {};

    for (const rut of normalizedRuts) {
      result[rut] = false;
    }

    if (normalizedRuts.length === 0) {
      return result;
    }

    const variantToCanonical = new Map<string, Set<string>>();
    const canonicalToVariants = new Map<string, string[]>();
    const cleanRuts = new Set<string>();

    for (const rut of normalizedRuts) {
      const parsed = this.parseRutVariants(rut);
      if (!parsed) {
        continue;
      }

      canonicalToVariants.set(rut, parsed.variants);
      cleanRuts.add(parsed.clean);

      for (const variant of parsed.variants) {
        const canonicalSet = variantToCanonical.get(variant) ?? new Set<string>();
        canonicalSet.add(rut);
        variantToCanonical.set(variant, canonicalSet);
      }
    }

    if (variantToCanonical.size === 0) {
      return result;
    }

    if (cleanRuts.size === 0) {
      return result;
    }

    const matchingGuardians = await this.guardiansService.findManyByRuts(Array.from(cleanRuts));
    if (matchingGuardians.length === 0) {
      return result;
    }

    const guardianIdVariants: Array<string | Types.ObjectId> = [];
    const guardianIdToRuts = new Map<string, Set<string>>();

    for (const guardian of matchingGuardians) {
      const guardianId = guardian._id.toString();
      guardianIdVariants.push(guardianId);
      if (Types.ObjectId.isValid(guardianId)) {
        guardianIdVariants.push(new Types.ObjectId(guardianId));
      }

      const canonicalSet = variantToCanonical.get(this.normalizeRut(guardian.rut));
      if (canonicalSet && canonicalSet.size > 0) {
        guardianIdToRuts.set(guardianId, new Set(canonicalSet));
      }
    }

    const guardianReservations = await this.reservationModel.collection
      .find({
        eventType,
        state_reserve: true,
        guardianId: { $in: guardianIdVariants },
      })
      .project({ guardianId: 1 })
      .toArray();

    for (const reservation of guardianReservations) {
      const guardianId = reservation.guardianId?.toString();
      if (!guardianId) {
        continue;
      }

      const mappedRuts = guardianIdToRuts.get(guardianId);
      if (!mappedRuts) {
        continue;
      }

      for (const rut of mappedRuts) {
        result[rut] = true;
      }
    }

    return result;
  }

  private sameEntityId(a?: string | null, b?: string | null): boolean {
    if (!a || !b) return false;
    return a.toString() === b.toString();
  }

  private async getTutorGuardianIdFromRuts(ruts: string[]): Promise<string | null> {
    if (!ruts || ruts.length === 0) {
      return null;
    }

    const tutorRut = ruts[0];
    if (!tutorRut) {
      return null;
    }

    const guardian = await this.guardiansService.findByRut(tutorRut);
    if (!guardian?._id) {
      return null;
    }

    return guardian._id.toString();
  }

  private async applyGuardianOwnershipAvailability(args: {
    tutorGuardianId: string | null;
    email: string;
    phone: string;
    emailAvailable: boolean;
    phoneAvailable: boolean;
  }): Promise<{ emailAvailable: boolean; phoneAvailable: boolean }> {
    let emailAvailable = args.emailAvailable;
    let phoneAvailable = args.phoneAvailable;

    if (args.email && emailAvailable) {
      const emailOwnerId = await this.guardiansService.findIdByEmail(args.email);
      if (emailOwnerId && !this.sameEntityId(emailOwnerId, args.tutorGuardianId)) {
        emailAvailable = false;
      }
    }

    if (args.phone && phoneAvailable) {
      const phoneOwnerId = await this.guardiansService.findIdByPhone(args.phone);
      if (phoneOwnerId && !this.sameEntityId(phoneOwnerId, args.tutorGuardianId)) {
        phoneAvailable = false;
      }
    }

    return { emailAvailable, phoneAvailable };
  }

  private getGuardianIdVariants(guardianId: string): Array<string | Types.ObjectId> {
    const normalized = guardianId.toString();
    if (!Types.ObjectId.isValid(normalized)) {
      return [normalized];
    }

    return [normalized, new Types.ObjectId(normalized)];
  }

  private async getIdentityPayloadForReservation(
    reservation: Pick<Reservation, 'guardianId' | 'attendingDependents' | 'eventType'>,
  ): Promise<ReservationIdentityPayload | null> {
    if (!reservation.eventType) {
      return null;
    }

    const guardian = await this.guardiansService.findById(reservation.guardianId.toString());

    return {
      eventType: reservation.eventType,
      ruts: [guardian.rut],
      email: guardian.email,
      phone: guardian.phone,
    };
  }

  private async updateEventIdentityCounters(params: {
    eventType: string;
    ruts?: string[];
    email?: string;
    phone?: string;
    delta: 1 | -1;
    context: string;
    requestId?: string;
  }) {
    const startedAt = Date.now();
    const eventType = this.normalizeEventType(params.eventType);
    const ruts = Array.from(new Set((params.ruts || []).map((r) => this.normalizeRut(r)).filter(Boolean)));
    const email = params.email ? this.normalizeEmail(params.email) : '';
    const phone = params.phone ? this.normalizePhone(params.phone) : '';

    if (ruts.length === 0 && !email && !phone) {
      return;
    }

    try {
      const redis = this.redisService.getClient();
      const pipeline = redis.multi();

      const rutCountKey = this.getRutCountKey(eventType);
      const emailCountKey = this.getEmailCountKey(eventType);
      const phoneCountKey = this.getPhoneCountKey(eventType);

      for (const rut of ruts) {
        pipeline.hincrby(rutCountKey, rut, params.delta);
      }

      if (email) {
        pipeline.hincrby(emailCountKey, email, params.delta);
      }

      if (phone) {
        pipeline.hincrby(phoneCountKey, phone, params.delta);
      }

      await pipeline.exec();

      if (params.delta === -1) {
        const cleanupPipeline = redis.multi();
        for (const rut of ruts) {
          cleanupPipeline.hget(rutCountKey, rut);
        }
        if (email) {
          cleanupPipeline.hget(emailCountKey, email);
        }
        if (phone) {
          cleanupPipeline.hget(phoneCountKey, phone);
        }
        const cleanupValues = await cleanupPipeline.exec();
        const deletePipeline = redis.multi();

        let index = 0;
        for (const rut of ruts) {
          const value = cleanupValues?.[index]?.[1] as string | null;
          if (this.toNumber(value) <= 0) {
            deletePipeline.hdel(rutCountKey, rut);
          }
          index++;
        }

        if (email) {
          const value = cleanupValues?.[index]?.[1] as string | null;
          if (this.toNumber(value) <= 0) {
            deletePipeline.hdel(emailCountKey, email);
          }
          index++;
        }

        if (phone) {
          const value = cleanupValues?.[index]?.[1] as string | null;
          if (this.toNumber(value) <= 0) {
            deletePipeline.hdel(phoneCountKey, phone);
          }
        }

        await deletePipeline.exec();
      }

      this.logger.log(
        JSON.stringify({
          event: 'reservation.redis.sync',
          context: params.context,
          requestId: params.requestId || null,
          eventType,
          delta: params.delta,
          rutCount: ruts.length,
          hasEmail: Boolean(email),
          hasPhone: Boolean(phone),
          durationMs: Date.now() - startedAt,
          result: 'ok',
        }),
      );
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'reservation.redis.sync',
          context: params.context,
          requestId: params.requestId || null,
          eventType,
          delta: params.delta,
          rutCount: ruts.length,
          email: email ? this.maskEmail(email) : null,
          phone: phone ? this.maskPhone(phone) : null,
          durationMs: Date.now() - startedAt,
          result: 'error',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async precheckAvailability(dto: PrecheckReservationDto, requestId?: string): Promise<PrecheckResult> {
    const startedAt = Date.now();
    const eventType = this.normalizeEventType(dto.eventType);
    const ruts = Array.from(new Set((dto.ruts || []).map((r) => this.normalizeRut(r)).filter(Boolean)));
    const email = dto.email ? this.normalizeEmail(dto.email) : '';
    const phone = dto.phone ? this.normalizePhone(dto.phone) : '';
    const tutorGuardianId = await this.getTutorGuardianIdFromRuts(ruts);

    try {
      const redis = this.redisService.getClient();
      const rutResult: Record<string, boolean> = {};
      for (const rut of ruts) {
        rutResult[rut] = false;
      }

      if (ruts.length > 0) {
        const values = await redis.hmget(this.getRutCountKey(eventType), ...ruts);
        for (let i = 0; i < ruts.length; i++) {
          rutResult[ruts[i]] = this.toNumber(values[i]) > 0;
        }

        const dbRutResult = await this.checkRutsRegistrationBatch(ruts, eventType);
        const syncPipeline = redis.multi();

        for (const rut of ruts) {
          const dbRegistered = Boolean(dbRutResult[rut]);
          const redisRegistered = rutResult[rut];

          if (redisRegistered && !dbRegistered) {
            rutResult[rut] = false;
            syncPipeline.hdel(this.getRutCountKey(eventType), rut);
            continue;
          }

          if (!redisRegistered && dbRegistered) {
            rutResult[rut] = true;
            syncPipeline.hset(this.getRutCountKey(eventType), rut, '1');
          }
        }

        await syncPipeline.exec();
      }

      const ownershipAvailability = await this.applyGuardianOwnershipAvailability({
        tutorGuardianId,
        email,
        phone,
        emailAvailable: true,
        phoneAvailable: true,
      });

      const result: PrecheckResult = {
        rutRegisteredByValue: rutResult,
        emailAvailable: ownershipAvailability.emailAvailable,
        phoneAvailable: ownershipAvailability.phoneAvailable,
        source: 'redis',
      };

      this.logger.log(
        JSON.stringify({
          event: 'reservation.precheck',
          requestId: requestId || null,
          eventType,
          source: result.source,
          rutCount: ruts.length,
          email: email ? this.maskEmail(email) : null,
          phone: phone ? this.maskPhone(phone) : null,
          registeredCount: Object.values(result.rutRegisteredByValue).filter(Boolean).length,
          emailAvailable: result.emailAvailable,
          phoneAvailable: result.phoneAvailable,
          durationMs: Date.now() - startedAt,
          result: 'ok',
        }),
      );

      return result;
    } catch (redisError) {
      this.logger.warn(
        JSON.stringify({
          event: 'reservation.precheck.redis_error',
          requestId: requestId || null,
          eventType,
          source: 'redis',
          rutCount: ruts.length,
          email: email ? this.maskEmail(email) : null,
          phone: phone ? this.maskPhone(phone) : null,
          durationMs: Date.now() - startedAt,
          error: redisError instanceof Error ? redisError.message : String(redisError),
        }),
      );
    }

    const fallbackStartedAt = Date.now();
    const rutResult = await this.checkRutsRegistrationBatch(ruts, eventType);

    const fallbackOwnershipAvailability = await this.applyGuardianOwnershipAvailability({
      tutorGuardianId,
      email,
      phone,
      emailAvailable: true,
      phoneAvailable: true,
    });

    const fallbackResult: PrecheckResult = {
      rutRegisteredByValue: rutResult,
      emailAvailable: fallbackOwnershipAvailability.emailAvailable,
      phoneAvailable: fallbackOwnershipAvailability.phoneAvailable,
      source: 'mongo-fallback',
    };

    this.logger.warn(
      JSON.stringify({
        event: 'reservation.precheck',
        requestId: requestId || null,
        eventType,
        source: fallbackResult.source,
        rutCount: ruts.length,
        email: email ? this.maskEmail(email) : null,
        phone: phone ? this.maskPhone(phone) : null,
        registeredCount: Object.values(fallbackResult.rutRegisteredByValue).filter(Boolean).length,
        emailAvailable: fallbackResult.emailAvailable,
        phoneAvailable: fallbackResult.phoneAvailable,
        durationMs: Date.now() - fallbackStartedAt,
        result: 'ok',
      }),
    );

    return fallbackResult;
  }

  async getPatinesDaySummary(date: string) {
    const startOfDay = chileLocalDateTimeToUtc(date, '00:00');
    const endOfDay = this.getNextChileDayUtc(date);

    const [result] = await this.reservationModel.aggregate([
      {
        $match: {
          eventType: 'patines',
          state_reserve: true,
          checkMail: true,
          reservationDay: {
            $gte: startOfDay,
            $lt: endOfDay,
          },
        },
      },
      {
        $addFields: {
          scheduleLookupId: {
            $cond: [
              { $eq: [{ $type: '$scheduleId' }, 'objectId'] },
              '$scheduleId',
              { $toObjectId: '$scheduleId' },
            ],
          },
          guardianLookupId: {
            $cond: [
              { $eq: [{ $type: '$guardianId' }, 'objectId'] },
              '$guardianId',
              { $toObjectId: '$guardianId' },
            ],
          },
        },
      },
      {
        $lookup: {
          from: 'schedules',
          localField: 'scheduleLookupId',
          foreignField: '_id',
          as: 'schedule',
        },
      },
      { $unwind: '$schedule' },
      {
        $lookup: {
          from: 'guardians',
          localField: 'guardianLookupId',
          foreignField: '_id',
          as: 'guardian',
        },
      },
      { $unwind: '$guardian' },
      {
        $addFields: {
          participants: {
            $concatArrays: [
              {
                $cond: [
                  '$guardianParticipates',
                  [{ name: '$guardian.name', rut: '$guardian.rut', type: 'tutor' }],
                  [],
                ],
              },
              {
                $map: {
                  input: { $ifNull: ['$attendingDependents', []] },
                  as: 'dep',
                  in: {
                    name: '$$dep.name',
                    age: '$$dep.age',
                    type: 'acompañante',
                  },
                },
              },
            ],
          },
        },
      },
      { $unwind: '$participants' },
      {
        $facet: {
          porHorario: [
            {
              $group: {
                _id: '$schedule.startTime',
                startTime: { $first: '$schedule.startTime' },
                durationMinutes: { $first: '$schedule.durationMinutes' },
                personas: {
                  $push: {
                    nombre: '$participants.name',
                    rut: '$participants.rut',
                    edad: '$participants.age',
                    tipo: '$participants.type',
                  },
                },
              },
            },
            { $sort: { startTime: 1 } },
            {
              $project: {
                _id: 0,
                horario: '$startTime',
                duracionMinutos: '$durationMinutes',
                totalPersonas: { $size: '$personas' },
                personas: 1,
                resumenTallas: [],
              },
            },
          ],
          totalGeneral: [
            {
              $count: 'totalPersonasDia',
            },
          ],
        },
      },
      {
        $project: {
          horarios: '$porHorario',
          resumenDelDia: {
            totalPersonasDia: {
              $ifNull: [{ $arrayElemAt: ['$totalGeneral.totalPersonasDia', 0] }, 0],
            },
            resumenTallasGeneral: [],
          },
        },
      },
    ]);

    return (
      result ?? {
        horarios: [],
        resumenDelDia: {
          totalPersonasDia: 0,
          resumenTallasGeneral: [],
        },
      }
    );
  }

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

    // 5. Validar si ya existe reserva activa o concluida para el evento específico en el historial

    // A. Validación del tutor como creador de reserva (Límite existente)
    const guardianIdStr = dto.guardianId.toString();
    let guardianIdObj: any = null;
    try {
      guardianIdObj = new Types.ObjectId(guardianIdStr);
    } catch (e) {}
    const guardianIdVariants = [guardianIdStr, guardianIdObj].filter(Boolean);

    const existingReservation = await this.reservationModel.collection.findOne({
      guardianId: { $in: guardianIdVariants },
      eventType: schedule.eventType,
      state_reserve: true,
    });

    if (existingReservation) {
      this.logger.warn(`Conflicto al encolar: El inscrito ${dto.guardianId} ya tiene una reserva activa o concluida para el evento ${schedule.eventType}.`);
      throw new ConflictException(
        'Uno o más RUN de esta reserva ya fueron registrados previamente para esta actividad.\n\nTe recordamos que cada persona puede participar *solo una vez por evento*, para que más vecinos tengan la oportunidad de vivir esta experiencia.',
      );
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

    if (attendingDependentsCount > schedule.maxDependentsPerReservation) {
      this.logger.warn(`Exceso de cargas para guardianId=${guardianId} en scheduleId=${dto.scheduleId}.`);
      throw new BadRequestException(`Máximo ${schedule.maxDependentsPerReservation} cargas permitidas.`);
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

        // A. Validación del tutor como creador de reserva (Límite existente)
        const guardianIdStr = guardianId.toString();
        let guardianIdObj: any = null;
        try {
          guardianIdObj = new Types.ObjectId(guardianIdStr);
        } catch (e) {}
        const guardianIdVariants = [guardianIdStr, guardianIdObj].filter(Boolean);

        const existingReservation = await this.reservationModel.collection.findOne(
          {
            guardianId: { $in: guardianIdVariants },
            eventType: scheduleInTx.eventType,
            state_reserve: true,
          },
          { session },
        );

        if (existingReservation) {
          this.logger.warn(`Conflicto: El inscrito ${guardianId} ya tiene una reserva activa o concluida para el evento ${scheduleInTx.eventType}.`);
          throw new ConflictException(
            'Uno o más RUN de esta reserva ya fueron registrados previamente para esta actividad.\n\nTe recordamos que cada persona puede participar *solo una vez por evento*, para que más vecinos tengan la oportunidad de vivir esta experiencia.',
          );
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
    await this.updateEventIdentityCounters({
      eventType: finalReservation.eventType || '',
      ruts: [guardian.rut],
      email: guardian.email,
      phone: guardian.phone,
      delta: 1,
      context: 'createReservation',
    });
    await this.sendReservationConfirmationNotifications(guardian, finalReservationStartTime, dto.attendingDependents, finalReservation._id.toString(), finalReservation.eventType);

    // Programar la expiración automática segun configuracion (RESERVATION_CONFIRM_TTL_SEC)
    try {
      await this.reservationQueue.add(
        'expire-reservation',
        { reservationId: finalReservation._id.toString() },
        {
          delay: this.reservationConfirmTtlSec * 1000,
          attempts: 3, // Intentar hasta 3 veces si falla por WriteConflict
          backoff: {
            type: 'exponential',
            delay: 5000, // Reintentar tras 5s, luego 10s, etc.
          },
        },
      );
      this.logger.log(`Job de expiración programado para la reserva: ${finalReservation._id}`);
    } catch (queueErr) {
      this.logger.error(`Error al programar la expiración de la reserva ${finalReservation._id}: ${queueErr instanceof Error ? queueErr.message : String(queueErr)}`);
    }

    return finalReservation;
  }

  async checkRutRegistration(rut: string, eventType: string): Promise<{ registered: boolean }> {
    const normalizedRut = this.normalizeRut(rut);
    const batchResult = await this.checkRutsRegistrationBatch([normalizedRut], eventType);
    return { registered: Boolean(batchResult[normalizedRut]) };
  }

  private async sendReservationConfirmationNotifications(
    guardian: { name: string; email: string; phone: string; rut: string },
    startTime: Date,
    attendingDependents: Array<{ name: string; age?: number }>,
    reservationId: string,
    eventType?: string,
  ) {
    const scheduleDateTime = this.formatDateTime(startTime);
    const baseUrl = this.configService.get<string>('BACKEND_URL') || 'http://localhost:3500';

    // 1. Integrantes del Correo (Apoderado al inicio)
    const mailCompanions = [
      {
        name: guardian.name,
        rut: guardian.rut,
      },
      ...attendingDependents,
    ];

    try {
      const qrBuffer = await this.getQrCodeBuffer(reservationId);
      await this.mailService.sendReservationConfirmation(
        guardian.email,
        guardian.name,
        scheduleDateTime,
        mailCompanions,
        reservationId,
        qrBuffer,
        eventType,
      );
    } catch (error) {
      this.logger.error(`No se pudo enviar correo de confirmacion para guardianId=${guardian.email}: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 2. Integrantes del WhatsApp (Apoderado al inicio)
    const listItems: string[] = [`- ${guardian.name} (${guardian.rut})`];
    attendingDependents.forEach((dep) => {
      listItems.push(`- ${dep.name}${dep.age ? ` (Edad: ${dep.age} años)` : ''}`);
    });
    const companionsText = listItems.join('\n');

    try {
      let eventTitle = 'tu reserva';
      if (eventType === 'selva') {
        eventTitle = 'tu reserva en Selva Viva! 🦎🦜';
      } else if (eventType === 'patines') {
        eventTitle = 'tu reserva en la Pista de Hielo! ❄️⛸️';
      }

      const confirmTtlLabel = this.getReservationConfirmTtlLabel();
      const message =
        `¡Estás a un paso de confirmar ${eventTitle}\n\n` +
        `Debes confirmar tu reserva dentro de los próximos ${confirmTtlLabel}. Si no la confirmas, los cupos se liberarán automáticamente.\n\n` +
        `📅 *Fecha y hora:* ${scheduleDateTime} hrs.\n` +
        `👥 *Integrantes:*\n${companionsText || '- Sin acompañantes'}\n\n` +
        `👇 *Presiona el enlace para confirmar:*\n` +
        `${baseUrl}/reservations/${reservationId}/confirm-email\n\n` +
        `Una vez confirmada, recibirás el código QR de ingreso. 🎟️`;

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

  private getNextChileDayUtc(date: string): Date {
    const [year, month, day] = date.split('-').map(Number);
    const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
    const nextDayYear = nextDay.getUTCFullYear();
    const nextDayMonth = String(nextDay.getUTCMonth() + 1).padStart(2, '0');
    const nextDayDate = String(nextDay.getUTCDate()).padStart(2, '0');

    return chileLocalDateTimeToUtc(`${nextDayYear}-${nextDayMonth}-${nextDayDate}`, '00:00');
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
    const removeContext: { identityPayload?: ReservationIdentityPayload } = {};

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

        const identityPayload = await this.getIdentityPayloadForReservation(reservation);
        if (identityPayload) {
          removeContext.identityPayload = identityPayload;
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

    if (removeContext.identityPayload) {
      await this.updateEventIdentityCounters({
        eventType: removeContext.identityPayload.eventType,
        ruts: removeContext.identityPayload.ruts,
        email: removeContext.identityPayload.email,
        phone: removeContext.identityPayload.phone,
        delta: -1,
        context: 'removeReservation',
      });
    }

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

    return {
      reservation: this.buildReservationCheckInView(reservation, guardian, schedule),
    };
  }

  private buildReservationCheckInView(reservation: Reservation, guardian: any, schedule: Schedule | null) {
    
    const now = new Date();
    const startTime = schedule ? new Date(schedule.startTime) : null;
    const endTime = startTime && schedule ? new Date(startTime.getTime() + (schedule.durationMinutes || 30) * 60000) : null;
    const isExpired = endTime ? endTime < now : false;

    return {
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
      status: isExpired ? 'EXPIRADA' : reservation.isCheckedIn ? 'CHECKED_IN' : 'VIGENTE',
      eventType: schedule?.eventType,
    };
  }

  private assertInspectorPin(pin: string): void {
    const expectedPin = this.configService.get<string>('INSPECTOR_PIN') || '1234';
    if (!pin || pin.trim() !== expectedPin.trim()) {
      throw new ForbiddenException('PIN de inspector incorrecto o no suministrado.');
    }
  }

  async performCheckIn(id: string, pin: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Id de reserva invalido');
    }
    this.assertInspectorPin(pin);

    const dbReservation = await this.reservationModel.findById(id).exec();
    if (!dbReservation || dbReservation.state_reserve === false) {
      throw new NotFoundException('Reserva no encontrada o inactiva');
    }

    const guardian = await this.guardiansService.findById(dbReservation.guardianId.toString());
    const schedule = await this.scheduleModel.findById(dbReservation.scheduleId).exec();
    const reservationView = this.buildReservationCheckInView(dbReservation, guardian, schedule);

    if (reservationView.isCheckedIn) {
      return {
        success: true,
        message: 'El check-in ya habia sido realizado previamente.',
        reservation: reservationView,
      };
    }

    if (reservationView.isExpired) {
      throw new BadRequestException('El horario de la reserva ya expiro.');
    }

    dbReservation.isCheckedIn = true;
    dbReservation.checkInAt = new Date();
    await dbReservation.save();

    const updatedReservationView = this.buildReservationCheckInView(dbReservation, guardian, schedule);
    return {
      success: true,
      message: 'Check-in realizado exitosamente.',
      reservation: updatedReservationView,
    };
  }

  async getReservationCheckInDetails(id: string, pin: string) {
    this.assertInspectorPin(pin);
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
                      html += '<li><strong>' + d.name + '</strong>' + (d.age ? ' (Edad: ' + d.age + ' años)' : '') + '</li>';
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

      let formattedDate = '';
      let formattedTime = '';
      const schedule = reservation.scheduleId ? await this.scheduleModel.findById(reservation.scheduleId).exec() : null;

      if (schedule && schedule.startTime) {
        const startTimeDate = new Date(schedule.startTime);
        formattedDate = startTimeDate.toLocaleDateString('es-CL', {
          timeZone: 'America/Santiago',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        });
        formattedTime = startTimeDate.toLocaleTimeString('es-CL', {
          timeZone: 'America/Santiago',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
      } else if (reservation.reservationDay) {
        formattedDate = new Date(reservation.reservationDay).toLocaleDateString('es-CL', {
          timeZone: 'America/Santiago',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        });
      }

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
                  <strong>Fecha y Hora de Reserva:</strong><br/>
                  ${formattedDate}${formattedTime ? ` · ${formattedTime} hrs.` : ''}
                </div>
                <p style="font-size: 13px; color: #dc2626; font-weight: bold;">Debes llegar con 20 minutos de anticipación al recinto.</p>
              </div>
            </div>
          </body>
        </html>
      `;
    } catch (error: any) {
      if (error.status === 409 || error.message?.includes('anteriormente')) {
        const isExpired = error.message?.includes('expiró');
        const title = isExpired ? 'Reserva Expirada' : 'Reserva Ya Gestionada';
        const headerColor = isExpired ? '#dc2626' : '#d97706';
        const iconColor = isExpired ? '#dc2626' : '#d97706';
        const boxBackground = isExpired ? '#fef2f2' : '#fffbeb';
        const boxBorder = isExpired ? '#fecaca' : '#fef3c7';
        const boxText = isExpired ? '#991b1b' : '#b45309';
        const introText = isExpired
          ? 'El tiempo de confirmación ya venció y esta reserva no puede confirmarse.'
          : 'Esta invitación ya fue respondida previamente.';

        return `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>${title}</title>
              <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f1f5f9; color: #1e293b; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
                .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); width: 100%; max-width: 480px; overflow: hidden; text-align: center; }
                .header { background: ${headerColor}; color: white; padding: 24px; }
                .header h1 { margin: 0; font-size: 22px; }
                .content { padding: 30px; }
                .icon { font-size: 48px; color: ${iconColor}; margin-bottom: 16px; }
                .warning-box { background-color: ${boxBackground}; border: 1px solid ${boxBorder}; color: ${boxText}; border-radius: 8px; padding: 16px; margin: 10px 0; font-size: 15px; line-height: 1.5; text-align: left; }
              </style>
            </head>
            <body>
              <div class="card">
                <div class="header">
                  <h1>${title}</h1>
                </div>
                <div class="content">
                  <div class="icon">⚠</div>
                  <p style="font-size: 16px; line-height: 1.5; color: #334155;">${introText}</p>
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
      if (error.status === 409 || error.message?.includes('anteriormente') || error.message?.includes('expiró')) {
        const isExpired = error.message?.includes('expiró');
        const title = isExpired ? 'Reserva Expirada' : 'Reserva Ya Gestionada';
        const headerColor = isExpired ? '#dc2626' : '#d97706';
        const iconColor = isExpired ? '#dc2626' : '#d97706';
        const boxBackground = isExpired ? '#fef2f2' : '#fffbeb';
        const boxBorder = isExpired ? '#fecaca' : '#fef3c7';
        const boxText = isExpired ? '#991b1b' : '#b45309';
        const introText = isExpired
          ? 'El tiempo para gestionar esta reserva ya venció y los cupos fueron liberados.'
          : 'Esta invitación ya fue respondida previamente.';

        return `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>${title}</title>
              <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f1f5f9; color: #1e293b; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
                .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); width: 100%; max-width: 480px; overflow: hidden; text-align: center; }
                .header { background: ${headerColor}; color: white; padding: 24px; }
                .header h1 { margin: 0; font-size: 22px; }
                .content { padding: 30px; }
                .icon { font-size: 48px; color: ${iconColor}; margin-bottom: 16px; }
                .warning-box { background-color: ${boxBackground}; border: 1px solid ${boxBorder}; color: ${boxText}; border-radius: 8px; padding: 16px; margin: 10px 0; font-size: 15px; line-height: 1.5; text-align: left; }
              </style>
            </head>
            <body>
              <div class="card">
                <div class="header">
                  <h1>${title}</h1>
                </div>
                <div class="content">
                  <div class="icon">⚠</div>
                  <p style="font-size: 16px; line-height: 1.5; color: #334155;">${introText}</p>
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
      width: 600,
      margin: 4,
      errorCorrectionLevel: 'Q',
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

    if (reservation.checkMail === true) {
      throw new ConflictException('Esta reserva ya fue confirmada anteriormente.');
    }

    if (reservation.checkMail === false) {
      throw new ConflictException(`Esta reserva expiró por falta de confirmación dentro de ${this.getReservationConfirmTtlLabel()} y los cupos ya fueron liberados.`);
    }

    if (!reservation.state_reserve) {
      throw new BadRequestException('Esta reserva ya no está activa.');
    }

    reservation.checkMail = true;
    reservation.checkMailDate = new Date();
    const savedReservation = await reservation.save();

    return savedReservation;
  }

  async cancelEmail(id: string): Promise<Reservation> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Id de reserva inválido');
    }

    const session = await this.reservationModel.db.startSession();
    let updatedScheduleAfterCancel: any = null;
    let cancelledReservation: any = null;
    const cancelContext: { identityPayload?: ReservationIdentityPayload } = {};

    try {
      await session.withTransaction(async () => {
        const reservation = await this.reservationModel.findById(id).session(session);

        if (!reservation) {
          throw new NotFoundException('Reserva no encontrada');
        }

        if (reservation.checkMail === true) {
          throw new ConflictException('Esta reserva ya fue confirmada anteriormente y no puede cancelarse por correo.');
        }

        if (reservation.checkMail === false) {
          throw new ConflictException(`Esta reserva ya expiró por falta de confirmación dentro de ${this.getReservationConfirmTtlLabel()} y sus cupos ya fueron liberados.`);
        }

        if (!reservation.state_reserve) {
          throw new BadRequestException('Esta reserva ya fue cancelada.');
        }

        const identityPayload = await this.getIdentityPayloadForReservation(reservation);
        if (identityPayload) {
          cancelContext.identityPayload = identityPayload;
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
      this.schedulesGateway.broadcastSpotsUpdate(cancelledReservation.scheduleId.toString(), updatedScheduleAfterCancel.availableSpots);
    }

    if (cancelContext.identityPayload) {
      await this.updateEventIdentityCounters({
        eventType: cancelContext.identityPayload.eventType,
        ruts: cancelContext.identityPayload.ruts,
        email: cancelContext.identityPayload.email,
        phone: cancelContext.identityPayload.phone,
        delta: -1,
        context: 'cancelEmail',
      });
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
    const expireContext: { identityPayload?: ReservationIdentityPayload } = {};

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

        const identityPayload = await this.getIdentityPayloadForReservation(reservation);
        if (identityPayload) {
          expireContext.identityPayload = identityPayload;
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
      this.logger.log(`Reserva ${id} EXPIRADA automáticamente por falta de confirmación en ${this.getReservationConfirmTtlLabel()}. Cupos devueltos al scheduleId=${expiredReservation.scheduleId}. Disponibles: ${updatedScheduleAfterExpiry.availableSpots}`);
      this.schedulesGateway.broadcastSpotsUpdate(expiredReservation.scheduleId.toString(), updatedScheduleAfterExpiry.availableSpots);
      if (expireContext.identityPayload) {
        await this.updateEventIdentityCounters({
          eventType: expireContext.identityPayload.eventType,
          ruts: expireContext.identityPayload.ruts,
          email: expireContext.identityPayload.email,
          phone: expireContext.identityPayload.phone,
          delta: -1,
          context: 'expireReservation',
        });
      }
      return { success: true, message: 'Reserva expirada automáticamente por inactividad y cupos liberados.' };
    }

    return { success: false, message: 'No se pudo expirar la reserva.' };
  }

}
