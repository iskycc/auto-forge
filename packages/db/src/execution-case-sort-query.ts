/** Sort the execution snapshot, so later case renames cannot reorder history. */
export const EXECUTION_CASE_IDENTITY_SORT_SQL =
  "CASE WHEN run.case_type='ddt' THEN run.display_name ELSE run.class_name END";
