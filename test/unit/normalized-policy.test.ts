import { describe, expect, it } from 'vitest';
import { NormalizedPolicySchema } from '../../src/contracts/normalized-policy.js';
import {
  buildSchemaViolation,
  buildSyntheticPolicy,
} from '../../src/mock-carrier/policy-factory.js';
import { sha256, stableStringify } from '../../src/shared/hash.js';

describe('NormalizedPolicy v1', () => {
  it('accepts every synthetic policy the mock carrier generates', () => {
    for (let i = 0; i < 300; i += 1) {
      const policy = buildSyntheticPolicy(i % 2 ? 'northwind' : 'bluepeak', `POL-${i}`);
      const result = NormalizedPolicySchema.safeParse(policy);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    }
  });

  it('generates identical content for the same policy (stable content hash)', () => {
    const a = buildSyntheticPolicy('northwind', 'POL-42');
    const b = buildSyntheticPolicy('northwind', 'POL-42');
    expect(sha256(stableStringify(a))).toBe(sha256(stableStringify(b)));
    expect(buildSyntheticPolicy('northwind', 'POL-43')).not.toEqual(a);
  });

  it('rejects each schema-violation variant', () => {
    const policy = buildSyntheticPolicy('northwind', 'POL-1');
    for (const r of [0.1, 0.5, 0.9]) {
      const broken = buildSchemaViolation(policy, () => r);
      expect(NormalizedPolicySchema.safeParse(broken).success).toBe(false);
    }
  });

  it('requires effectiveDate before expirationDate', () => {
    const policy = buildSyntheticPolicy('northwind', 'POL-1');
    const inverted = { ...policy, expirationDate: '2000-01-01' };
    expect(NormalizedPolicySchema.safeParse(inverted).success).toBe(false);
  });

  it('stores money as integer cents', () => {
    const policy = buildSyntheticPolicy('northwind', 'POL-1');
    expect(
      NormalizedPolicySchema.safeParse({
        ...policy,
        premium: { ...policy.premium, amountCents: 12.5 },
      }).success,
    ).toBe(false);
  });
});

describe('stableStringify', () => {
  it('is independent of key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      stableStringify({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
  });
});
