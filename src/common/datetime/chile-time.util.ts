const CHILE_TIME_ZONE = 'America/Santiago';

function getZonedDateParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

export function chileLocalDateTimeToUtc(date: string, hour: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hourPart, minutePart] = hour.split(':').map(Number);

  let utcDate = new Date(Date.UTC(year, month - 1, day, hourPart, minutePart, 0));

  for (let i = 0; i < 5; i++) {
    const parts = getZonedDateParts(utcDate, CHILE_TIME_ZONE);
    const desiredUtcMs = Date.UTC(year, month - 1, day, hourPart, minutePart, 0);
    const currentUtcMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const diff = desiredUtcMs - currentUtcMs;

    if (diff === 0) {
      break;
    }

    utcDate = new Date(utcDate.getTime() + diff);
  }

  return utcDate;
}

export function getChileDateKey(date: Date): string {
  const parts = getZonedDateParts(date, CHILE_TIME_ZONE);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');

  return `${parts.year}-${month}-${day}`;
}

export function getChileStartOfDayUtc(date: Date): Date {
  const chileDate = getChileDateKey(date);
  return chileLocalDateTimeToUtc(chileDate, '00:00');
}

export function getChileDateTimeLabel(date: Date): string {
  return new Intl.DateTimeFormat('es-CL', {
    timeZone: CHILE_TIME_ZONE,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(date);
}
