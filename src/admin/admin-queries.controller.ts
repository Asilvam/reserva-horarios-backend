import { Controller, Get, Query } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Controller('admin')
export class AdminQueriesController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  private get db() {
    if (!this.connection.db) {
      throw new Error('MongoDB connection is not ready');
    }

    return this.connection.db;
  }

  @Get('reservations')
  async getReservations(@Query('eventType') eventType = 'selva') {
    const normalizedEventType = eventType.trim().toLowerCase();

    return this.db.collection('reservations').aggregate(this.baseReservationsPipeline(normalizedEventType)).toArray();
  }

  @Get('schedule-reservations')
  async getScheduleReservations(@Query('eventType') eventType = 'selva') {
    const normalizedEventType = eventType.trim().toLowerCase();

    return this.db.collection('reservations').aggregate([
      ...this.baseReservationsPipeline(normalizedEventType),
      {
        $group: {
          _id: '$scheduleId',
          eventType: { $first: '$eventType' },
          startTimeChile: { $first: '$fechaHoraChile' },
          sortFechaHora: { $first: '$sortFechaHora' },
          totalCapacity: { $first: '$totalCapacity' },
          availableSpots: { $first: '$availableSpots' },
          reservedSpots: {
            $sum: {
              $cond: ['$state_reserve', '$totalSpotsConsumed', 0],
            },
          },
          checkedInSpots: {
            $sum: {
              $cond: [
                { $and: ['$state_reserve', '$isCheckedIn'] },
                '$totalSpotsConsumed',
                0,
              ],
            },
          },
          reservationCount: {
            $sum: {
              $cond: ['$state_reserve', 1, 0],
            },
          },
          checkInCount: {
            $sum: {
              $cond: [
                { $and: ['$state_reserve', '$isCheckedIn'] },
                1,
                0,
              ],
            },
          },
          reservations: {
            $push: {
              _id: '$reservationId',
              idguardian: '$idguardian',
              nombre: '$nombre',
              rut: '$rut',
              correo: '$correo',
              telefono: '$telefono',
              state_reserve: '$state_reserve',
              isCheckedIn: '$isCheckedIn',
              checkInAtChile: '$checkInAtChile',
              attendingDependents: '$attendingDependents',
              totalSpotsConsumed: '$totalSpotsConsumed',
              createdAtChile: '$createdAtChile',
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          scheduleId: '$_id',
          eventType: 1,
          startTimeChile: 1,
          totalCapacity: { $ifNull: ['$totalCapacity', 0] },
          availableSpots: { $ifNull: ['$availableSpots', 0] },
          reservedSpots: 1,
          checkedInSpots: 1,
          reservationCount: 1,
          checkInCount: 1,
          reservations: 1,
        },
      },
      { $sort: { startTimeChile: 1 } },
    ]).toArray();
  }

  private baseReservationsPipeline(eventType: string) {
    return [
      { $match: { eventType } },
      {
        $addFields: {
          guardianObjId: {
            $convert: {
              input: '$guardianId',
              to: 'objectId',
              onError: null,
              onNull: null,
            },
          },
          scheduleObjId: {
            $convert: {
              input: '$scheduleId',
              to: 'objectId',
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $lookup: {
          from: 'guardians',
          localField: 'guardianObjId',
          foreignField: '_id',
          as: 'guardian',
        },
      },
      { $unwind: { path: '$guardian', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'schedules',
          localField: 'scheduleObjId',
          foreignField: '_id',
          as: 'schedule',
        },
      },
      { $unwind: { path: '$schedule', preserveNullAndEmptyArrays: true } },
      { $addFields: { sortFechaHora: '$schedule.startTime' } },
      { $sort: { sortFechaHora: 1, createdAt: 1 } },
      {
        $replaceRoot: {
          newRoot: {
            reservationId: { $toString: '$_id' },
            idguardian: { $toString: '$guardianId' },
            nombre: '$guardian.name',
            rut: '$guardian.rut',
            correo: '$guardian.email',
            telefono: '$guardian.phone',
            eventType: '$eventType',
            scheduleId: { $toString: '$scheduleId' },
            state_reserve: '$state_reserve',
            isCheckedIn: '$isCheckedIn',
            attendingDependents: '$attendingDependents',
            totalSpotsConsumed: '$totalSpotsConsumed',
            totalCapacity: '$schedule.totalCapacity',
            availableSpots: '$schedule.availableSpots',
            sortFechaHora: '$sortFechaHora',
            fechaHoraChile: {
              $cond: [
                { $ifNull: ['$schedule.startTime', false] },
                {
                  $dateToString: {
                    date: '$schedule.startTime',
                    timezone: 'America/Santiago',
                    format: '%d-%m-%Y %H:%M:%S',
                  },
                },
                null,
              ],
            },
            checkInAtChile: {
              $cond: [
                { $ifNull: ['$checkInAt', false] },
                {
                  $dateToString: {
                    date: '$checkInAt',
                    timezone: 'America/Santiago',
                    format: '%d-%m-%Y %H:%M:%S',
                  },
                },
                null,
              ],
            },
            checkMailDateChile: {
              $cond: [
                { $ifNull: ['$checkMailDate', false] },
                {
                  $dateToString: {
                    date: '$checkMailDate',
                    timezone: 'America/Santiago',
                    format: '%d-%m-%Y %H:%M:%S',
                  },
                },
                null,
              ],
            },
            createdAtChile: {
              $cond: [
                { $ifNull: ['$createdAt', false] },
                {
                  $dateToString: {
                    date: '$createdAt',
                    timezone: 'America/Santiago',
                    format: '%d-%m-%Y %H:%M:%S',
                  },
                },
                null,
              ],
            },
            checkMailDate: '$checkMailDate',
            createdAt: '$createdAt',
          },
        },
      },
    ];
  }

}
