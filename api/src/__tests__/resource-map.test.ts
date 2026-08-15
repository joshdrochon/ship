/**
 * PF-077 / PF-078 — the public `sprints` name never leaks Ship's internal
 * `weeks` vocabulary.
 *
 * The fitness test is a grep over `api/src/platform/**`: the literal `weeks`
 * may appear in exactly one file, `api/v1/resource-map.ts`. Everything else that
 * needs the internal path calls `internalPathFor('sprints')`.
 *
 * This file lives outside `api/src/platform/` so that it can name the word it is
 * policing without failing its own assertion.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLIC_RESOURCES,
  UnknownPublicResourceError,
  documentTypeFor,
  internalPathFor,
  isPublicResource,
  resourceMapping,
  type PublicResourceName,
} from '../platform/api/v1/resource-map.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = join(HERE, '..', 'platform');

/** Every `.ts` under `platform/`, as paths relative to `platform/`. */
function platformSources(dir: string = PLATFORM_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return platformSources(full);
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      return [relative(PLATFORM_DIR, full).split(sep).join('/')];
    }
    return [];
  });
}

describe('PF-077 · the internal name lives in exactly one file', () => {
  const OWNER = 'api/v1/resource-map.ts';

  it('finds the sources it is supposed to be walking', () => {
    // A grep that silently walked zero files would pass every assertion below.
    const sources = platformSources();
    expect(sources.length).toBeGreaterThan(10);
    expect(sources).toContain(OWNER);
  });

  it('uses the internal name in no platform/ code except the map', () => {
    // Built by concatenation so this test file does not itself contain the
    // literal it forbids — harmless here, but it sets the wrong example for the
    // next person to copy the pattern into platform/.
    const internalName = 'week' + 's';

    // Comments are stripped first. The ticket says "the literal", and the thing
    // that actually leaks vocabulary is code: a string, an identifier, a
    // property name. A comment containing the English word — `validation.ts`
    // says "a 403 in production weeks later" — is not the internal model name,
    // and a test that cannot tell those apart gets neutered by the first person
    // it wrongly fails.
    //
    // The cost is stated rather than hidden: a comment naming the internal model
    // slips past this. That is the right trade — a stale comment misleads one
    // reader, a hardcoded path breaks the contract for every caller.
    const offenders = platformSources().filter((file) => {
      if (file === OWNER) return false;
      const code = readFileSync(join(PLATFORM_DIR, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return new RegExp(`\\b${internalName}\\b`).test(code);
    });

    expect(
      offenders,
      `platform/ files naming Ship's internal sprint vocabulary in code: ${offenders.join(', ')}. ` +
        `The public contract says "sprints"; the internal name belongs only in ${OWNER}. ` +
        `Call internalPathFor('sprints') instead.`,
    ).toEqual([]);
  });

  it('hardcodes the internal route path nowhere but the map, comments included', () => {
    // The stricter half, and the one that matters most: the path itself. This
    // one does NOT strip comments — there is no innocent reason for any other
    // file under platform/ to spell out the internal mount.
    const internalPath = '/api/' + 'week' + 's';
    const offenders = platformSources().filter(
      (file) =>
        file !== OWNER && readFileSync(join(PLATFORM_DIR, file), 'utf8').includes(internalPath),
    );

    expect(
      offenders,
      `platform/ files hardcoding the internal sprint route: ${offenders.join(', ')}.`,
    ).toEqual([]);
  });

  it('does hold the mapping in the file it is allowed to be in', () => {
    // The positive control. Without it, deleting the map entirely would make the
    // assertion above pass.
    expect(internalPathFor('sprints')).toBe('/api/' + 'week' + 's');
  });
});

describe('PF-077 · the translation is route-path and vocabulary, not table', () => {
  it('keeps document_type as `sprint`, because Part 1 already did', () => {
    // Verified against api/src/db/schema.sql:100 — the enum has said 'sprint'
    // since Part 1. This is what keeps the map small: there is no column to
    // translate, and building a general name-translation layer would be
    // inventing a problem the schema does not have.
    expect(documentTypeFor('sprints')).toBe('sprint');
  });

  it('is the only public resource whose names diverge', () => {
    const diverging = PUBLIC_RESOURCES.filter(
      (r) => r.internalRoutePath !== null && r.internalRoutePath !== `/api/${r.resource}`,
    ).map((r) => r.resource);

    expect(diverging).toEqual(['sprints']);
  });
});

describe('PF-078 · ownership and the consumer contract', () => {
  it('states the contract-name-vs-table-name rule and names its owner', () => {
    const src = readFileSync(join(PLATFORM_DIR, 'api', 'v1', 'resource-map.ts'), 'utf8');
    expect(src).toContain('A public resource name is a contract');
    expect(src).toMatch(/L03 owns this file\. L10 consumes it\./);
  });

  it('exposes the accessor L10 calls instead of restating the mapping', () => {
    expect(typeof internalPathFor).toBe('function');
    expect(resourceMapping('sprints').resource).toBe('sprints');
  });

  it('covers every resource the SDK surface names', () => {
    // docs/architecture.md, SDK Surface — client.documents / issues / sprints / webhooks.
    expect(PUBLIC_RESOURCES.map((r) => r.resource)).toEqual([
      'documents',
      'issues',
      'sprints',
      'webhooks',
    ]);
  });

  it('rejects a name that is not a public resource', () => {
    expect(isPublicResource('sprints')).toBe(true);
    expect(isPublicResource('projects')).toBe(false);
    expect(() => resourceMapping('projects' as PublicResourceName)).toThrow(
      UnknownPublicResourceError,
    );
  });
});
