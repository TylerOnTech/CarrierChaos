# NormalizedPolicy v1

The carrier-agnostic contract every integration must produce. It is defined as a Zod schema in
[`src/contracts/normalized-policy.ts`](../src/contracts/normalized-policy.ts) and enforced at the
boundary: a response that does not match is classified as `SCHEMA_VIOLATION` (non-retryable),
and nothing is persisted.

All data served by the mock carrier is synthetic. Names come from short generic lists, email
addresses use the reserved `example.com` domain, and VINs are random 17-character strings that
are not valid VINs.

## Fields

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `"normalized-policy/v1"` | Literal; lets consumers branch on contract version. |
| `carrierId` | string | Must equal the carrier that was called. |
| `policyId` | string | Must equal the policy that was requested. |
| `status` | `active` \| `pending` \| `cancelled` \| `expired` \| `lapsed` | Unknown values are rejected rather than passed through. |
| `effectiveDate`, `expirationDate` | `YYYY-MM-DD` | `effectiveDate < expirationDate`. |
| `premium.amountCents` | non-negative integer | Money is integer cents; no floating point. |
| `premium.currency` | `"USD"` | |
| `premium.billingFrequency` | `monthly` \| `semi_annual` \| `annual` | |
| `policyholder` | object | `firstName`, `lastName`, `dateOfBirth`, `email`, `address { line1, city, state (2 letters), postalCode (5 digits) }` |
| `coverages[]` | non-empty array | `type` (`bodily_injury_liability`, `property_damage_liability`, `collision`, `comprehensive`, `uninsured_motorist`, `medical_payments`), `limitPerPersonCents`, `limitPerOccurrenceCents`, `deductibleCents` (each integer cents or `null`) |
| `vehicles[]` | array | `vin` (17 chars, no I/O/Q), `year`, `make`, `model` |
| `drivers[]` | non-empty array | `firstName`, `lastName`, `dateOfBirth`, `licenseState`, `relationship` (`named_insured`, `spouse`, `dependent`, `other`) |

## Example

```json
{
  "schemaVersion": "normalized-policy/v1",
  "carrierId": "northwind",
  "policyId": "POL-SMOKE",
  "status": "expired",
  "effectiveDate": "2025-11-27",
  "expirationDate": "2026-11-27",
  "premium": { "amountCents": 176810, "currency": "USD", "billingFrequency": "monthly" },
  "policyholder": {
    "firstName": "Avery",
    "lastName": "Brennan",
    "dateOfBirth": "1988-09-15",
    "email": "avery.brennan.pol-smoke@example.com",
    "address": { "line1": "7744 Harbor St", "city": "Raleigh", "state": "NC", "postalCode": "27601" }
  },
  "coverages": [
    {
      "type": "bodily_injury_liability",
      "limitPerPersonCents": 5000000,
      "limitPerOccurrenceCents": 10000000,
      "deductibleCents": null
    }
  ],
  "vehicles": [{ "vin": "9NM167A5F1YCN1J05", "year": 2015, "make": "Honda", "model": "Civic" }],
  "drivers": [
    {
      "firstName": "Avery",
      "lastName": "Brennan",
      "dateOfBirth": "1988-09-15",
      "licenseState": "NC",
      "relationship": "named_insured"
    }
  ]
}
```

## Persistence

Validated policies are stored in `policy_records`, one row per `(carrier_id, policy_id)`:

- `content_hash` is the SHA-256 of the canonical (key-sorted) JSON.
- `version` increments only when `content_hash` changes, so re-fetching an unchanged policy is a
  no-op for consumers that track versions.
- `fetch_count` increments on every successful write, which makes duplicate effects visible
  when analyzing at-least-once behavior.

## Evolving the contract

Additive, optional fields can ship within v1. Removing or renaming fields, tightening enums, or
changing units requires `normalized-policy/v2`, with both versions accepted during migration.
Because unknown `status` values are rejected today, a carrier that introduces a new status shows
up as a `SCHEMA_VIOLATION` spike rather than as silently corrupted data. That trade is
deliberate.
