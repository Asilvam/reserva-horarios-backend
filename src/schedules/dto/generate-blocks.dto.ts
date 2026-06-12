import { IsString, IsNumber, Matches, Min } from 'class-validator';

export class GenerateBlocksDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha debe tener formato YYYY-MM-DD' })
  date: string; // Ej: '2026-06-15'

  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'Formato HH:MM' })
  startHour: string; // Ej: '09:00'

  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'Formato HH:MM' })
  endHour: string; // Ej: '14:00'

  @IsNumber()
  @Min(10)
  durationMinutes: number; // Ej: 30

  @IsNumber()
  @Min(1)
  totalCapacity: number; // Ej: 50

  @IsNumber()
  @Min(0)
  maxDependents: number; // Ej: 4
}
