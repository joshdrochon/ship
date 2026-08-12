// NEGATIVE FIXTURE (F24) — must fail `no-restricted-imports`.
// @ship/sdk is published standalone. This compiles inside the monorepo and
// breaks the moment a stranger runs `npm install @ship/sdk`.
import type { Document } from '@ship/shared';

export type Violation = Document;
