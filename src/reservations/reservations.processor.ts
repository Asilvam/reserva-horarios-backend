import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ReservationsService, ReservationQueuePayload } from './reservations.service';

@Processor('reservation-queue')
export class ReservationProcessor extends WorkerHost {
  private readonly logger = new Logger(ReservationProcessor.name);

  constructor(private readonly reservationsService: ReservationsService) {
    super();
  }

  async process(job: Job<any>): Promise<unknown> {
    if (job.name === 'expire-reservation') {
      this.logger.log(`Procesando expiración automática para la reserva: ${job.data.reservationId}`);
      return this.reservationsService.expireReservation(job.data.reservationId);
    }

    this.logger.log(`Procesando job ${job.id} para guardianId=${job.data.dto.guardianId}`);
    return this.reservationsService.createReservation(job.data.dto, job.data.authUser);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job, result: unknown) {
    this.logger.log(`Job ${job.id} completado con exito. Resultado: ${JSON.stringify(result)}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error) {
    this.logger.error(`Job ${job?.id ?? 'unknown'} fallo. Razon: ${err.message}`);
  }
}
