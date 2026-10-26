CREATE TABLE IF NOT EXISTS packs (
  id BIGSERIAL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pack_members (
  pack_id BIGINT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'left', 'blocked')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pack_id, user_id)
);

CREATE TABLE IF NOT EXISTS pack_invitations (
  id BIGSERIAL PRIMARY KEY,
  pack_id BIGINT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  inviter_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  invitee_id TEXT REFERENCES app_users(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pack_invitations_pack_status ON pack_invitations(pack_id, status);

ALTER TABLE trips ADD COLUMN IF NOT EXISTS pack_id BIGINT REFERENCES packs(id) ON DELETE SET NULL;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS pack_id BIGINT REFERENCES packs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_trips_pack ON trips(pack_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_pack ON media_assets(pack_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pack_tasks (
  id BIGSERIAL PRIMARY KEY,
  pack_id BIGINT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  assignee_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feed_posts (
  id BIGSERIAL PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  pack_id BIGINT REFERENCES packs(id) ON DELETE CASCADE,
  trip_id BIGINT REFERENCES trips(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'pack' CHECK (visibility IN ('private', 'pack', 'public')),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'hidden', 'reported')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feed_posts_pack_created ON feed_posts(pack_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_posts_public_created ON feed_posts(visibility, status, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_post_media (
  post_id BIGINT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  media_id BIGINT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, media_id)
);

CREATE TABLE IF NOT EXISTS feed_comments (
  id BIGSERIAL PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'reported')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feed_comments_post_created ON feed_comments(post_id, created_at ASC);

CREATE TABLE IF NOT EXISTS feed_likes (
  post_id BIGINT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);

INSERT INTO packs (owner_id, name, invite_code, visibility)
SELECT 'demo-user', '山野不独行', 'demo-pack-2026', 'public'
WHERE EXISTS (SELECT 1 FROM app_users WHERE id = 'demo-user')
ON CONFLICT (invite_code) DO NOTHING;

INSERT INTO pack_members (pack_id, user_id, role)
SELECT p.id, 'demo-user', 'owner' FROM packs p
WHERE p.invite_code = 'demo-pack-2026'
  AND EXISTS (SELECT 1 FROM app_users WHERE id = 'demo-user')
ON CONFLICT (pack_id, user_id) DO NOTHING;

