-- Reverse membership and retired DDT references must stay indexed during source cleanup
-- and case membership filtering; a suite-first index cannot answer these lookups.
CREATE INDEX case_suite_items_definition_idx ON case_suite_items(case_definition_id);
CREATE INDEX ddt_deleted_cases_execution_class_idx ON ddt_deleted_cases(execution_case_definition_id);
