// NEGATIVE FIXTURE (PF-718) — integrations/browser-demo.
//
// The honest version of the violation: `@ship/shared` is types-only, it is
// already in the lockfile, and importing a `DocumentType` union from it feels
// like reuse rather than a boundary crossing. It is still a second door into
// this repository, and a browser bundle that resolves it ships whatever that
// package's barrel drags along.
import type { DocumentType } from '@ship/shared';

export const violation: DocumentType | null = null;
