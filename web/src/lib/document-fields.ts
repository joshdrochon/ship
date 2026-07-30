import type { BelongsTo, BelongsToType } from '@ship/shared';

/**
 * Runtime readers for the loosely-typed document payload.
 *
 * `DocumentResponse` (see `document-tabs.tsx`) extends `Record<string, unknown>` because
 * `GET /api/documents/:id` flattens a JSONB `properties` column onto the row, so which
 * fields are present depends on `document_type`. That is an honest description of the
 * payload, but it left every tab component asserting field types with `as`, which is not
 * a check — it is the compiler being told to stop asking.
 *
 * These readers check instead. Each one takes `unknown` and returns the field's declared
 * type, falling back to the same value the API itself falls back to (`null` for
 * `accountable_id`, `[]` for `consulted_ids`, and so on), so a malformed or absent field
 * yields a defined value rather than an `undefined` that the types claimed was impossible.
 */

/** A JSON object as it arrives from the API, before any field has been narrowed. */
export type UnknownFields = Readonly<Record<string, unknown>>;

/** A person reference as `GET /api/documents/:id` returns it for `owner`. */
export interface DocumentPersonRef {
  id: string;
  name: string;
  email: string;
}

/** True for a non-null JSON object — arrays excluded, since they index differently. */
export function isFields(value: unknown): value is UnknownFields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a field off a payload whose keys are not statically known. */
export function readField(source: unknown, key: string): unknown {
  return isFields(source) ? source[key] : undefined;
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function readStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readBooleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Read a string array, dropping any element that is not a string. */
export function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

export function readFields(value: unknown): UnknownFields | undefined {
  return isFields(value) ? value : undefined;
}

/**
 * Read the `owner` object.
 *
 * `id` is the identity and is required — without it the reference selects nobody. `name`
 * and `email` come from a LEFT JOIN in the API (`COALESCE(properties->>'email', u.email)`)
 * and can both be null for a person document whose `user_id` has no matching user row, so
 * they fall back to `''` rather than discarding an otherwise usable reference.
 */
export function readPersonRef(value: unknown): DocumentPersonRef | null {
  if (!isFields(value)) return null;
  const id = readString(value.id);
  if (id === undefined) return null;
  return { id, name: readString(value.name) ?? '', email: readString(value.email) ?? '' };
}

const BELONGS_TO_TYPES: readonly BelongsToType[] = ['program', 'project', 'sprint', 'parent'];

function isBelongsToType(value: unknown): value is BelongsToType {
  return BELONGS_TO_TYPES.some((known) => known === value);
}

/**
 * Read the `belongs_to` association array, dropping entries the API could not join —
 * `document_associations` rows survive a LEFT JOIN miss, so `id` or `type` can be absent.
 */
export function readBelongsTo(value: unknown): BelongsTo[] {
  if (!Array.isArray(value)) return [];
  const out: BelongsTo[] = [];
  for (const entry of value) {
    if (!isFields(entry)) continue;
    const id = readString(entry.id);
    if (id === undefined || !isBelongsToType(entry.type)) continue;
    const title = readString(entry.title);
    const color = readString(entry.color);
    out.push({
      id,
      type: entry.type,
      ...(title !== undefined && { title }),
      ...(color !== undefined && { color }),
    });
  }
  return out;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
