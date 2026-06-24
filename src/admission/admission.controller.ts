import { Body, Controller, Get, Headers, Post, Query } from '@nestjs/common';
import { AdmissionService } from './admission.service';
import { AdmissionEventDto } from './dto/admission-event.dto';
import { AdmissionLeaveDto } from './dto/admission-leave.dto';
import { AdmissionStatusDto } from './dto/admission-status.dto';

@Controller('admission')
export class AdmissionController {
  constructor(private readonly admissionService: AdmissionService) {}

  @Post('enter')
  enter(@Body() body: AdmissionEventDto, @Headers('x-request-id') requestId?: string) {
    return this.admissionService.enter(body.eventType, requestId);
  }

  @Get('status')
  status(@Query() query: AdmissionStatusDto, @Headers('x-request-id') requestId?: string) {
    return this.admissionService.status(query.eventType, query.sessionId, requestId);
  }

  @Post('leave')
  leave(@Body() body: AdmissionLeaveDto, @Headers('x-request-id') requestId?: string) {
    return this.admissionService.leave(body.eventType, body.sessionId, requestId);
  }

  @Post('submit')
  submit(@Body() body: AdmissionLeaveDto, @Headers('x-request-id') requestId?: string) {
    return this.admissionService.markProcessing(body.eventType, body.sessionId, requestId);
  }
}
