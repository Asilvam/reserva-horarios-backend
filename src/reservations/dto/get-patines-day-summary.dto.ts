import { IsString, Matches } from 'class-validator';

export class GetPatinesDaySummaryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha debe tener formato YYYY-MM-DD' })
  date: string;
}
