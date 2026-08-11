-- Runner credential rotation: keep the previous credential briefly valid so an
-- agent that fails to persist the new credential can retry with the old one.
ALTER TABLE runners ADD COLUMN previous_credential_hash TEXT;
ALTER TABLE runners ADD COLUMN previous_credential_valid_until TEXT;
