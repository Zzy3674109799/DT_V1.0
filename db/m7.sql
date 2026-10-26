-- P0 订单一致性：客户端幂等键和订单过期时间
ALTER TABLE activity_orders ADD COLUMN IF NOT EXISTS client_request_id TEXT;
ALTER TABLE activity_orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE activity_orders SET expires_at = created_at + INTERVAL '15 minutes' WHERE expires_at IS NULL AND status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_orders_client_request
  ON activity_orders(user_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_orders_expiry ON activity_orders(status, expires_at);
