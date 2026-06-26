import { Module } from '@nestjs/common';
import { AdmissionController } from './admission.controller';
import { AdmissionService } from './admission.service';

@Module({
  controllers: [AdmissionController],
  providers: [AdmissionService],
})
export class AdmissionModule {}
