ALTER TABLE ai_model_leases ADD COLUMN job_id TEXT;
ALTER TABLE ai_model_leases ADD COLUMN stage TEXT CHECK (stage IN ('stack', 'group', 'individual'));
