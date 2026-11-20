ALTER TABLE case_suite_member_changes DROP CONSTRAINT case_suite_member_changes_operation_check;
ALTER TABLE case_suite_member_changes ADD CONSTRAINT case_suite_member_changes_operation_check
  CHECK (operation IN ('add', 'remove', 'markers'));
