ALTER TABLE public_suite_execution_links ADD COLUMN environment_revision INTEGER NOT NULL DEFAULT 0 CHECK (environment_revision >= 0);
ALTER TABLE public_suite_execution_links ADD COLUMN environment_state_json TEXT;
