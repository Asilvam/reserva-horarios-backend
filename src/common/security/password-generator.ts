import { randomInt } from 'crypto';

const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const NUMBERS = '0123456789';
const ALPHANUMERIC = `${UPPERCASE}${LOWERCASE}${NUMBERS}`;

function pick(chars: string): string {
  return chars[randomInt(0, chars.length)];
}

function shuffle(chars: string[]): string[] {
  const result = [...chars];

  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

export function generateGuardianPassword(): string {
  const length = 6;
  const passwordChars: string[] = [pick(UPPERCASE), pick(NUMBERS)];

  while (passwordChars.length < length) {
    passwordChars.push(pick(ALPHANUMERIC));
  }

  return shuffle(passwordChars).join('');
}
