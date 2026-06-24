import { IsString, Matches } from 'class-validator';

const EVENT_TYPE_REGEX = /^[a-z0-9_-]{2,30}$/i;

export class AdmissionEventDto {
  @IsString()
  @Matches(EVENT_TYPE_REGEX, {
    message: 'eventType must contain 2-30 alphanumeric characters, dashes or underscores',
  })
  eventType: string;
}
