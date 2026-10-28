/**
 * Parses an HTTP `Retry-After` header (RFC 9110 §10.2.3) into a delay in milliseconds.
 *
 * Accepts delta-seconds (`"120"`; fractional values are tolerated) and HTTP-dates
 * (`"Wed, 21 Oct 2015 07:28:00 GMT"`). Dates in the past yield 0. Anything unparseable
 * yields `undefined` so the caller falls back to its own backoff.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (header === null || header === undefined) return undefined;
  const value = header.trim();
  if (value === '') return undefined;

  if (/^\d+(\.\d+)?$/.test(value)) {
    return Math.round(Number(value) * 1000);
  }

  // Only attempt date parsing for values that look like an IMF-fixdate / RFC 850 / asctime
  // date; Date.parse is otherwise far too permissive (it accepts "1" or "-5").
  if (!/[a-z]{3}/i.test(value)) return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}
