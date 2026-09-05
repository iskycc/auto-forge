-- Keyset traversal must not sort the remaining full suite on every page.
CREATE INDEX case_suite_items_member_page_idx ON case_suite_items(suite_id,id);
CREATE INDEX case_suite_ddt_items_member_page_idx ON case_suite_ddt_items(suite_id,id);
CREATE INDEX case_sources_object_page_idx ON case_sources(project_id,object_key);
