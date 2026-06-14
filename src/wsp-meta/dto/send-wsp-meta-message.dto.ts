import { IsNotEmpty, IsString } from 'class-validator';

export class SendWspMetaMessageDto {
  @IsString()
  @IsNotEmpty()
  to: string;

  @IsString()
  @IsNotEmpty()
  text: string;
}
