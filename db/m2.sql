ALTER TABLE places ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326);
ALTER TABLE places ADD COLUMN IF NOT EXISTS geofence_radius_m INTEGER NOT NULL DEFAULT 1500;
UPDATE places SET geom = ST_SetSRID(ST_MakePoint(lng, lat), 4326) WHERE geom IS NULL;
CREATE INDEX IF NOT EXISTS idx_places_geom ON places USING GIST (geom);

ALTER TABLE visits ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS accuracy_m DOUBLE PRECISION;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS location_geom geometry(Point, 4326);
ALTER TABLE visits ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'verified';
ALTER TABLE visits ADD COLUMN IF NOT EXISTS risk_level TEXT NOT NULL DEFAULT 'low';
ALTER TABLE visits ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES app_users(id) ON DELETE SET NULL;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_visits_location_geom ON visits USING GIST (location_geom);
CREATE INDEX IF NOT EXISTS idx_visits_verification ON visits(verification_status, created_at DESC);

ALTER TABLE challenges ADD COLUMN IF NOT EXISTS season_key TEXT NOT NULL DEFAULT '2026';
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS rule_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS scope_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES app_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_challenges_season_status ON challenges(season_key, status);

CREATE TABLE IF NOT EXISTS mountain_profiles (
  place_id INTEGER PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  elevation_gain_m INTEGER NOT NULL DEFAULT 0,
  trail_gpx TEXT,
  route_summary TEXT NOT NULL DEFAULT '',
  safety_note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS challenge_members (
  challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'pack')),
  subject_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (challenge_id, subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS challenge_checkins (
  id BIGSERIAL PRIMARY KEY,
  challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'pack')),
  subject_id TEXT NOT NULL,
  visit_id BIGINT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  base_score INTEGER NOT NULL DEFAULT 0,
  bonus_score INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  UNIQUE (challenge_id, subject_type, subject_id, visit_id)
);
CREATE INDEX IF NOT EXISTS idx_challenge_checkins_subject ON challenge_checkins(subject_type, subject_id, status);

CREATE TABLE IF NOT EXISTS score_ledger (
  id BIGSERIAL PRIMARY KEY,
  season_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  pack_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('pending', 'posted', 'reversed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_score_ledger_season_user ON score_ledger(season_key, user_id, status);

CREATE TABLE IF NOT EXISTS badges (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '✦',
  rule_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS user_badges (
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_type TEXT NOT NULL DEFAULT 'rule',
  source_id TEXT,
  PRIMARY KEY (user_id, badge_id)
);

CREATE TABLE IF NOT EXISTS tracks (
  id BIGSERIAL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  trip_id BIGINT REFERENCES trips(id) ON DELETE SET NULL,
  media_id BIGINT REFERENCES media_assets(id) ON DELETE SET NULL,
  distance_km NUMERIC(10, 2) NOT NULL DEFAULT 0,
  elevation_gain_m INTEGER NOT NULL DEFAULT 0,
  point_count INTEGER NOT NULL DEFAULT 0,
  start_geom geometry(Point, 4326),
  end_geom geometry(Point, 4326),
  bbox geometry(Polygon, 4326),
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'processing', 'ready', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tracks_owner_created ON tracks(owner_id, created_at DESC);

INSERT INTO badges (code, name, description, icon, rule_json) VALUES
  ('first-summit', '第一座山峰', '完成第一次登顶记录', '▲', '{"type":"summit_count","threshold":1}'),
  ('three-summits', '三山同行', '完成三座山峰登顶记录', '✦', '{"type":"summit_count","threshold":3}'),
  ('china-explorer', '山河行者', '走过三个省份', '⌁', '{"type":"province_count","threshold":3}')
ON CONFLICT (code) DO NOTHING;

UPDATE challenges SET season_key = '2026', status = 'active' WHERE status IS NULL OR status = '';
UPDATE places SET geofence_radius_m = CASE WHEN kind = 'mountain' THEN 1200 WHEN kind = 'city' THEN 3000 ELSE 1800 END;

