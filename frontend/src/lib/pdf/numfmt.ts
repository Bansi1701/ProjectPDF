/**
 * Excel number formats.
 *
 * A cell holds `1234.5`; the sheet shows `$1,234.50`. The difference is a
 * format code stored alongside it, and a converter that ignores those prints
 * numbers nobody recognises — a currency column as bare floats, a percentage
 * as `0.075`, an invoice total missing its symbol.
 *
 * This implements the part of the format language that real workbooks use:
 * sections, literals, thousands separators, fixed decimals, percentages and
 * currency prefixes. It deliberately does not implement fractions, scientific
 * notation or colour conditions — those fall back to a plain number rather
 * than being rendered wrong.
 */

/** Built-in format ids that mean a date or a time. */
export const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** The built-in codes worth reproducing; the rest fall back to plain. */
const BUILTIN: Record<number, string> = {
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  37: '#,##0;-#,##0',
  38: '#,##0;-#,##0',
  39: '#,##0.00;-#,##0.00',
  40: '#,##0.00;-#,##0.00',
  44: '"$"#,##0.00',
};

export const builtinCode = (id: number): string => BUILTIN[id] ?? '';

/** Splits a format on `;`, ignoring separators inside quotes or brackets. */
function sections(code: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let bracketed = false;

  for (let i = 0; i < code.length; i += 1) {
    const character = code[i];
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === '[') bracketed = true;
    else if (!quoted && character === ']') bracketed = false;

    if (character === ';' && !quoted && !bracketed) {
      out.push(current);
      current = '';
      continue;
    }
    current += character;
  }

  out.push(current);
  return out;
}

const groupThousands = (digits: string): string =>
  digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Formats `value` with an Excel format code.
 *
 * Returns null when the code is one this does not implement, so the caller can
 * fall back to a plain number rather than show something misleading.
 */
export function formatNumber(value: number, code: string): string | null {
  if (!code) return null;

  const parts = sections(code);
  // Positive; negative; zero. A negative section implies its own sign.
  const section =
    value < 0 && parts.length > 1 ? parts[1] : value === 0 && parts.length > 2 ? parts[2] : parts[0];

  if (!section || section.toLowerCase() === 'general') return null;
  // Fractions, scientific notation and text placeholders are out of scope.
  if (/[?eE]|@/.test(section.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, ''))) return null;

  let prefix = '';
  let suffix = '';
  let numeric = '';
  let seenDigit = false;
  let percent = 0;

  for (let i = 0; i < section.length; i += 1) {
    const character = section[i];

    if (character === '"') {
      const end = section.indexOf('"', i + 1);
      const literal = section.slice(i + 1, end < 0 ? section.length : end);
      if (seenDigit) suffix += literal;
      else prefix += literal;
      i = end < 0 ? section.length : end;
      continue;
    }

    if (character === '[') {
      const end = section.indexOf(']', i);
      const inside = section.slice(i + 1, end < 0 ? section.length : end);
      // `[$€-407]` carries a currency symbol; `[Red]` and `[<100]` do not.
      if (inside.startsWith('$')) {
        const symbol = inside.slice(1).split('-')[0];
        if (seenDigit) suffix += symbol;
        else prefix += symbol;
      }
      i = end < 0 ? section.length : end;
      continue;
    }

    if (character === '\\' || character === '_') {
      // `\x` escapes a literal; `_x` reserves the width of one. Both consume
      // the next character.
      const next = section[i + 1] ?? '';
      if (character === '\\') {
        if (seenDigit) suffix += next;
        else prefix += next;
      }
      i += 1;
      continue;
    }

    if (character === '%') {
      percent += 1;
      if (seenDigit) suffix += '%';
      else prefix += '%';
      continue;
    }

    if ('#0.,'.includes(character)) {
      seenDigit = true;
      numeric += character;
      continue;
    }

    if (seenDigit) suffix += character;
    else prefix += character;
  }

  if (!numeric) return null;

  let scaled = value * 100 ** percent;
  if (value < 0 && parts.length > 1) scaled = Math.abs(scaled);

  // Trailing commas before the decimal point scale by thousands.
  const scaleMatch = /,+(?=(\.|$))/.exec(numeric);
  if (scaleMatch) {
    scaled /= 1000 ** scaleMatch[0].length;
    numeric = numeric.replace(/,+(?=(\.|$))/, '');
  }

  const [intPart, fracPart = ''] = numeric.split('.');
  const decimals = (fracPart.match(/[0#]/g) ?? []).length;
  const minDigits = (intPart.match(/0/g) ?? []).length;
  const grouped = intPart.includes(',');

  const fixed = Math.abs(scaled).toFixed(decimals);
  let [whole, fraction = ''] = fixed.split('.');

  if (whole.length < minDigits) whole = whole.padStart(minDigits, '0');
  if (minDigits === 0 && whole === '0' && decimals > 0) whole = '';
  if (grouped) whole = groupThousands(whole);

  // `#.##` shows only the decimals that exist; `0.00` shows them all.
  if (fraction && !fracPart.includes('0')) fraction = fraction.replace(/0+$/, '');

  const sign = scaled < 0 || (value < 0 && parts.length === 1) ? '-' : '';
  const body = fraction ? `${whole}.${fraction}` : whole;

  return `${sign}${prefix}${body}${suffix}`;
}

/**
 * Excel counts days from 1899-12-30 — the odd epoch absorbs its belief that
 * 1900 was a leap year, inherited from Lotus 1-2-3. Workbooks first saved on
 * a Mac may instead count from 1904-01-01, and getting that wrong shifts every
 * date in the file by four years and a day.
 */
export function serialToDate(serial: number, date1904: boolean): string {
  const shifted = date1904 ? serial + 1462 : serial;
  const ms = Math.round((shifted - 25569) * 86400 * 1000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(serial);

  const iso = date.toISOString();
  // A whole number is a date; a fraction carries a time of day.
  return serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** True when a format code renders its value as a date or a time. */
export function isDateCode(code: string): boolean {
  // Strip literals and conditions so a currency "d" or a [Red] cannot count.
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  if (!/[ymdhs]/i.test(bare)) return false;
  // A pure number format never contains a letter outside those literals.
  return !/^[#0.,%\s]*$/.test(bare);
}
