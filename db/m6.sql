-- P0 媒体上传基础字段与配额统计
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS byte_size BIGINT NOT NULL DEFAULT 0;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS duration_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'local';
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_media_owner_month ON media_assets(owner_id, created_at DESC);
