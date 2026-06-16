import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { InjectModel } from '@nestjs/mongoose';
import { Schedule } from './entities/schedule.entity';
import { Model, Types } from 'mongoose';
import { GenerateBlocksDto } from './dto/generate-blocks.dto';
import { chileLocalDateTimeToUtc } from '../common/datetime/chile-time.util';

@Injectable()
export class SchedulesService {
  constructor(@InjectModel(Schedule.name) private scheduleModel: Model<Schedule>) {}

  async generateDailyBlocks(dto: GenerateBlocksDto) {
    const { date, startHour, endHour, durationMinutes, totalCapacity, maxDependents, eventType } = dto;

    // 1. Convertir fecha/hora local Chile a UTC para persistir sin desfases
    const startTime = chileLocalDateTimeToUtc(date, startHour);
    const endTime = chileLocalDateTimeToUtc(date, endHour);

    if (startTime >= endTime) {
      throw new BadRequestException('La hora de inicio debe ser estrictamente anterior a la hora de fin.');
    }

    const existingBlocksCount = await this.scheduleModel.countDocuments({
      startTime: {
        $gte: startTime,
        $lt: endTime,
      },
      eventType,
    });

    if (existingBlocksCount > 0) {
      throw new ConflictException(
        `Ya existen ${existingBlocksCount} bloques horarios en el rango indicado.`,
      );
    }

    const blocksToInsert: Partial<Schedule>[] = [];

    // Clonamos la hora de inicio para iterar
    let currentBlockTime = new Date(startTime.getTime());

    // 2. Bucle principal: mientras el bloque actual sea menor a la hora de cierre
    while (currentBlockTime < endTime) {
      // Opcional: Validar que el bloque más su duración no exceda la hora de cierre
      const nextBlockTime = new Date(currentBlockTime.getTime());
      nextBlockTime.setMinutes(nextBlockTime.getMinutes() + durationMinutes);

      if (nextBlockTime > endTime) {
        break; // Evitamos generar un bloque que termine después del horario de cierre
      }

      // Preparamos el documento a insertar
      blocksToInsert.push({
        startTime: new Date(currentBlockTime.getTime()),
        durationMinutes,
        totalCapacity,
        availableSpots: totalCapacity, // Se inicializa lleno
        maxDependentsPerReservation: maxDependents,
        eventType,
      });

      // Avanzamos el reloj a la hora del siguiente bloque
      currentBlockTime = nextBlockTime;
    }

    if (blocksToInsert.length === 0) {
      throw new BadRequestException('El rango de horas es muy corto para generar al menos un bloque.');
    }

    // 3. Inserción Masiva en MongoDB
    // insertMany es atómico a nivel de documento y altamente performante
    const insertedBlocks = await this.scheduleModel.insertMany(blocksToInsert);

    return {
      message: `Se han generado ${insertedBlocks.length} bloques horarios correctamente.`,
      blocksCreated: insertedBlocks.length,
      firstBlock: insertedBlocks[0].startTime,
      lastBlock: insertedBlocks[insertedBlocks.length - 1].startTime,
    };
  }

  create(createScheduleDto: CreateScheduleDto) {
    return 'This action adds a new schedule';
  }

  findAll(eventType?: string) {
    const filter = eventType ? { eventType } : {};
    return this.scheduleModel.find(filter).sort({ startTime: 1 }).exec();
  }

  async findOne(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Id de horario invalido');
    }

    const schedule = await this.scheduleModel.findById(id).exec();

    if (!schedule) {
      throw new NotFoundException('Horario no encontrado');
    }

    return schedule;
  }

  update(id: number, updateScheduleDto: UpdateScheduleDto) {
    return `This action updates a #${id} schedule`;
  }

  remove(id: number) {
    return `This action removes a #${id} schedule`;
  }
}
