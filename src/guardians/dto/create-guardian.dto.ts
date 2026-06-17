import { IsString, IsEmail, IsArray, ValidateNested, IsOptional, IsNumber, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';

class DependentDto {
  @IsString()
  name: string;

  @IsString()
  rut: string;

  @IsNumber()
  age: number;
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

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  commune?: string;

  @IsString()
  @IsOptional()
  villa?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DependentDto)
  @IsOptional()
  dependents?: DependentDto[];

  @IsBoolean()
  @IsOptional()
  acceptMarketing?: boolean;

  @IsBoolean()
  @IsOptional()
  acceptDataTerms?: boolean;
}
