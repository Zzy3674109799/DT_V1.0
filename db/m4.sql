CREATE TABLE IF NOT EXISTS merchants (
  id BIGSERIAL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  merchant_type TEXT NOT NULL DEFAULT 'club' CHECK (merchant_type IN ('club', 'scenic', 'brand', 'tourism_bureau')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coupons (
  id BIGSERIAL PRIMARY KEY,
  merchant_id BIGINT REFERENCES merchants(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('fixed', 'percent')),
  value INTEGER NOT NULL CHECK (value > 0),
  total_count INTEGER NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coupon_claims (
  id BIGSERIAL PRIMARY KEY,
  coupon_id BIGINT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  order_no TEXT,
  UNIQUE (coupon_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_claims_user ON coupon_claims(user_id, claimed_at DESC);

CREATE TABLE IF NOT EXISTS activities (
  id BIGSERIAL PRIMARY KEY,
  merchant_id BIGINT REFERENCES merchants(id) ON DELETE SET NULL,
  challenge_id INTEGER REFERENCES challenges(id) ON DELETE SET NULL,
  place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sponsor_label TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activities_status_start ON activities(status, start_at);

CREATE TABLE IF NOT EXISTS activity_orders (
  id BIGSERIAL PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  activity_id BIGINT NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  coupon_id BIGINT REFERENCES coupons(id) ON DELETE SET NULL,
  original_amount_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'refunded', 'cancelled')),
  provider TEXT NOT NULL DEFAULT 'mock' CHECK (provider IN ('mock', 'wechat')),
  transaction_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_activity_orders_user_created ON activity_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_orders_status_created ON activity_orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS activity_participants (
  activity_id BIGINT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES activity_orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'checked_in', 'cancelled')),
  checked_in_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (activity_id, user_id)
);

CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  order_no TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'processed' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS membership_plans (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  duration_days INTEGER NOT NULL DEFAULT 30,
  monthly_media_quota INTEGER NOT NULL DEFAULT 100,
  features_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden'))
);

CREATE TABLE IF NOT EXISTS membership_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES membership_plans(id),
  order_no TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'expired', 'cancelled')),
  provider TEXT NOT NULL DEFAULT 'mock' CHECK (provider IN ('mock', 'wechat')),
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memberships_user_end ON membership_subscriptions(user_id, status, end_at DESC);

ALTER TABLE challenges ADD COLUMN IF NOT EXISTS merchant_id BIGINT REFERENCES merchants(id) ON DELETE SET NULL;
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS sponsor_label TEXT;

INSERT INTO membership_plans (code, name, price_cents, duration_days, monthly_media_quota, features_json) VALUES
  ('free', '山野基础版', 0, 36500, 100, '{"media":"standard","challenge":"public"}'),
  ('explorer', '行者会员', 1990, 30, 1000, '{"media":"高清","challenge":"advanced","pack":"plus"}'),
  ('summit', '登峰年卡', 12900, 365, 12000, '{"media":"原图","challenge":"premium","pack":"pro"}')
ON CONFLICT (code) DO NOTHING;

INSERT INTO merchants (owner_id, name, merchant_type, status)
SELECT 'demo-user', '行迹山河官方', 'brand', 'active'
WHERE EXISTS (SELECT 1 FROM app_users WHERE id = 'demo-user')
  AND NOT EXISTS (SELECT 1 FROM merchants WHERE owner_id = 'demo-user' AND name = '行迹山河官方');

INSERT INTO activities (merchant_id, challenge_id, place_id, title, description, sponsor_label, start_at, end_at, capacity, price_cents, status)
SELECT m.id, 1, 2, '泰山秋日登顶挑战', '和 PACK 一起完成泰山登顶，解锁官方赛季徽章。', '行迹山河官方', NOW() + INTERVAL '14 days', NOW() + INTERVAL '15 days', 50, 9900, 'published'
FROM merchants m WHERE m.name = '行迹山河官方'
  AND NOT EXISTS (SELECT 1 FROM activities WHERE title = '泰山秋日登顶挑战');

INSERT INTO coupons (merchant_id, code, name, discount_type, value, total_count, starts_at, ends_at, status)
SELECT m.id, 'WELCOME1000', '首场活动立减券', 'fixed', 1000, 100, NOW(), NOW() + INTERVAL '180 days', 'active'
FROM merchants m WHERE m.name = '行迹山河官方'
  AND NOT EXISTS (SELECT 1 FROM coupons WHERE code = 'WELCOME1000');

