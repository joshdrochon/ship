import { describe, it, expect } from 'vitest';
import {
  isFields,
  readBelongsTo,
  readBooleanOrNull,
  readField,
  readFields,
  readNumberOrNull,
  readPersonRef,
  readString,
  readStringArray,
  readStringOrNull,
} from './document-fields';

/**
 * `DocumentResponse` types every document-type-specific field as `unknown`, because
 * `GET /api/documents/:id` flattens a JSONB column onto the row. Tab components used to
 * bridge that with `as` assertions, which cannot fail — the wrong runtime type simply
 * flowed on into React with the compiler satisfied.
 *
 * Each test below feeds a reader the wrong type and asserts it produces the documented
 * fallback instead. Against an `as` assertion every one of them would have passed the
 * wrong value through.
 */

describe('readNumberOrNull', () => {
  it('accepts finite numbers, including 0', () => {
    expect(readNumberOrNull(0)).toBe(0);
    expect(readNumberOrNull(7)).toBe(7);
  });

  it('rejects numeric strings — JSONB round-trips can produce them', () => {
    expect(readNumberOrNull('7')).toBeNull();
  });

  it('rejects NaN and Infinity, which would poison an ICE score', () => {
    expect(readNumberOrNull(NaN)).toBeNull();
    expect(readNumberOrNull(Infinity)).toBeNull();
  });

  it('maps absent and null to null', () => {
    expect(readNumberOrNull(undefined)).toBeNull();
    expect(readNumberOrNull(null)).toBeNull();
  });
});

describe('readString / readStringOrNull', () => {
  it('returns the string when present', () => {
    expect(readString('#3b82f6')).toBe('#3b82f6');
    expect(readStringOrNull('notes')).toBe('notes');
  });

  it('rejects non-strings rather than passing them through', () => {
    expect(readString(42)).toBeUndefined();
    expect(readString(null)).toBeUndefined();
    expect(readStringOrNull(42)).toBeNull();
    expect(readStringOrNull(undefined)).toBeNull();
  });
});

describe('readBooleanOrNull', () => {
  it('returns the boolean when present', () => {
    expect(readBooleanOrNull(true)).toBe(true);
    expect(readBooleanOrNull(false)).toBe(false);
  });

  it('does not coerce truthy values', () => {
    expect(readBooleanOrNull('true')).toBeNull();
    expect(readBooleanOrNull(1)).toBeNull();
    expect(readBooleanOrNull(null)).toBeNull();
  });
});

describe('readStringArray', () => {
  it('returns the array of strings', () => {
    expect(readStringArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns [] for absent, null and non-array values', () => {
    expect(readStringArray(undefined)).toEqual([]);
    expect(readStringArray(null)).toEqual([]);
    expect(readStringArray('a')).toEqual([]);
  });

  it('drops non-string elements instead of handing them to a key prop', () => {
    expect(readStringArray(['a', 3, null, 'b'])).toEqual(['a', 'b']);
  });
});

describe('isFields / readFields / readField', () => {
  it('treats a plain object as fields', () => {
    expect(isFields({ a: 1 })).toBe(true);
    expect(readFields({ a: 1 })).toEqual({ a: 1 });
  });

  it('rejects null and arrays, which index differently', () => {
    expect(isFields(null)).toBe(false);
    expect(isFields([1, 2])).toBe(false);
    expect(readFields(null)).toBeUndefined();
    expect(readFields([1, 2])).toBeUndefined();
  });

  it('reads a key off an unknown payload without throwing', () => {
    expect(readField({ impact: 3 }, 'impact')).toBe(3);
    expect(readField({ impact: 3 }, 'ease')).toBeUndefined();
    expect(readField(null, 'impact')).toBeUndefined();
  });
});

describe('readPersonRef', () => {
  it('returns the reference when complete', () => {
    expect(readPersonRef({ id: 'u1', name: 'Ada', email: 'ada@example.gov' })).toEqual({
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.gov',
    });
  });

  it('keeps the reference when the API LEFT JOIN left name/email null', () => {
    // Only `owner?.id` is read downstream, so an id-only owner is still usable.
    expect(readPersonRef({ id: 'u1', name: null, email: null })).toEqual({
      id: 'u1',
      name: '',
      email: '',
    });
  });

  it('returns null without an id, since the reference then selects nobody', () => {
    expect(readPersonRef({ name: 'Ada' })).toBeNull();
    expect(readPersonRef(null)).toBeNull();
    expect(readPersonRef('u1')).toBeNull();
  });
});

describe('readBelongsTo', () => {
  it('reads well-formed associations', () => {
    expect(
      readBelongsTo([
        { id: 'p1', type: 'program', title: 'Platform', color: '#111' },
        { id: 'p2', type: 'project' },
      ])
    ).toEqual([
      { id: 'p1', type: 'program', title: 'Platform', color: '#111' },
      { id: 'p2', type: 'project' },
    ]);
  });

  it('omits title and color rather than setting them to null', () => {
    expect(readBelongsTo([{ id: 'p1', type: 'program', title: null, color: null }])).toEqual([
      { id: 'p1', type: 'program' },
    ]);
  });

  it('drops entries with an unknown relationship type', () => {
    expect(readBelongsTo([{ id: 'p1', type: 'nonsense' }])).toEqual([]);
  });

  it('drops entries the API could not join, where id is null', () => {
    expect(readBelongsTo([{ id: null, type: 'program' }, { id: 'p2', type: 'program' }])).toEqual([
      { id: 'p2', type: 'program' },
    ]);
  });

  it('returns [] when belongs_to is absent — it is only sent for some document types', () => {
    expect(readBelongsTo(undefined)).toEqual([]);
    expect(readBelongsTo({})).toEqual([]);
  });
});
