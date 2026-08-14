/**
 * PF-370 — a real OpenAPI **3.1** validator, pinned, and proven to reject.
 *
 * MVP gate item 7 (p.2) asks for a spec *"validating against the OpenAPI schema
 * in a unit test"*. No JSON-schema validator existed in this repo before this
 * lane: `api/package.json` had no `ajv`, no `@apidevtools/swagger-parser`, no
 * `@readme/openapi-parser`.
 *
 * ## Why `@hyperjump/json-schema` and NOT Ajv — measured, not preferred
 *
 * Ajv was the first choice and it is wrong for this job. OpenAPI 3.1 aligned its
 * Schema Objects with JSON Schema **2020-12**, and the official meta-schema
 * expresses that hook as `"schema": { "$dynamicRef": "#meta" }` inside
 * `$defs/parameter`, resolving to a permissive `$defs/schema` that carries
 * `$dynamicAnchor: "meta"`.
 *
 * Ajv 8.17.1 (`ajv/dist/2020`, with `ajv-formats`) resolves that `$dynamicRef`
 * to the WRONG target. Measured on this repo's own generated document and on a
 * three-line fixture:
 *
 *     { name: 'limit', in: 'query', schema: { type: 'integer' } }
 *
 *     /paths/~1a/get/parameters/0/schema: must have required property 'name'
 *     /paths/~1a/get/parameters/0/schema: must have required property 'in'
 *     /paths/~1a/get/parameters/0/schema: must NOT have unevaluated properties
 *                                          [unevaluatedProperty="type"]
 *
 * — i.e. it applied the *Parameter* schema to the parameter's own `schema` value
 * and rejected a document that is valid. **A validator that wrongly rejects is
 * the same class of failure as one that accepts everything**: both make the test
 * a statement about the validator rather than about the spec. So Ajv and
 * `ajv-formats` were installed, measured, and removed.
 *
 * `@hyperjump/json-schema` implements 2020-12 including `$dynamicRef`, and its
 * `openapi-3-1` entry point **bundles** the OAS meta-schemas — no network at
 * test time, nothing the OpenAPI Initiative can revise underneath a CI run.
 *
 * ## `schema-base`, not `schema`
 *
 * `.../oas/3.1/schema` skips Schema Object validation entirely (its own
 * description says so). `.../oas/3.1/schema-base` additionally validates every
 * Schema Object against the OAS 3.1 dialect, which is the half that actually
 * checks the parts this generator produces. Both accept our document; the
 * stricter one is the one worth running.
 */
import { validate, type OutputUnit } from '@hyperjump/json-schema';
import { BASIC } from '@hyperjump/json-schema/experimental';
// Side-effect import: registering the OpenAPI 3.1 dialect, vocabularies and the
// bundled meta-schemas under their `spec.openapis.org` URIs. Without it,
// `validate()` tries to FETCH the meta-schema and fails offline.
import '@hyperjump/json-schema/openapi-3-1';

/**
 * The meta-schema this module validates against, bundled by the pinned package.
 *
 * `schema-base` rather than `latest`: an alias that follows a moving target is
 * an artifact that can change what "valid" means without a commit here.
 */
export const OPENAPI_31_SCHEMA_URI = 'https://spec.openapis.org/oas/3.1/schema-base';

export interface SchemaValidationResult {
  valid: boolean;
  /** One line per violation, naming the instance path and the keyword. Empty when valid. */
  errors: string[];
}

/**
 * Validates a document against the OpenAPI 3.1 meta-schema.
 *
 * Returns EVERY error rather than the first (`BASIC` output, not `FLAG`), and
 * formats each as an instance location plus the keyword that rejected it.
 * PF-371 requires the test to print every validator error path — a test that
 * reports `expected false to be true` against a 40 KB document costs an hour to
 * act on, and the entire value of this check is that it says where.
 */
export async function validateOpenApi31(document: unknown): Promise<SchemaValidationResult> {
  const output = await validate(OPENAPI_31_SCHEMA_URI, document as never, BASIC);
  if (output.valid) return { valid: true, errors: [] };

  return { valid: false, errors: collectErrors(output).map(formatUnit) };
}

/**
 * BASIC output is a flat list whose first unit is the root schema itself; drop
 * that one, it says nothing beyond "the document is invalid".
 */
function collectErrors(output: { errors?: OutputUnit[] }): OutputUnit[] {
  return (output.errors ?? []).filter((unit) => unit.absoluteKeywordLocation !== '#');
}

/**
 * `instanceLocation` is a JSON Pointer in URI form, so `/things/{id}` arrives as
 * `~1things~1%7Bid%7D`. Decoded here: the point of printing the path is that a
 * human can find the offending node, and percent-encoded braces defeat that.
 */
function formatUnit(unit: OutputUnit): string {
  let where: string;
  try {
    where = decodeURIComponent(unit.instanceLocation);
  } catch {
    where = unit.instanceLocation;
  }
  return `${where || '(root)'} — failed \`${unit.keyword}\` at ${unit.absoluteKeywordLocation}`;
}

/** Throws with every error path in the message. For callers that want a throw. */
export async function assertValidOpenApi31(document: unknown, label = 'document'): Promise<void> {
  const result = await validateOpenApi31(document);
  if (result.valid) return;
  throw new Error(
    `${label} is not a valid OpenAPI 3.1 document (${result.errors.length} error(s)) ` +
      `against ${OPENAPI_31_SCHEMA_URI}:\n` +
      result.errors.map((e) => `  ${e}`).join('\n'),
  );
}
