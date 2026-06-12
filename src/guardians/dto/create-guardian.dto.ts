import { IsString, IsEmail, IsArray, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

class DependentDto {
  @IsString()
  name: string;

  @IsString()
  rut: string;
}

export class CreateGuardianDto {
  @IsString()
  name: string;

  @IsString()
  rut: string;

  @IsEmail()
  email: string;

  @IsString()
  phone: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DependentDto)
  @IsOptional()
  dependents?: DependentDto[];
}
