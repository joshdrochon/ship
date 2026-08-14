// NEGATIVE FIXTURE (PF-009) — must fail `no-restricted-imports`.
// The public router reaching into an internal route file is the exact one-way-door
// violation the PRD calls out on p.11. Nothing imports this file; it is lint input.
import documentsRoutes from '../../../../api/src/routes/documents.js';

export const violation = documentsRoutes;
