/** Reserved source logs must survive retention until their verified archive is cleaned or cancelled. */
export function unreservedArchiveBatch(batchIdColumn: string): string {
  return `NOT EXISTS(SELECT 1 FROM log_archive_batches ax JOIN log_archive_jobs aj ON aj.id=ax.archive_id WHERE ax.batch_id=${batchIdColumn} AND ax.state<>'cleaned' AND aj.status<>'cancelled')
    AND NOT EXISTS(SELECT 1 FROM log_archive_jobs sj JOIN run_batches sb ON sb.id=${batchIdColumn}
      WHERE sj.group_id IS NOT NULL AND sj.cancel_requested_at IS NULL
      AND (sj.status IN ('queued','building','verifying') OR (sj.status='failed' AND sj.object_key IS NULL) OR (sj.status IN ('ready','cleaning','completed') AND sj.next_volume_pending=1))
      AND sb.updated_at>=sj.month_start_at AND sb.updated_at<sj.month_end_at AND sb.updated_at<=sj.source_cutoff_at
      AND (sj.project_id IS NULL OR sb.project_id=sj.project_id))`;
}
