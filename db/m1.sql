CREATE TABLE IF NOT EXISTS trips (
  id BIGSERIAL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_at DATE,
  end_at DATE,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'pack', 'public')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trip_days (
  id BIGSERIAL PRIMARY KEY,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_date DATE,
  title TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trip_items (
  id BIGSERIAL PRIMARY KEY,
  trip_day_id BIGINT NOT NULL REFERENCES trip_days(id) ON DELETE CASCADE,
  place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  story TEXT NOT NULL DEFAULT '',
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE visits ADD COLUMN IF NOT EXISTS trip_id BIGINT REFERENCES trips(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS media_assets (
  id BIGSERIAL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  trip_id BIGINT REFERENCES trips(id) ON DELETE SET NULL,
  visit_id BIGINT REFERENCES visits(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'cover', 'gpx')),
  object_key TEXT NOT NULL,
  source_url TEXT,
  thumbnail_url TEXT,
  poster_url TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'pack', 'public')),
  processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'ready', 'rejected')),
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trips_owner_created ON trips(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trip_days_trip_order ON trip_days(trip_id, sort_order, day_date);
CREATE INDEX IF NOT EXISTS idx_trip_items_day_order ON trip_items(trip_day_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_visits_user_trip ON visits(user_id, trip_id);
CREATE INDEX IF NOT EXISTS idx_media_owner_created ON media_assets(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_trip ON media_assets(trip_id, created_at DESC);

