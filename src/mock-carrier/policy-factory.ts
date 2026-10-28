import {
  NORMALIZED_POLICY_SCHEMA_VERSION,
  type NormalizedPolicy,
} from '../contracts/normalized-policy.js';
import { intBetween, pick, seededRandom } from './prng.js';

/**
 * Deterministic synthetic policy generator. The same (carrierId, policyId) always yields the
 * same policy, so repeated retrievals are byte-for-byte identical and idempotent writes can be
 * verified by content hash. All data is fabricated: names come from short generic lists, emails
 * use the reserved example.com domain, and VINs are random strings that are not valid VINs.
 */
const FIRST_NAMES = ['Avery', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Quinn', 'Taylor', 'Skyler'];
const LAST_NAMES = ['Lindqvist', 'Okafor', 'Nakamura', 'Ferreira', 'Kowalski', 'Haddad', 'Brennan'];
const STREETS = ['Maple Ave', 'Harbor St', 'Summit Rd', 'Juniper Ln', 'Cedar Ct', 'Willow Way'];
const CITIES: Array<[string, string, string]> = [
  ['Springfield', 'IL', '62701'],
  ['Columbus', 'OH', '43004'],
  ['Austin', 'TX', '73301'],
  ['Boise', 'ID', '83702'],
  ['Raleigh', 'NC', '27601'],
];
const VEHICLES: Array<[string, string]> = [
  ['Toyota', 'Camry'],
  ['Honda', 'Civic'],
  ['Ford', 'F-150'],
  ['Subaru', 'Outback'],
  ['Tesla', 'Model 3'],
];
const VIN_ALPHABET = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

export function buildSyntheticPolicy(carrierId: string, policyId: string): NormalizedPolicy {
  const random = seededRandom('policy', carrierId, policyId);
  const lastName = pick(random, LAST_NAMES);
  const holderFirst = pick(random, FIRST_NAMES);
  const [city, state, postalCode] = pick(random, CITIES);
  const effectiveYear = intBetween(random, 2025, 2026);
  const effectiveMonth = intBetween(random, 1, 12);
  const effectiveDate = isoDate(effectiveYear, effectiveMonth, intBetween(random, 1, 28));
  const termMonths = pick(random, [6, 12] as const);
  const expirationDate = addMonths(effectiveDate, termMonths);

  const vehicleCount = intBetween(random, 1, 3);
  const vehicles = Array.from({ length: vehicleCount }, () => {
    const [make, model] = pick(random, VEHICLES);
    return { vin: vin(random), year: intBetween(random, 2008, 2026), make, model };
  });

  const drivers: NormalizedPolicy['drivers'] = [
    {
      firstName: holderFirst,
      lastName,
      dateOfBirth: isoDate(intBetween(random, 1960, 2000), intBetween(random, 1, 12), 15),
      licenseState: state,
      relationship: 'named_insured',
    },
  ];
  if (random() < 0.5) {
    drivers.push({
      firstName: pick(random, FIRST_NAMES),
      lastName,
      dateOfBirth: isoDate(intBetween(random, 1960, 2006), intBetween(random, 1, 12), 3),
      licenseState: state,
      relationship: pick(random, ['spouse', 'dependent'] as const),
    });
  }

  return {
    schemaVersion: NORMALIZED_POLICY_SCHEMA_VERSION,
    carrierId,
    policyId,
    status: pick(random, ['active', 'active', 'active', 'pending', 'expired'] as const),
    effectiveDate,
    expirationDate,
    premium: {
      amountCents: intBetween(random, 45_000, 240_000),
      currency: 'USD',
      billingFrequency: pick(random, ['monthly', 'semi_annual', 'annual'] as const),
    },
    policyholder: {
      firstName: holderFirst,
      lastName,
      dateOfBirth: drivers[0]!.dateOfBirth,
      email: `${holderFirst}.${lastName}.${policyId}`.toLowerCase() + '@example.com',
      address: {
        line1: `${intBetween(random, 10, 9999)} ${pick(random, STREETS)}`,
        city,
        state,
        postalCode,
      },
    },
    coverages: [
      {
        type: 'bodily_injury_liability',
        limitPerPersonCents: 5_000_000,
        limitPerOccurrenceCents: 10_000_000,
        deductibleCents: null,
      },
      {
        type: 'property_damage_liability',
        limitPerPersonCents: null,
        limitPerOccurrenceCents: 5_000_000,
        deductibleCents: null,
      },
      {
        type: 'collision',
        limitPerPersonCents: null,
        limitPerOccurrenceCents: null,
        deductibleCents: pick(random, [50_000, 100_000]),
      },
    ],
    vehicles,
    drivers,
  };
}

function vin(random: () => number): string {
  let out = '';
  for (let i = 0; i < 17; i += 1) out += VIN_ALPHABET[Math.floor(random() * VIN_ALPHABET.length)];
  return out;
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  return isoDate(Math.floor(total / 12), (total % 12) + 1, d);
}

/** Variants of contract-breaking payloads served by the `schema_violation` fault. */
export function buildSchemaViolation(
  policy: NormalizedPolicy,
  random: () => number,
): Record<string, unknown> {
  const variant = Math.floor(random() * 3);
  const broken: Record<string, unknown> = structuredClone(policy);
  if (variant === 0) {
    // Premium as a formatted string instead of integer cents.
    broken.premium = { ...policy.premium, amountCents: '$1,204.00' };
  } else if (variant === 1) {
    // Required field missing.
    delete broken.policyholder;
  } else {
    // Unknown enum value, as if the carrier introduced a new status.
    broken.status = 'in_force';
  }
  return broken;
}
