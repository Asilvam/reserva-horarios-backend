import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Reservation } from './entities/reservation.entity';
import { Schedule } from '../schedules/entities/schedule.entity';
import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GuardiansService } from '../guardians/guardians.service';

@Injectable()
export class ReservationsService {
  constructor(
    @InjectModel(Reservation.name) private reservationModel: Model<Reservation>,
    @InjectModel(Schedule.name) private scheduleModel: Model<Schedule>,
    private guardiansService: GuardiansService,
  ) {}

  async createReservation(dto: CreateReservationDto) {
    await this.guardiansService.findById(dto.guardianId);

    const schedule = await this.scheduleModel.findById(dto.scheduleId);
    if (!schedule) throw new BadRequestException('Horario no encontrado');
    if (dto.attendingDependents.length > schedule.maxDependentsPerReservation) {
      throw new BadRequestException(`Máximo ${schedule.maxDependentsPerReservation} cargas permitidas.`);
    }
    const spotsToConsume = (dto.guardianParticipates ? 1 : 0) + dto.attendingDependents.length;

    if (spotsToConsume === 0) {
      throw new BadRequestException('La reserva debe consumir al menos 1 cupo.');
    }

    const updatedSchedule = await this.scheduleModel.findOneAndUpdate(
      {
        _id: dto.scheduleId,
        availableSpots: { $gte: spotsToConsume }, // Condición: cupos >= a los requeridos
      },
      {
        $inc: { availableSpots: -spotsToConsume }, // Restar los cupos
      },
      { returnDocument: 'after' },
    );

    if (!updatedSchedule) {
      throw new ConflictException('No hay suficientes cupos disponibles para esta reserva.');
    }

    const newReservation = new this.reservationModel({
      ...dto,
      totalSpotsConsumed: spotsToConsume,
    });

    return await newReservation.save();
  }

  findAll() {
    return this.reservationModel.find().sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Id de reserva invalido');
    }

    const reservation = await this.reservationModel.findById(id).exec();

    if (!reservation) {
      throw new NotFoundException('Reserva no encontrada');
    }

    return reservation;
  }

  update(id: number, updateReservationDto: UpdateReservationDto) {
    return `This action updates a #${id} reservation`;
  }

  remove(id: number) {
    return `This action removes a #${id} reservation`;
  }
}
