import { z } from 'zod';

/**
 * NormalizedPolicy v1: the carrier-agnostic policy contract.
 *
 * Every carrier integration must produce exactly this shape. Responses are validated against it
 * before anything is persisted, so a carrier that drifts from the contract fails loudly
 * (SCHEMA_VIOLATION) instead of silently writing malformed data. Money is integer cents to avoid
 * floating-point rounding. Full field reference: docs/normalized-policy-v1.md.
 */
export const NORMALIZED_POLICY_SCHEMA_VERSION = 'normalized-policy/v1';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const cents = z.number().int().nonnegative();

export const PolicyStatusSchema = z.enum(['active', 'pending', 'cancelled', 'expired', 'lapsed']);

export const AddressSchema = z.object({
  line1: z.string().min(1),
  city: z.string().min(1),
  state: z.string().regex(/^[A-Z]{2}$/),
  postalCode: z.string().regex(/^\d{5}$/),
});

export const PolicyholderSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dateOfBirth: isoDate,
  email: z.email(),
  address: AddressSchema,
});

export const CoverageSchema = z.object({
  type: z.enum([
    'bodily_injury_liability',
    'property_damage_liability',
    'collision',
    'comprehensive',
    'uninsured_motorist',
    'medical_payments',
  ]),
  limitPerPersonCents: cents.nullable(),
  limitPerOccurrenceCents: cents.nullable(),
  deductibleCents: cents.nullable(),
});

export const VehicleSchema = z.object({
  vin: z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/),
  year: z.number().int().min(1980).max(2100),
  make: z.string().min(1),
  model: z.string().min(1),
});

export const DriverSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dateOfBirth: isoDate,
  licenseState: z.string().regex(/^[A-Z]{2}$/),
  relationship: z.enum(['named_insured', 'spouse', 'dependent', 'other']),
});

export const NormalizedPolicySchema = z
  .object({
    schemaVersion: z.literal(NORMALIZED_POLICY_SCHEMA_VERSION),
    carrierId: z.string().min(1),
    policyId: z.string().min(1),
    status: PolicyStatusSchema,
    effectiveDate: isoDate,
    expirationDate: isoDate,
    premium: z.object({
      amountCents: cents,
      currency: z.literal('USD'),
      billingFrequency: z.enum(['monthly', 'semi_annual', 'annual']),
    }),
    policyholder: PolicyholderSchema,
    coverages: z.array(CoverageSchema).min(1),
    vehicles: z.array(VehicleSchema),
    drivers: z.array(DriverSchema).min(1),
  })
  .refine((policy) => policy.effectiveDate < policy.expirationDate, {
    message: 'effectiveDate must be before expirationDate',
    path: ['expirationDate'],
  });

export type NormalizedPolicy = z.infer<typeof NormalizedPolicySchema>;
