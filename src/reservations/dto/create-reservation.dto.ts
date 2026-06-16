import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsMongoId, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

export class AttendingDependentDto {
  @IsString()
  name: string;

  @IsString()
  rut: string;
}

export class CreateReservationDto {
  @IsMongoId({ message: 'scheduleId must be a valid MongoDB ID' })
  scheduleId: string;

  @IsMongoId({ message: 'guardianId must be a valid MongoDB ID' })
  guardianId: string;

  @IsBoolean()
  guardianParticipates: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttendingDependentDto)
  attendingDependents: AttendingDependentDto[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
