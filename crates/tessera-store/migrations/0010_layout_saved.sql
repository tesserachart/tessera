-- Tessera local database, schema 10: a workspace saves like a document. `body` is the copy the desk shows and every
-- change writes; `saved` is the copy the user last saved, kept only while the two differ (NULL: no unsaved changes).

ALTER TABLE layouts ADD COLUMN saved TEXT;
