ALTER TABLE case_versions ADD COLUMN source_id TEXT;

UPDATE case_versions version
SET source_id = definition.source_id
FROM case_definitions definition
WHERE definition.id = version.case_definition_id;

ALTER TABLE case_versions ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE case_versions
  ADD CONSTRAINT case_versions_source_id_case_sources_id_fk
  FOREIGN KEY (source_id) REFERENCES case_sources(id) ON DELETE RESTRICT;
CREATE INDEX case_versions_source_idx ON case_versions(source_id);
