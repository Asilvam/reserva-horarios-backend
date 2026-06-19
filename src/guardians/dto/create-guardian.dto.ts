import { IsString, IsEmail, IsOptional, IsBoolean } from 'class-validator';

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

  @IsString()
  @IsOptional()
  emergencyName?: string;

  @IsString()
  @IsOptional()
  emergencyPhone?: string;

  @IsBoolean()
  @IsOptional()
  acceptMarketing?: boolean;
}
