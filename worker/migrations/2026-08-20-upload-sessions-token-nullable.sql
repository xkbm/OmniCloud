-- 2026-08-20: upload_sessions.token made nullable
-- Context: Session 12 removed the dead upload-session token from uploads.js,
-- but the DB column stayed NOT NULL, breaking every upload with a 500
-- (null value in column "token" violates not-null constraint).
-- The column is now nullable; the UNIQUE index allows multiple NULLs.

ALTER TABLE upload_sessions ALTER COLUMN token DROP NOT NULL;
ALTER TABLE upload_sessions DROP CONSTRAINT IF EXISTS upload_sessions_token_not_null;