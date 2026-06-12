import { IsMongoId, IsBoolean, IsArray, IsString } from 'class-validator';

export class CreateReservationDto {
  @IsMongoId({ message: 'scheduleId must be a valid MongoDB ID' })
  scheduleId: string;

  @IsMongoId({ message: 'guardianId must be a valid MongoDB ID' })
  guardianId: string;

  @IsBoolean()
  guardianParticipates: boolean;

  @IsArray()
  @IsString({ each: true })
  attendingDependents: string[];
}
