-- Execution history owns these snapshots independently of the live task configuration.
ALTER TABLE case_suite_versions DROP CONSTRAINT case_suite_versions_suite_id_fkey;
