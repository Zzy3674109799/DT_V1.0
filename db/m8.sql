-- M8 退款状态与媒体异步处理任务
ALTER TABLE activity_orders ADD COLUMN IF NOT EXISTS refund_no TEXT;
ALTER TABLE activity_orders ADD COLUMN IF NOT EXISTS refund_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE activity_orders ADD COLUMN IF NOT EXISTS refund_transaction_id TEXT;
ALTER TABLE activity_orders ADD COLUMN IF NOT EXISTS refund_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE activity_orders DROP CONSTRAINT IF EXISTS activity_orders_refund_status_check;
ALTER TABLE activity_orders ADD CONSTRAINT activity_orders_refund_status_check
  CHECK (refund_status IN ('none', 'requested', 'processing', 'success', 'failed'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_orders_refund_no
  ON activity_orders(refund_no) WHERE refund_no IS NOT NULL;

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS moderated_by TEXT REFERENCES app_users(id) ON DELETE SET NULL;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS moderation_note TEXT;

CREATE TABLE IF NOT EXISTS media_jobs (
  id BIGSERIAL PRIMARY KEY,
  media_id BIGINT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('metadata', 'thumbnail', 'transcode', 'moderation')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (media_id, job_type)
);
CREATE INDEX IF NOT EXISTS idx_media_jobs_pick
  ON media_jobs(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_media_jobs_media ON media_jobs(media_id, created_at DESC);
