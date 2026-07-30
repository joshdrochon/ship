#!/usr/bin/env bash
#
# Category 4 — EXPLAIN ANALYZE capture (brief p.5: "Provide before/after EXPLAIN ANALYZE
# output").
#
# Emits the plan for every statement Lane 4's change touches, plus the one statement the
# audit's "add an index" theory pointed at, so the before/after pair is comparable
# statement-for-statement. Run it once before the change and once after, redirecting to a
# file both times:
#
#   docs/audit/scripts/explain-cat4.sh > docs/audit/raw/cat4-explain-before.txt
#   docs/audit/scripts/explain-cat4.sh > docs/audit/raw/cat4-explain-after.txt
#
# Environment (defaults suit the Lane 4 worktree):
#   PG_CONTAINER=ship-postgres-1  PG_DB=ship_lane_4  PG_USER=ship
#
# The session statements need a session row to plan against, and sessions come and go, so
# the script inserts a fixture inside a transaction and rolls it back. Nothing it does is
# visible after it exits — importantly, the EXPLAIN ANALYZE'd UPDATE is really executed,
# so its cost is measured rather than estimated, and then discarded.
set -euo pipefail

CONTAINER="${PG_CONTAINER:-ship-postgres-1}"
DB="${PG_DB:-ship_lane_4}"
DBUSER="${PG_USER:-ship}"

run() { docker exec -i "$CONTAINER" psql -U "$DBUSER" -d "$DB" -X -q -v ON_ERROR_STOP=1 -f -; }

WS=$(docker exec "$CONTAINER" psql -U "$DBUSER" -d "$DB" -X -t -A \
  -c "SELECT id FROM workspaces ORDER BY created_at LIMIT 1")
UID_=$(docker exec "$CONTAINER" psql -U "$DBUSER" -d "$DB" -X -t -A \
  -c "SELECT user_id FROM workspace_memberships WHERE workspace_id = '$WS' ORDER BY user_id LIMIT 1")

echo "# Category 4 EXPLAIN ANALYZE capture"
echo "# database: $DB   workspace: $WS   user: $UID_"
echo "# generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# rows: $(docker exec "$CONTAINER" psql -U "$DBUSER" -d "$DB" -X -t -A -c 'SELECT count(*) FROM documents') documents"
echo

run <<SQL
\pset pager off

BEGIN;

INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
VALUES ('cat4-explain-fixture', '$UID_', '$WS', now() + interval '12 hours', now(), now());

\echo '=== A. auth middleware: session lookup (runs once per authenticated request) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT s.id, s.user_id, s.workspace_id, s.expires_at, s.last_activity, s.created_at,
       u.is_super_admin
  FROM sessions s
  JOIN users u ON s.user_id = u.id
 WHERE s.id = 'cat4-explain-fixture';

\echo ''
\echo '=== B. auth middleware: last_activity write (the statement Lane 4 throttles) ==='
EXPLAIN (ANALYZE, BUFFERS)
UPDATE sessions SET last_activity = now() WHERE id = 'cat4-explain-fixture';

\echo ''
\echo '=== C. auth middleware: workspace membership check ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM workspace_memberships WHERE workspace_id = '$WS' AND user_id = '$UID_';

ROLLBACK;

\echo ''
\echo '=== D. GET /api/documents list query (the index theory from W4-2/W4-3) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, workspace_id, document_type, title, parent_id, position,
       ticket_number, properties,
       created_at, updated_at, created_by, visibility
  FROM documents
 WHERE workspace_id = '$WS'
   AND archived_at IS NULL
   AND deleted_at IS NULL
   AND (visibility = 'workspace' OR created_by = '$UID_' OR FALSE = TRUE)
   AND document_type = 'issue'
 ORDER BY position ASC, created_at DESC;

\echo ''
\echo '=== E. index usage on documents (which index the planner actually reaches for) ==='
SELECT indexrelname, idx_scan, idx_tup_read
  FROM pg_stat_user_indexes
 WHERE relname = 'documents'
 ORDER BY idx_scan DESC;
SQL
