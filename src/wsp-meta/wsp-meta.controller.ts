import { Body, Controller, Get, Post } from '@nestjs/common';
import { WspMetaService } from './wsp-meta.service';
import { SendWspMetaMessageDto } from './dto/send-wsp-meta-message.dto';

@Controller('wsp-meta')
export class WspMetaController {
  constructor(private readonly wspMetaService: WspMetaService) {}

  @Get('status')
  getStatus() {
    return this.wspMetaService.getStatus();
  }

  @Post('send')
  async send(@Body() dto: SendWspMetaMessageDto) {
    await this.wspMetaService.sendTextMessage(dto.to, dto.text);
    return { ok: true };
  }
}
