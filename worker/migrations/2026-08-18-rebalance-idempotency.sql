CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_jobs_rebalance_source_active
  ON transfer_jobs(source_file_id)
  WHERE operation='move'
    AND (payload->>'rebalance')='true'
    AND status IN ('queued', 'running', 'paused', 'verifying');
