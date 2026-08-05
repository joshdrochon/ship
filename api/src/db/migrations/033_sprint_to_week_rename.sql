-- Rename sprint-related document types to week terminology
-- Part of Sprint → Week rename refactor

-- Rename document_type enum values
-- PostgreSQL 10+ supports ALTER TYPE ... RENAME VALUE
--
-- Guarded, because this migration is unrunnable on a FRESH database. migrate.ts
-- applies schema.sql first, and schema.sql carries current state — which already
-- names these labels weekly_*. The bare rename then raises
--   "sprint_plan" is not an existing enum label
-- which aborts the whole run, so 034-037 are never even attempted and never get
-- recorded in schema_migrations.
--
-- Nothing structural was actually lost: schema.sql already contains everything
-- 035 creates, and 034/036/037 are data backfills that are no-ops against an
-- empty database. But the deploy log showed a migration failure on every fresh
-- database, including the one a destroy-and-redeploy produces — alarming, and
-- exactly the moment you least want it.
--
-- Both sides are checked, not just the source. Migration 017 re-adds
-- 'sprint_review' with ADD VALUE IF NOT EXISTS, so on a fresh database BOTH the
-- old and new labels exist by the time this runs and a rename would collide on
-- the target. The old label is then left orphaned in the enum, which is inert —
-- Postgres cannot drop an enum value, and nothing reads it.
--
-- Safe to change after the fact: any database that ran this successfully has
-- 033 recorded in schema_migrations and will never execute it again.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'document_type' AND e.enumlabel = 'sprint_plan'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'document_type' AND e.enumlabel = 'weekly_plan'
  ) THEN
    ALTER TYPE document_type RENAME VALUE 'sprint_plan' TO 'weekly_plan';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'document_type' AND e.enumlabel = 'sprint_retro'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'document_type' AND e.enumlabel = 'weekly_retro'
  ) THEN
    ALTER TYPE document_type RENAME VALUE 'sprint_retro' TO 'weekly_retro';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'document_type' AND e.enumlabel = 'sprint_review'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'document_type' AND e.enumlabel = 'weekly_review'
  ) THEN
    ALTER TYPE document_type RENAME VALUE 'sprint_review' TO 'weekly_review';
  END IF;
END $$;

-- Note: We keep 'sprint' as a document_type because it represents the sprint document itself.
-- The terminology change is "Sprint 3" → "Week of Jan 27" in UI, but the underlying
-- document concept remains valid. The sprint document stores sprint_number and owner_id
-- for derived 7-day windows.

-- Update accountability_type values in issue properties
-- Sprint-related accountability types become week-related
UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"weekly_plan"')
WHERE properties->>'accountability_type' = 'sprint_plan';

UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"weekly_review"')
WHERE properties->>'accountability_type' = 'sprint_review';

UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"week_start"')
WHERE properties->>'accountability_type' = 'sprint_start';

UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"week_issues"')
WHERE properties->>'accountability_type' = 'sprint_issues';
