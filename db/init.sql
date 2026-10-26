CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  province TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mountain', 'scenic', 'city')),
  elevation INTEGER NOT NULL DEFAULT 0,
  difficulty INTEGER NOT NULL DEFAULT 1,
  points INTEGER NOT NULL DEFAULT 10,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  map_x NUMERIC(5,2) NOT NULL,
  map_y NUMERIC(5,2) NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS visits (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id),
  place_id INTEGER NOT NULL REFERENCES places(id),
  visit_type TEXT NOT NULL CHECK (visit_type IN ('visited', 'summit', 'planned')),
  visited_at DATE NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  badge TEXT NOT NULL,
  total_points INTEGER NOT NULL DEFAULT 0,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS challenge_places (
  challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  PRIMARY KEY (challenge_id, place_id)
);

INSERT INTO app_users (id, nickname) VALUES ('demo-user', '山野小队长')
ON CONFLICT (id) DO NOTHING;

INSERT INTO places (id, name, province, kind, elevation, difficulty, points, lat, lng, map_x, map_y, description) VALUES
  (1, '八达岭长城', '北京', 'scenic', 1015, 2, 20, 40.36, 116.02, 47, 23, '把古道走成自己的旅行勋章'),
  (2, '泰山', '山东', 'mountain', 1545, 3, 45, 36.25, 117.10, 59, 36, '五岳之首，适合第一次登山挑战'),
  (3, '黄山', '安徽', 'mountain', 1864, 4, 55, 30.13, 118.17, 57, 49, '奇松、怪石、云海与日出'),
  (4, '华山', '陕西', 'mountain', 2155, 5, 65, 34.48, 110.09, 37, 37, '险峻山脊和长空栈道'),
  (5, '张家界', '湖南', 'scenic', 1262, 3, 40, 29.12, 110.48, 38, 58, '峰林之间的云雾徒步'),
  (6, '武功山', '江西', 'mountain', 1918, 4, 60, 27.45, 114.17, 53, 66, '高山草甸与星空露营'),
  (7, '四姑娘山', '四川', 'mountain', 6250, 5, 100, 31.10, 102.95, 24, 63, '雪山入门和高海拔挑战'),
  (8, '玉龙雪山', '云南', 'mountain', 5596, 5, 100, 27.10, 100.18, 19, 82, '雪山、蓝月谷和纳西风景'),
  (9, '西湖', '浙江', 'scenic', 10, 1, 15, 30.24, 120.15, 67, 53, '一圈湖山，完成一次轻量打卡'),
  (10, '稻城亚丁', '四川', 'scenic', 4700, 4, 80, 28.43, 84.85, 27, 76, '高原湖泊与雪山环线')
ON CONFLICT (id) DO NOTHING;

INSERT INTO visits (user_id, place_id, visit_type, visited_at, note) VALUES
  ('demo-user', 1, 'visited', CURRENT_DATE - 28, '和家人第一次一起走长城'),
  ('demo-user', 3, 'summit', CURRENT_DATE - 12, '雨后云海很惊喜'),
  ('demo-user', 9, 'visited', CURRENT_DATE - 5, '周末城市轻徒步')
ON CONFLICT DO NOTHING;

INSERT INTO challenges (id, name, description, badge, total_points, start_date, end_date) VALUES
  (1, '中国名山打卡季', '在本赛季点亮 5 座山峰，和 PACK 一起解锁金色山河。', '金色山河', 325, CURRENT_DATE - 30, CURRENT_DATE + 150),
  (2, '周末去野', '完成 3 次周末徒步或景区打卡，保持每周一次出发。', '周末行者', 100, CURRENT_DATE - 7, CURRENT_DATE + 30),
  (3, '华东轻装线', '点亮泰山、黄山、西湖，完成一次城市与山野的组合旅行。', '华东三连', 115, CURRENT_DATE - 10, CURRENT_DATE + 90)
ON CONFLICT (id) DO NOTHING;

INSERT INTO challenge_places (challenge_id, place_id) VALUES
  (1, 2), (1, 3), (1, 4), (1, 5), (1, 6), (1, 7), (1, 8),
  (2, 1), (2, 5), (2, 9),
  (3, 2), (3, 3), (3, 9)
ON CONFLICT DO NOTHING;
