import { Module } from '@nestjs/common';
import { WspMetaService } from './wsp-meta.service';
import { WspMetaController } from './wsp-meta.controller';

@Module({
  providers: [WspMetaService],
  exports: [WspMetaService],
  controllers: [WspMetaController],
})
export class WspMetaModule {}
