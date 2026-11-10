ALTER TABLE case_suites ADD COLUMN locked_by TEXT;
ALTER TABLE case_suites ADD COLUMN locked_by_name TEXT;
ALTER TABLE case_suites ADD COLUMN locked_at TEXT;
ALTER TABLE ddt_import_jobs ADD COLUMN overwrite_reason TEXT;
ALTER TABLE ddt_case_history ADD COLUMN change_reason TEXT;
