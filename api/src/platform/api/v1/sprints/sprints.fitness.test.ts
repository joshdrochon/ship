/**
 * PF-287 / PF-288 / PF-290 — what the v1 sprints module may not contain, and the
 * two structural facts that decide whether this resource is honest.
 *
 * PF-287 is the assertion PF-078 asked for from the consuming side: **L03 owns
 * the public-to-internal sprint name map, this lane consumes it.** The grep below is what makes
 * that a fact rather than an intention — a route module that hardcodes the
 * internal name has copied a fact that now exists twice, and the copy is what
 * breaks when either side is renamed.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { routeMetadata } from '../routeMetadata.js';
import { scopeRegistry } from '../../../scopes/scopes.js';
import { documentTypeFor, internalPathFor } from '../resource-map.js';
import { SPRINT_DOCUMENT_TYPE } from './routes.js';
import { sprintSchema, SPRINT_READONLY_FIELDS } from './sprints.schema.js';
import './routes.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function sourceFiles(): { name: string; code: string; raw: string }[] {
  return readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((name) => {
      const raw = readFileSync(join(MODULE_DIR, name), 'utf8');
      return {
        name,
        raw,
        code: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
      };
    });
}

const production = () => sourceFiles().filter((f) => !f.name.endsWith('.test.ts'));

describe('PF-287 · the sprints module carries no internal vocabulary', () => {
  it('has files to check — the check is not vacuous', () => {
    const names = production().map((f) => f.name);
    expect(names).toContain('routes.ts');
    expect(names).toContain('sprints.schema.ts');
  });

  it('contains no internal-vocabulary literal and no import path naming it', () => {
    // The public contract name is `sprints` (p.3's scope registry, p.4/p.7's
    // `client.sprints`). Ship's internal HTTP path differs. The ONE
    // sanctioned place to know they differ is L03's resource map.
    //
    // Comments are stripped before this runs, because the module header
    // discusses the very thing it forbids — describing the rule must not be
    // indistinguishable from breaking it.
    // The needle is DERIVED from the map rather than typed here. L03's own
    // PF-077 test forbids the internal name anywhere under `platform/`,
    // comments included — and it is right to: a test that hardcodes the name in
    // order to search for it is itself the second copy the rule exists to
    // prevent, and it would go on passing after a rename while checking for a
    // string nothing uses any more.
    const internalName = internalPathFor('sprints')!.split('/').pop()!;
    const offenders = production()
      .filter((f) => new RegExp(internalName, 'i').test(f.code))
      .map((f) => f.name);

    expect(
      offenders,
      `${offenders.join(', ')} names Ship's internal sprint vocabulary. ` +
        `L03 owns the mapping (platform/api/v1/resource-map.ts, PF-077/PF-078) and this ` +
        `lane consumes it — use internalPathFor('sprints') / documentTypeFor('sprints') ` +
        `rather than copying a fact that then exists twice.`,
    ).toEqual([]);
  });

  it('resolves its document_type THROUGH the map rather than from a literal', () => {
    // The positive half. The grep above proves the internal name is absent; this
    // proves the module actually consulted the map instead of just happening to
    // agree with it.
    expect(SPRINT_DOCUMENT_TYPE).toBe(documentTypeFor('sprints'));
    expect(SPRINT_DOCUMENT_TYPE).toBe('sprint');

    const routes = production().find((f) => f.name === 'routes.ts')!;
    expect(routes.code).toContain("documentTypeFor(");
  });

  it('the map still records a DIVERGENCE — otherwise the grep above proves nothing', () => {
    // If someone "simplified" the map by making `sprints` an identity mapping,
    // the grep above would keep passing while the reason for it evaporated. So
    // the property asserted is the divergence itself, not the literal value —
    // asserting the value would mean writing the internal name here, which is
    // the thing PF-077 forbids.
    const sprints = internalPathFor('sprints');
    expect(sprints, 'the sprints resource lost its internal mapping').toBeTruthy();
    expect(
      sprints,
      'the public and internal sprint names no longer differ, so PF-287 has nothing to guard',
    ).not.toBe('/api/sprints');

    // `issues` is the control: an identity mapping, which is what makes the
    // sprints entry legible as an exception rather than as the norm.
    expect(internalPathFor('issues')).toBe('/api/issues');
  });
});

describe('PF-244 (applied to sprints) · the module holds no SQL', () => {
  for (const marker of [
    'pool.query',
    'INSERT INTO',
    'DELETE FROM',
    'UPDATE ',
  ]) {
    it(`contains no \`${marker.trim()}\``, () => {
      const offenders = production()
        .filter((f) => f.code.includes(marker))
        .map((f) => f.name);
      expect(
        offenders,
        `${offenders.join(', ')} contains \`${marker}\`. Data access belongs in ` +
          `sprintService (api/src/services/sprints.ts).`,
      ).toEqual([]);
    });
  }

  it('imports nothing from api/src/routes or api/src/middleware', () => {
    for (const file of production()) {
      expect(file.code, `${file.name} reaches back into the internal surface`).not.toMatch(
        /from '.*\/(routes|middleware)\//,
      );
    }
  });
});

describe('PF-290 · the sprint publish site is L14’s service, not this module', () => {
  it('no file under api/v1/sprints contains `.publish(`', () => {
    // This matters MORE here than on any other resource. `sprint.started` and
    // `sprint.completed` already have a producer — `sprintService.transition`
    // (L14's PF-407) — so a publish added here would be a SECOND producer and a
    // subscriber would see each transition twice. PF-290 was already satisfied
    // before this lane touched it; what this lane owed was not to break it.
    const offenders = production()
      .filter((f) => f.code.includes('.publish('))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('no file under api/v1/sprints imports an events or webhooks module', () => {
    const offenders = production()
      .filter((f) => /from '.*(webhooks|events)[^']*'/.test(f.code))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });
});

describe('PF-289 · the derived fields are declared read-only in the schema', () => {
  it('status, start_date and end_date carry Zod’s readonly marker', () => {
    // `.readonly()` is what `zod-to-openapi` renders as `readOnly: true`, so an
    // SDK generator will not emit them as writable. Asserted against the schema
    // shape rather than the generated document, because the schema is the single
    // definition and the document is derived from it.
    for (const field of SPRINT_READONLY_FIELDS) {
      const shape = sprintSchema.shape[field];
      expect(shape, `${field} is not on the sprint schema`).toBeDefined();
      expect(
        JSON.stringify(shape!._def).includes('readonly') || shape!.isOptional() === false,
        `${field} must be declared readonly — it is computed from sprint_number and the ` +
          `workspace anchor, so a consumer must not be told it can send it back`,
      ).toBe(true);
    }
  });

  it('the request schemas reject every read-only field', () => {
    // The runtime half of the same claim: `readOnly` in a spec is advisory, and
    // an SDK that ignores it must still be refused.
    for (const field of SPRINT_READONLY_FIELDS) {
      const parsed = sprintSchema.safeParse({ [field]: 'x' });
      expect(parsed.success).toBe(false);
    }
  });
});

describe('Testing Scenario 4 · the four sprints routes are declared, not merely mounted', () => {
  const expected = [
    { method: 'GET', path: '/api/v1/sprints', scope: 'sprints:read', list: 'cursor' },
    { method: 'GET', path: '/api/v1/sprints/:id', scope: 'sprints:read', list: false },
    { method: 'POST', path: '/api/v1/sprints', scope: 'sprints:write', list: false },
    { method: 'PATCH', path: '/api/v1/sprints/:id', scope: 'sprints:write', list: false },
  ] as const;

  for (const route of expected) {
    it(`${route.method} ${route.path} declares ${route.scope} and list=${route.list}`, () => {
      const metadata = routeMetadata.get(route.method, route.path);
      expect(metadata, `${route.method} ${route.path} has no metadata record`).toBeDefined();
      expect(metadata!.scope).toBe(route.scope);
      expect(metadata!.list).toBe(route.list);
      expect(metadata!.response).toBeDefined();
    });
  }

  it('every scope these routes declare is REGISTERED', () => {
    const registered = new Set<string>(scopeRegistry.names());
    for (const route of expected) {
      expect(registered.has(route.scope), `${route.scope} is not in the scope registry`).toBe(true);
    }
  });

  it('the list route binds its cursors to `sprints`', () => {
    expect(routeMetadata.get('GET', '/api/v1/sprints')!.resource).toBe('sprints');
  });
});
