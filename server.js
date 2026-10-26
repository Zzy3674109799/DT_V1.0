const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const Redis = require('ioredis');

const app = express();
const port = Number(process.env.PORT || 8080);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const authMode = process.env.AUTH_MODE || 'demo';
const authSecret = process.env.AUTH_SECRET || 'xingji-shanhe-dev-secret-change-me';
const storageMode = String(process.env.STORAGE_MODE || 'local-register-only').toLowerCase();
const storageRoot = process.env.STORAGE_ROOT || path.join(__dirname, 'storage');
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false }) : null;

if (redis) redis.on('error', (error) => console.error('Redis unavailable, using local fallback:', error.message));

if (authMode !== 'demo' && (!process.env.AUTH_SECRET || authSecret.includes('change-me'))) {
  throw new Error('生产模式必须配置强 AUTH_SECRET');
}

app.use(express.json({ limit: '2mb', verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
if (storageMode === 'local') {
  fs.mkdirSync(storageRoot, { recursive: true });
  app.use('/media-files', express.static(storageRoot, { maxAge: '1h', index: false }));
}
app.use(express.static(path.join(__dirname, 'public')));

const requestBuckets = new Map();
const rateWindowMs = 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - rateWindowMs;
  for (const [key, bucket] of requestBuckets) if (bucket.startedAt < cutoff) requestBuckets.delete(key);
}, rateWindowMs).unref();
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (!req.path.startsWith('/api/')) return next();
  const key = `${req.ip}:${req.path.startsWith('/api/v1/auth') ? 'auth' : 'api'}`;
  const limit = key.endsWith(':auth') ? 10 : 240;
  const now = Date.now();
  const bucket = requestBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= rateWindowMs) requestBuckets.set(key, { startedAt: now, count: 1 });
  else if (++bucket.count > limit) return res.status(429).json({ message: '请求过于频繁，请稍后再试' });
  return next();
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function cacheGet(key) {
  if (!redis) return null;
  try { if (redis.status === 'wait') await redis.connect(); return await redis.get(key); } catch (_error) { return null; }
}

async function cacheSet(key, value, seconds = 30) {
  if (!redis) return;
  try { if (redis.status === 'wait') await redis.connect(); await redis.set(key, value, 'EX', seconds); } catch (_error) { /* 降级到数据库 */ }
}

async function cacheDel(key) {
  if (!redis) return;
  try { if (redis.status === 'wait') await redis.connect(); await redis.del(key); } catch (_error) { /* 降级到数据库 */ }
}

async function waitForDatabase() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function encodePart(value) {
  return Buffer.from(value).toString('base64url');
}

function signToken(userId) {
  const payload = encodePart(JSON.stringify({ sub: userId, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }));
  const signature = crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data.sub : null;
  } catch (_error) {
    return null;
  }
}

function currentUserId(req) {
  const authorization = req.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) return verifyToken(authorization.slice(7));
  if (authMode === 'demo' && req.headers['x-user-id']) return String(req.headers['x-user-id']);
  return null;
}

function requireUser(req, res, next) {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ message: '请先登录' });
  req.userId = String(userId);
  next();
}

async function ensureUser(userId, nickname = '山野行者', avatarUrl = null) {
  await query(`INSERT INTO app_users (id, nickname, avatar_url)
    VALUES ($1, $2, $3)
    ON CONFLICT (id) DO UPDATE SET nickname = COALESCE(NULLIF(EXCLUDED.nickname, ''), app_users.nickname), avatar_url = COALESCE(EXCLUDED.avatar_url, app_users.avatar_url)`,
  [userId, nickname, avatarUrl]);
}

async function runMigrations() {
  for (const name of ['m1.sql', 'm2.sql', 'm3.sql', 'm4.sql', 'm5.sql', 'm6.sql', 'm7.sql', 'm8.sql']) {
    const migrationPath = path.join(__dirname, 'db', name);
    if (fs.existsSync(migrationPath)) await query(fs.readFileSync(migrationPath, 'utf8'));
  }
}

async function getOwnedTrip(tripId, userId) {
  const result = await query('SELECT * FROM trips WHERE id = $1 AND owner_id = $2', [tripId, userId]);
  return result.rows[0] || null;
}

async function getPackAccess(packId, userId) {
  const result = await query(`SELECT p.*, pm.role, pm.status AS member_status
    FROM packs p LEFT JOIN pack_members pm ON pm.pack_id = p.id AND pm.user_id = $2
    WHERE p.id = $1 AND p.status = 'active'`, [packId, userId]);
  const pack = result.rows[0];
  if (!pack) return null;
  if (pack.owner_id === userId) return { ...pack, role: 'owner', member_status: 'active' };
  return pack.member_status === 'active' ? pack : null;
}

function isPackManager(access) {
  return access && ['owner', 'admin'].includes(access.role);
}

function createInviteCode(prefix = 'pack') {
  return `${prefix}_${crypto.randomBytes(6).toString('base64url')}`;
}

async function getAccessiblePost(postId, userId) {
  const result = await query(`SELECT fp.*,
      (fp.visibility = 'public' OR fp.author_id = $2 OR EXISTS (
        SELECT 1 FROM pack_members pm WHERE pm.pack_id = fp.pack_id AND pm.user_id = $2 AND pm.status = 'active'
      )) AS can_read
    FROM feed_posts fp WHERE fp.id = $1`, [postId, userId]);
  const post = result.rows[0];
  return post && post.can_read ? post : null;
}

function requireAdmin(req, res, next) {
  const admins = String(process.env.ADMIN_USER_IDS || 'demo-user').split(',').map((id) => id.trim()).filter(Boolean);
  if (!admins.includes(req.userId)) return res.status(403).json({ message: '需要管理员权限' });
  next();
}

function paymentMode() {
  return String(process.env.PAYMENT_MODE || 'mock').toLowerCase();
}

function createOrderNo(prefix = 'XJ') {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function signUploadToken(payload) {
  const encoded = encodePart(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', authSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyUploadToken(token) {
  if (!token || !token.includes('.')) return null;
  const [encoded, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', authSecret).update(encoded).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch (_error) { return null; }
}

function safeExtension(fileName, kind) {
  const ext = path.extname(String(fileName || '')).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const allowed = kind === 'video' ? ['.mp4', '.mov', '.webm'] : kind === 'gpx' ? ['.gpx'] : ['.jpg', '.jpeg', '.png', '.webp', '.heic'];
  return allowed.includes(ext) ? ext : kind === 'video' ? '.mp4' : kind === 'gpx' ? '.gpx' : '.jpg';
}

function sha1Hex(value) { return crypto.createHash('sha1').update(value).digest('hex'); }
function hmacSha1Hex(secret, value) { return crypto.createHmac('sha1', secret).update(value).digest('hex'); }
function hmacSha1Base64(secret, value) { return crypto.createHmac('sha1', secret).update(value).digest('base64'); }
function storageKeyUrlPath(objectKey) { return `/${objectKey.split('/').map((part) => encodeURIComponent(part)).join('/')}`; }

function cosConfig() {
  return { secretId: process.env.COS_SECRET_ID, secretKey: process.env.COS_SECRET_KEY, bucket: process.env.COS_BUCKET, region: process.env.COS_REGION };
}

function ossConfig() {
  return { accessKeyId: process.env.OSS_ACCESS_KEY_ID, accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET, endpoint: process.env.OSS_ENDPOINT };
}

function createCosUrl(method, objectKey, contentType = '') {
  const config = cosConfig();
  if (!config.secretId || !config.secretKey || !config.bucket || !config.region) return null;
  const now = Math.floor(Date.now() / 1000); const start = now - 60; const end = now + 900; const keyTime = `${start};${end}`;
  const uri = storageKeyUrlPath(objectKey); const httpString = `${method.toLowerCase()}\n${uri}\n\n\n`;
  const signKey = hmacSha1Hex(config.secretKey, keyTime); const signature = hmacSha1Hex(signKey, sha1Hex(httpString));
  const authorization = `q-sign-algorithm=sha1&q-ak=${encodeURIComponent(config.secretId)}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=&q-url-param-list=&q-signature=${signature}`;
  const host = `${config.bucket}.cos.${config.region}.myqcloud.com`;
  return { url: `https://${host}${uri}?${authorization}`, headers: contentType ? { 'Content-Type': contentType } : {}, expiresIn: 900 };
}

function createOssUrl(method, objectKey, contentType = '') {
  const config = ossConfig();
  if (!config.accessKeyId || !config.accessKeySecret || !config.bucket || !config.endpoint) return null;
  const expires = Math.floor(Date.now() / 1000) + 900; const endpoint = /^https?:\/\//i.test(config.endpoint) ? config.endpoint : `https://${config.endpoint}`;
  const host = new URL(endpoint).host; const uri = storageKeyUrlPath(objectKey);
  const signature = hmacSha1Base64(config.accessKeySecret, `${method.toUpperCase()}\n\n${contentType}\n${expires}\n/${config.bucket}${uri}`);
  const params = new URLSearchParams({ OSSAccessKeyId: config.accessKeyId, Expires: String(expires), Signature: signature });
  return { url: `https://${host}${uri}?${params.toString()}`, headers: contentType ? { 'Content-Type': contentType } : {}, expiresIn: 900 };
}

function createStorageUrl(method, objectKey, contentType = '') {
  if (storageMode === 'cos') return createCosUrl(method, objectKey, contentType);
  if (storageMode === 'oss') return createOssUrl(method, objectKey, contentType);
  return null;
}

function publicStorageUrl(objectKey) {
  const cdnBase = String(process.env.CDN_BASE_URL || '').replace(/\/$/, '');
  if (cdnBase) return `${cdnBase}/${objectKey.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
  if (storageMode === 'cos') { const c = cosConfig(); if (c.bucket && c.region) return `https://${c.bucket}.cos.${c.region}.myqcloud.com${storageKeyUrlPath(objectKey)}`; }
  if (storageMode === 'oss') { const c = ossConfig(); if (c.bucket && c.endpoint) return `${String(c.endpoint).replace(/\/$/, '')}${storageKeyUrlPath(objectKey)}`; }
  return `/media-files/${objectKey}`;
}

async function enqueueMediaJobs(mediaId, kind, payload = {}) {
  const jobs = kind === 'video' ? ['metadata', 'thumbnail', 'transcode', 'moderation'] : ['metadata', 'thumbnail', 'moderation'];
  for (const jobType of jobs) {
    await query(`INSERT INTO media_jobs (media_id, job_type, payload)
      VALUES ($1, $2, $3)
      ON CONFLICT (media_id, job_type) DO UPDATE SET
        payload = media_jobs.payload || EXCLUDED.payload,
        status = CASE WHEN media_jobs.status = 'failed' THEN 'pending' ELSE media_jobs.status END,
        error = CASE WHEN media_jobs.status = 'failed' THEN NULL ELSE media_jobs.error END,
        available_at = CASE WHEN media_jobs.status = 'failed' THEN NOW() ELSE media_jobs.available_at END,
        updated_at = NOW()`, [mediaId, jobType, payload]);
  }
}

function wechatPrivateKey() {
  if (process.env.WECHAT_PRIVATE_KEY) return process.env.WECHAT_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (process.env.WECHAT_PRIVATE_KEY_PATH && fs.existsSync(process.env.WECHAT_PRIVATE_KEY_PATH)) return fs.readFileSync(process.env.WECHAT_PRIVATE_KEY_PATH, 'utf8');
  return null;
}

function wechatReady() {
  return Boolean(process.env.WECHAT_APPID && process.env.WECHAT_MCHID && process.env.WECHAT_SERIAL_NO && process.env.WECHAT_NOTIFY_URL && wechatPrivateKey());
}

function wechatAuthorization(method, pathname, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `${method.toUpperCase()}\n${pathname}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = crypto.createSign('RSA-SHA256').update(message).sign(wechatPrivateKey(), 'base64');
  return { timestamp, nonce, header: `WECHATPAY2-SHA256-RSA2048 mchid="${process.env.WECHAT_MCHID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${process.env.WECHAT_SERIAL_NO}",signature="${signature}"` };
}

async function wechatRequest(method, pathname, body) {
  const payload = JSON.stringify(body);
  const authorization = wechatAuthorization(method, pathname, payload);
  const response = await fetch(`https://api.mch.weixin.qq.com${pathname}`, { method, headers: { Authorization: authorization.header, 'Content-Type': 'application/json', Accept: 'application/json' }, body: payload });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.message || `微信支付请求失败 (${response.status})`); error.status = response.status; error.detail = data; throw error; }
  return data;
}

function verifyWechatNotification(req) {
  const timestamp = req.headers['wechatpay-timestamp']; const nonce = req.headers['wechatpay-nonce']; const signature = req.headers['wechatpay-signature'];
  const platformCertPath = process.env.WECHAT_PLATFORM_CERT_PATH;
  if (!timestamp || !nonce || !signature || !platformCertPath || !fs.existsSync(platformCertPath) || !req.rawBody) return false;
  const message = `${timestamp}\n${nonce}\n${req.rawBody.toString('utf8')}\n`;
  return crypto.createVerify('RSA-SHA256').update(message).verify(fs.readFileSync(platformCertPath), signature, 'base64');
}

function decryptWechatResource(resource) {
  const key = Buffer.from(String(process.env.WECHAT_API_V3_KEY || ''), 'utf8');
  if (key.length !== 32) throw new Error('WECHAT_API_V3_KEY 必须是 32 字节');
  const nonce = Buffer.from(resource.nonce, 'utf8'); const associatedData = Buffer.from(resource.associated_data || '', 'utf8'); const encrypted = Buffer.from(resource.ciphertext, 'base64');
  const authTag = encrypted.subarray(encrypted.length - 16); const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(associatedData); decipher.setAuthTag(authTag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}

const coordinatePi = Math.PI;
function transformLatitude(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * coordinatePi) + 20 * Math.sin(2 * x * coordinatePi)) * 2 / 3;
  ret += (20 * Math.sin(y * coordinatePi) + 40 * Math.sin(y / 3 * coordinatePi)) * 2 / 3;
  ret += (160 * Math.sin(y / 12 * coordinatePi) + 320 * Math.sin(y * coordinatePi / 30)) * 2 / 3;
  return ret;
}
function transformLongitude(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * coordinatePi) + 20 * Math.sin(2 * x * coordinatePi)) * 2 / 3;
  ret += (20 * Math.sin(x * coordinatePi) + 40 * Math.sin(x / 3 * coordinatePi)) * 2 / 3;
  ret += (150 * Math.sin(x / 12 * coordinatePi) + 300 * Math.sin(x / 30 * coordinatePi)) * 2 / 3;
  return ret;
}
function outsideChina(latitude, longitude) { return longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271; }
function gcj02ToWgs84(latitude, longitude) {
  if (outsideChina(latitude, longitude)) return { latitude, longitude };
  const a = 6378245.0; const ee = 0.00669342162296594323;
  const dLat = transformLatitude(longitude - 105.0, latitude - 35.0) * 180 / (a * (1 - ee) / Math.pow(1 - ee * Math.sin(latitude * coordinatePi / 180) ** 2, 1.5) * coordinatePi);
  const dLng = transformLongitude(longitude - 105.0, latitude - 35.0) * 180 / (a / Math.sqrt(1 - ee * Math.sin(latitude * coordinatePi / 180) ** 2) * Math.cos(latitude * coordinatePi / 180) * coordinatePi);
  return { latitude: latitude - dLat, longitude: longitude - dLng };
}

function centsToYuan(cents) {
  return Number(cents || 0) / 100;
}

function couponDiscount(coupon, originalAmount) {
  if (!coupon) return 0;
  if (coupon.discount_type === 'fixed') return Math.min(originalAmount, Number(coupon.value));
  return Math.min(originalAmount, Math.floor(originalAmount * Number(coupon.value) / 100));
}

async function getMembership(userId) {
  const result = await query(`SELECT ms.*, mp.code, mp.name, mp.monthly_media_quota, mp.features_json
    FROM membership_subscriptions ms JOIN membership_plans mp ON mp.id = ms.plan_id
    WHERE ms.user_id = $1 AND ms.status = 'active' AND ms.end_at > NOW()
    ORDER BY ms.end_at DESC LIMIT 1`, [userId]);
  return result.rows[0] || null;
}

async function mediaQuotaForUser(userId) {
  const membership = await getMembership(userId);
  return Number(membership?.monthly_media_quota || 100);
}

async function activityWithCapacity(activityId) {
  const result = await query(`SELECT a.*, m.name AS merchant_name, p.name AS place_name,
      GREATEST(a.capacity - COALESCE((SELECT COUNT(*) FROM activity_participants ap WHERE ap.activity_id = a.id AND ap.status IN ('registered','checked_in')), 0), 0)::int AS remaining_capacity
    FROM activities a LEFT JOIN merchants m ON m.id = a.merchant_id LEFT JOIN places p ON p.id = a.place_id
    WHERE a.id = $1`, [activityId]);
  return result.rows[0] || null;
}

async function settleActivityPayment(client, order, transactionId, provider, payload = {}) {
  if (order.coupon_id) {
    const updatedCoupon = await client.query(`UPDATE coupons SET used_count = used_count + 1 WHERE id = $1 AND (total_count = 0 OR used_count < total_count) RETURNING id`, [order.coupon_id]);
    if (!updatedCoupon.rowCount) return { error: '优惠券已被使用完' };
    await client.query(`UPDATE coupon_claims SET used_at = NOW(), order_no = $1 WHERE coupon_id = $2 AND user_id = $3`, [order.order_no, order.coupon_id, order.user_id]);
  }
  const updated = await client.query(`UPDATE activity_orders SET status = 'paid', provider = $1, paid_at = NOW(), transaction_id = $2 WHERE id = $3 AND status = 'pending' RETURNING *`, [provider, transactionId, order.id]);
  if (!updated.rows[0]) return { order: order.status === 'paid' ? order : null, alreadyPaid: order.status === 'paid' };
  await client.query(`INSERT INTO activity_participants (activity_id, user_id, order_id) VALUES ($1,$2,$3) ON CONFLICT (activity_id,user_id) DO UPDATE SET order_id = EXCLUDED.order_id, status = 'registered'`, [order.activity_id, order.user_id, order.id]);
  await client.query(`INSERT INTO payment_events (provider, event_id, order_no, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING`, [provider, `${provider}:${order.order_no}:${transactionId}`, order.order_no, payload]);
  return { order: updated.rows[0] };
}

async function applyWechatRefundResult(client, order, refundResponse) {
  if (order.status === 'refunded' && order.refund_status === 'success') return order;
  const businessStatus = String(refundResponse.status || '').toUpperCase();
  const refundStatus = businessStatus === 'SUCCESS' ? 'success' : businessStatus === 'ABNORMAL' || businessStatus === 'FAIL' ? 'failed' : 'processing';
  const refundTransactionId = refundResponse.refund_id || refundResponse.out_refund_no || order.refund_no;
  const updated = await client.query(`UPDATE activity_orders SET
      status = CASE WHEN $1 = 'success' THEN 'refunded' ELSE status END,
      refunded_at = CASE WHEN $1 = 'success' THEN COALESCE(refunded_at, NOW()) ELSE refunded_at END,
      refund_status = $1, refund_transaction_id = $2, refund_payload = $3
      WHERE id = $4 RETURNING *`, [refundStatus, refundTransactionId, refundResponse, order.id]);
  const current = updated.rows[0];
  if (!current || refundStatus !== 'success') return current;
  await client.query(`UPDATE activity_participants SET status = 'cancelled' WHERE activity_id = $1 AND user_id = $2`, [current.activity_id, current.user_id]);
  if (current.coupon_id) {
    await client.query(`UPDATE coupons SET used_count = GREATEST(used_count - 1, 0) WHERE id = $1`, [current.coupon_id]);
    await client.query(`UPDATE coupon_claims SET used_at = NULL, order_no = NULL WHERE coupon_id = $1 AND user_id = $2`, [current.coupon_id, current.user_id]);
  }
  await client.query(`INSERT INTO payment_events (provider, event_id, order_no, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING`, ['wechat', `refund:${current.order_no}`, current.order_no, { orderNo: current.order_no, action: 'refund', refund: refundResponse }]);
  return current;
}

async function awardBadges(client, userId) {
  const stats = await client.query(`SELECT COUNT(*) FILTER (WHERE v.visit_type = 'summit' AND v.verification_status = 'verified')::int AS summit_count,
      COUNT(DISTINCT p.province) FILTER (WHERE v.verification_status = 'verified' AND v.visit_type <> 'planned')::int AS province_count
      FROM visits v JOIN places p ON p.id = v.place_id WHERE v.user_id = $1`, [userId]);
  const row = stats.rows[0];
  const rules = [
    { code: 'first-summit', ok: row.summit_count >= 1 },
    { code: 'three-summits', ok: row.summit_count >= 3 },
    { code: 'china-explorer', ok: row.province_count >= 3 }
  ];
  for (const rule of rules) {
    if (!rule.ok) continue;
    await client.query(`INSERT INTO user_badges (user_id, badge_id, source_type, source_id)
      SELECT $1, id, 'visit_rule', $2 FROM badges WHERE code = $3
      ON CONFLICT (user_id, badge_id) DO NOTHING`, [userId, String(row.summit_count) + ':' + String(row.province_count), rule.code]);
  }
}

async function scoreVerifiedVisit(client, visitId, userId) {
  const visitResult = await client.query(`SELECT v.*, p.points, p.name, p.kind FROM visits v JOIN places p ON p.id = v.place_id WHERE v.id = $1 AND v.user_id = $2`, [visitId, userId]);
  const visit = visitResult.rows[0];
  if (!visit) return [];
  const challenges = await client.query(`SELECT c.id, c.season_key, c.name FROM challenges c JOIN challenge_places cp ON cp.challenge_id = c.id
    WHERE cp.place_id = $1 AND c.status = 'active' AND c.start_date <= $2 AND c.end_date >= $2`, [visit.place_id, visit.visited_at]);
  const results = [];
  for (const challenge of challenges.rows) {
    const bonus = visit.visit_type === 'summit' ? Math.max(5, Math.round(visit.points * 0.25)) : 0;
    const inserted = await client.query(`INSERT INTO challenge_checkins (challenge_id, subject_type, subject_id, visit_id, status, base_score, bonus_score)
      VALUES ($1, 'user', $2, $3, $4, $5, $6)
      ON CONFLICT (challenge_id, subject_type, subject_id, visit_id) DO NOTHING RETURNING id`, [
      challenge.id, userId, visit.id, visit.verification_status === 'verified' ? 'verified' : 'pending', visit.points, bonus
    ]);
    if (inserted.rowCount && visit.verification_status === 'verified') {
      await client.query(`INSERT INTO score_ledger (season_key, user_id, source_type, source_id, delta, status, idempotency_key)
        VALUES ($1, $2, 'challenge_checkin', $3, $4, 'posted', $5)
        ON CONFLICT (idempotency_key) DO NOTHING`, [challenge.season_key, userId, String(inserted.rows[0].id), visit.points + bonus, `visit:${visit.id}:challenge:${challenge.id}`]);
    }
    results.push({ challengeId: challenge.id, name: challenge.name, status: visit.verification_status === 'verified' ? 'verified' : 'pending', points: visit.points + bonus });
  }
  if (visit.verification_status === 'verified') await awardBadges(client, userId);
  await Promise.all(challenges.rows.map((challenge) => cacheDel(`leaderboard:${challenge.season_key}`)));
  return results;
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function verificationForPlace(client, place, latitude, longitude, accuracyM) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { status: 'manual_review', risk: 'high', distanceM: null };
  }
  const radius = Number(place.geofence_radius_m || 1500);
  const rawAccuracy = Number.isFinite(accuracyM) ? Math.max(0, accuracyM) : 100;
  const accuracy = Math.min(rawAccuracy, 5000);
  const distanceResult = await client.query(`SELECT ST_Distance(
      COALESCE(p.geom, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326))::geography,
      ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
    ) AS distance_m
    FROM places p WHERE p.id = $3`, [longitude, latitude, place.id]);
  const distanceM = distanceResult.rows[0] && distanceResult.rows[0].distance_m !== null ? Number(distanceResult.rows[0].distance_m) : null;
  if (distanceM === null) return { status: 'manual_review', risk: 'high', distanceM: null };
  if (distanceM <= radius + accuracy) return { status: 'verified', risk: rawAccuracy <= 80 ? 'low' : 'medium', distanceM };
  if (distanceM <= radius * 8) return { status: 'manual_review', risk: 'medium', distanceM };
  return { status: 'manual_review', risk: rawAccuracy > 5000 ? 'high' : 'high', distanceM };
}

app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, service: 'xingji-shanhe', database: 'ready' });
  } catch (error) {
    res.status(503).json({ ok: false, database: 'unavailable', message: error.message });
  }
});

app.get('/api/dashboard', requireUser, async (req, res) => {
  const userId = req.userId;
  try {
    const [places, visits, stats, challenges] = await Promise.all([
      query(`SELECT p.*, EXISTS (SELECT 1 FROM visits v WHERE v.place_id = p.id AND v.user_id = $1 AND v.visit_type <> 'planned' AND (v.verification_status IS NULL OR v.verification_status = 'verified')) AS lit
             FROM places p ORDER BY p.id`, [userId]),
      query(`SELECT v.id, v.visit_type, v.visited_at, v.note, p.name, p.province, p.kind, p.points
             FROM visits v JOIN places p ON p.id = v.place_id WHERE v.user_id = $1
             ORDER BY v.visited_at DESC, v.id DESC LIMIT 10`, [userId]),
      query(`SELECT COUNT(DISTINCT place_id)::int AS places_lit,
                    COUNT(*)::int AS visits_count,
                    COALESCE(SUM(CASE WHEN visit_type = 'summit' THEN points ELSE points / 2 END), 0)::int AS score,
                    COUNT(DISTINCT p.province)::int AS provinces
             FROM visits v JOIN places p ON p.id = v.place_id
             WHERE v.user_id = $1 AND v.visit_type <> 'planned' AND (v.verification_status IS NULL OR v.verification_status = 'verified')`, [userId]),
      query(`SELECT c.id, c.name, c.description, c.badge, c.total_points,
                    COUNT(cp.place_id)::int AS target_count,
                    COUNT(v.id)::int AS completed_count
             FROM challenges c
             LEFT JOIN challenge_places cp ON cp.challenge_id = c.id
             LEFT JOIN visits v ON v.place_id = cp.place_id AND v.user_id = $1 AND v.visit_type <> 'planned' AND (v.verification_status IS NULL OR v.verification_status = 'verified')
             GROUP BY c.id ORDER BY c.id`, [userId])
    ]);
    res.json({ places: places.rows, visits: visits.rows, stats: stats.rows[0], challenges: challenges.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/visits', (_req, res) => res.status(410).json({ message: '旧版打卡接口已下线，请使用 /api/v1/visits' }));

app.post('/api/v1/auth/dev-login', async (req, res) => {
  if (authMode !== 'demo') return res.status(404).json({ message: '开发登录已关闭' });
  const body = req.body || {};
  const userId = String(body.userId || 'demo-user').trim().slice(0, 80);
  const nickname = String(body.nickname || (userId === 'demo-user' ? '山野小队长' : '山野行者')).trim().slice(0, 40);
  if (!userId) return res.status(400).json({ message: 'userId 不能为空' });
  try {
    await ensureUser(userId, nickname, body.avatarUrl || null);
    return res.json({ accessToken: signToken(userId), user: { id: userId, nickname } });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/auth/wechat-login', async (req, res) => {
  if (!process.env.WECHAT_APPID || !process.env.WECHAT_SECRET) {
    return res.status(501).json({ message: '尚未配置 WECHAT_APPID 和 WECHAT_SECRET' });
  }
  const code = String((req.body || {}).code || '').trim();
  if (!code) return res.status(400).json({ message: 'code 不能为空' });
  try {
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search = new URLSearchParams({ appid: process.env.WECHAT_APPID, secret: process.env.WECHAT_SECRET, js_code: code, grant_type: 'authorization_code' });
    const response = await fetch(url);
    const data = await response.json();
    if (!data.openid || data.errcode) return res.status(401).json({ message: '微信登录失败', detail: data.errmsg || data.errcode });
    const userId = `wx:${data.openid}`;
    await ensureUser(userId, '微信行者');
    return res.json({ accessToken: signToken(userId), user: { id: userId, nickname: '微信行者' } });
  } catch (error) {
    return res.status(502).json({ message: '微信登录服务不可用', detail: error.message });
  }
});

app.get('/api/v1/auth/me', requireUser, async (req, res) => {
  try {
    await ensureUser(req.userId);
    const result = await query('SELECT id, nickname, avatar_url, created_at FROM app_users WHERE id = $1', [req.userId]);
    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/v1/trips', requireUser, async (req, res) => {
  try {
    const result = await query(`SELECT t.*, COUNT(DISTINCT td.id)::int AS day_count, COUNT(DISTINCT ti.id)::int AS item_count
      FROM trips t
      LEFT JOIN trip_days td ON td.trip_id = t.id
      LEFT JOIN trip_items ti ON ti.trip_day_id = td.id
      WHERE t.owner_id = $1
      GROUP BY t.id ORDER BY t.created_at DESC`, [req.userId]);
    res.json({ trips: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/trips', requireUser, async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ message: '行程名称不能为空' });
  try {
    await ensureUser(req.userId);
    const packId = body.packId ? Number(body.packId) : null;
    if (packId && !await getPackAccess(packId, req.userId)) return res.status(403).json({ message: '你不是该 PACK 成员' });
    const result = await query(`INSERT INTO trips (owner_id, pack_id, name, start_at, end_at, visibility, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [
      req.userId, packId, name, body.startAt || null, body.endAt || null,
      ['private', 'pack', 'public'].includes(body.visibility) ? body.visibility : 'private',
      String(body.notes || '').slice(0, 4000)
    ]);
    res.status(201).json({ trip: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/v1/trips/:tripId', requireUser, async (req, res) => {
  try {
    const trip = await getOwnedTrip(req.params.tripId, req.userId);
    if (!trip) return res.status(404).json({ message: '行程不存在' });
    const [days, media] = await Promise.all([
      query(`SELECT td.*, COALESCE(json_agg(json_build_object('id', ti.id, 'title', ti.title, 'story', ti.story, 'placeId', ti.place_id, 'lat', ti.lat, 'lng', ti.lng, 'sortOrder', ti.sort_order) ORDER BY ti.sort_order, ti.id) FILTER (WHERE ti.id IS NOT NULL), '[]') AS items
        FROM trip_days td LEFT JOIN trip_items ti ON ti.trip_day_id = td.id WHERE td.trip_id = $1 GROUP BY td.id ORDER BY td.sort_order, td.day_date, td.id`, [trip.id]),
      query(`SELECT id, kind, object_key, source_url, thumbnail_url, poster_url, visibility, processing_status, moderation_status, metadata, created_at
        FROM media_assets WHERE trip_id = $1 AND owner_id = $2 ORDER BY created_at DESC`, [trip.id, req.userId])
    ]);
    res.json({ trip, days: days.rows, media: media.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/trips/:tripId/days', requireUser, async (req, res) => {
  const body = req.body || {};
  const title = String(body.title || '').trim();
  if (!title) return res.status(400).json({ message: '行程日标题不能为空' });
  try {
    const trip = await getOwnedTrip(req.params.tripId, req.userId);
    if (!trip) return res.status(404).json({ message: '行程不存在' });
    const result = await query(`INSERT INTO trip_days (trip_id, day_date, title, notes, sort_order)
      VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(sort_order) + 1 FROM trip_days WHERE trip_id = $1), 0)) RETURNING *`, [trip.id, body.dayDate || null, title, String(body.notes || '').slice(0, 4000)]);
    res.status(201).json({ day: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/trips/:tripId/days/:dayId/items', requireUser, async (req, res) => {
  const body = req.body || {};
  const title = String(body.title || '').trim();
  if (!title) return res.status(400).json({ message: '行程项目标题不能为空' });
  try {
    const trip = await getOwnedTrip(req.params.tripId, req.userId);
    if (!trip) return res.status(404).json({ message: '行程不存在' });
    const day = await query('SELECT id FROM trip_days WHERE id = $1 AND trip_id = $2', [req.params.dayId, trip.id]);
    if (!day.rows[0]) return res.status(404).json({ message: '行程日不存在' });
    const result = await query(`INSERT INTO trip_items (trip_day_id, place_id, title, story, lat, lng, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE((SELECT MAX(sort_order) + 1 FROM trip_items WHERE trip_day_id = $1), 0)) RETURNING *`, [
      req.params.dayId, body.placeId || null, title, String(body.story || '').slice(0, 8000), body.lat || null, body.lng || null
    ]);
    res.status(201).json({ item: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/media/presign', requireUser, async (req, res) => {
  const body = req.body || {};
  const kind = String(body.kind || 'photo');
  const fileName = String(body.fileName || 'upload');
  const byteSize = Math.max(0, Number(body.byteSize || 0));
  if (!['photo', 'video', 'cover', 'gpx'].includes(kind)) return res.status(400).json({ message: '媒体类型无效' });
  if (!Number.isFinite(byteSize) || byteSize <= 0) return res.status(400).json({ message: 'byteSize 必须大于 0' });
  const maxBytes = kind === 'video' ? 500 * 1024 * 1024 : kind === 'gpx' ? 10 * 1024 * 1024 : 30 * 1024 * 1024;
  if (byteSize > maxBytes) return res.status(413).json({ message: `文件不能超过 ${Math.round(maxBytes / 1024 / 1024)}MB` });
  if (!['local', 'cos', 'oss'].includes(storageMode)) return res.status(501).json({ message: '当前存储适配器未配置，请配置 STORAGE_MODE=local、cos 或 oss' });
  try {
    await ensureUser(req.userId);
    const monthStart = new Date();
    monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const used = await query(`SELECT COUNT(*)::int AS count FROM media_assets WHERE owner_id = $1 AND created_at >= $2`, [req.userId, monthStart]);
    const quota = await mediaQuotaForUser(req.userId);
    if (Number(used.rows[0].count) >= quota) return res.status(429).json({ message: '本月媒体额度已用完', quota, used: Number(used.rows[0].count) });
    if (body.tripId && !(await getOwnedTrip(body.tripId, req.userId))) return res.status(404).json({ message: '行程不存在' });
    const packId = body.packId ? Number(body.packId) : null;
    if (packId && !await getPackAccess(packId, req.userId)) return res.status(403).json({ message: '你不是该 PACK 成员' });
    if (body.visitId) {
      const visit = await query('SELECT id FROM visits WHERE id = $1 AND user_id = $2', [body.visitId, req.userId]);
      if (!visit.rows[0]) return res.status(404).json({ message: '访问记录不存在或无权访问' });
    }
    const ext = safeExtension(fileName, kind);
    const objectKey = `${encodePart(req.userId)}/${new Date().toISOString().slice(0, 7)}/${crypto.randomBytes(16).toString('hex')}${ext}`;
    const contentType = String(body.contentType || 'application/octet-stream').slice(0, 120);
    const cloudUpload = storageMode === 'local' ? null : createStorageUrl('PUT', objectKey, contentType);
    if (storageMode !== 'local' && !cloudUpload) return res.status(501).json({ message: `未配置 ${storageMode.toUpperCase()} 存储密钥或桶参数` });
    const result = await query(`INSERT INTO media_assets (owner_id, trip_id, pack_id, visit_id, kind, object_key, visibility, processing_status, moderation_status, metadata, byte_size, storage_provider)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','pending',$8,$9,$10) RETURNING id, object_key, kind, byte_size, processing_status, moderation_status, storage_provider`, [
      req.userId, body.tripId || null, packId, body.visitId || null, kind, objectKey,
      ['private', 'pack', 'public'].includes(body.visibility) ? body.visibility : 'private', { fileName, contentType }, byteSize, storageMode
    ]);
    const media = result.rows[0];
    const upload = storageMode === 'local'
      ? { method: 'PUT', url: `/api/v1/media/upload/${signUploadToken({ mediaId: media.id, userId: req.userId, objectKey, byteSize, exp: Date.now() + 15 * 60 * 1000 })}`, expiresIn: 900 }
      : { method: 'PUT', ...cloudUpload, completeUrl: `/api/v1/media/${media.id}/complete` };
    res.status(201).json({ media, upload, quota: { used: Number(used.rows[0].count) + 1, limit: quota } });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.put('/api/v1/media/upload/:token', express.raw({ type: () => true, limit: '500mb' }), async (req, res) => {
  const payload = verifyUploadToken(req.params.token);
  if (!payload) return res.status(401).json({ message: '上传凭证无效或已过期' });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ message: '请使用二进制请求体上传文件' });
  if (req.body.length !== Number(payload.byteSize)) return res.status(400).json({ message: '文件大小与预签名请求不一致' });
  try {
    const mediaResult = await query('SELECT id, owner_id, object_key FROM media_assets WHERE id = $1 AND owner_id = $2 AND object_key = $3 AND processing_status = \'pending\'', [payload.mediaId, payload.userId, payload.objectKey]);
    if (!mediaResult.rows[0]) return res.status(404).json({ message: '媒体上传记录不存在' });
    const absolutePath = path.resolve(storageRoot, payload.objectKey);
    if (!absolutePath.startsWith(path.resolve(storageRoot) + path.sep)) return res.status(400).json({ message: '对象键无效' });
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, req.body);
    const updated = await query(`UPDATE media_assets SET processing_status = 'ready', uploaded_at = NOW(), source_url = $1 WHERE id = $2 RETURNING *`, [`/media-files/${payload.objectKey}`, payload.mediaId]);
    await enqueueMediaJobs(payload.mediaId, updated.rows[0].kind, { source: 'local-upload' });
    res.json({ media: updated.rows[0] });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/v1/media/:mediaId/complete', requireUser, async (req, res) => {
  try {
    const mediaResult = await query(`SELECT * FROM media_assets WHERE id = $1 AND owner_id = $2 AND processing_status = 'pending'`, [req.params.mediaId, req.userId]);
    const media = mediaResult.rows[0];
    if (!media) return res.status(404).json({ message: '媒体上传记录不存在或已完成' });
    const sourceUrl = media.storage_provider === 'local' ? `/media-files/${media.object_key}` : publicStorageUrl(media.object_key);
    const result = await query(`UPDATE media_assets SET processing_status = 'ready', uploaded_at = NOW(), source_url = $1 WHERE id = $2 RETURNING *`, [sourceUrl, media.id]);
    await enqueueMediaJobs(media.id, media.kind, { source: 'cloud-upload' });
    res.json({ media: result.rows[0] });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/v1/media/:mediaId/access-url', requireUser, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM media_assets WHERE id = $1 AND processing_status = 'ready'`, [req.params.mediaId]);
    const media = result.rows[0];
    if (!media) return res.status(404).json({ message: '媒体不存在或尚未处理完成' });
    if (media.moderation_status === 'rejected') return res.status(403).json({ message: '媒体未通过审核' });
    const canRead = media.owner_id === req.userId || media.visibility === 'public' || (media.pack_id && await getPackAccess(media.pack_id, req.userId));
    if (!canRead) return res.status(404).json({ message: '媒体不存在或无权访问' });
    if (media.storage_provider === 'local') return res.json({ url: media.source_url, expiresIn: 3600 });
    const signed = createStorageUrl('GET', media.object_key);
    if (!signed) return res.status(501).json({ message: '存储访问签名未配置' });
    res.json({ url: signed.url, expiresIn: signed.expiresIn });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/v1/media/register', requireUser, async (req, res) => {
  const body = req.body || {};
  const kind = String(body.kind || 'photo');
  const objectKey = String(body.objectKey || '').trim();
  if (!['photo', 'video', 'cover', 'gpx'].includes(kind) || !objectKey) return res.status(400).json({ message: '媒体类型或 objectKey 无效' });
  try {
    const monthStart = new Date();
    monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const used = await query(`SELECT COUNT(*)::int AS count FROM media_assets WHERE owner_id = $1 AND created_at >= $2`, [req.userId, monthStart]);
    const quota = await mediaQuotaForUser(req.userId);
    if (Number(used.rows[0].count) >= quota) return res.status(429).json({ message: '本月媒体额度已用完', quota, used: Number(used.rows[0].count) });
    if (body.tripId && !(await getOwnedTrip(body.tripId, req.userId))) return res.status(404).json({ message: '行程不存在' });
    const packId = body.packId ? Number(body.packId) : null;
    if (packId && !await getPackAccess(packId, req.userId)) return res.status(403).json({ message: '你不是该 PACK 成员' });
    if (body.visitId) {
      const visit = await query('SELECT id FROM visits WHERE id = $1 AND user_id = $2', [body.visitId, req.userId]);
      if (!visit.rows[0]) return res.status(404).json({ message: '访问记录不存在或无权访问' });
    }
    const result = await query(`INSERT INTO media_assets (owner_id, trip_id, pack_id, visit_id, kind, object_key, source_url, thumbnail_url, poster_url, visibility, processing_status, moderation_status, metadata, byte_size, storage_provider)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $13, $14) RETURNING *`, [
      req.userId, body.tripId || null, packId, body.visitId || null, kind, objectKey, body.sourceUrl || null, body.thumbnailUrl || null, body.posterUrl || null,
      ['private', 'pack', 'public'].includes(body.visibility) ? body.visibility : 'private', body.sourceUrl ? 'ready' : 'pending', body.metadata || {}, Math.max(0, Number(body.byteSize || 0)), storageMode
    ]);
    if (result.rows[0].processing_status === 'ready') await enqueueMediaJobs(result.rows[0].id, kind, { source: 'registered' });
    res.status(201).json({ media: result.rows[0], storageMode: process.env.STORAGE_MODE || 'local-register-only' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/packs', requireUser, async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ message: 'PACK 名称不能为空' });
  try {
    const result = await withTransaction(async (client) => {
      await client.query(`INSERT INTO app_users (id, nickname) VALUES ($1, '山野行者') ON CONFLICT (id) DO NOTHING`, [req.userId]);
      const pack = await client.query(`INSERT INTO packs (owner_id, name, invite_code, visibility) VALUES ($1, $2, $3, $4) RETURNING *`, [
        req.userId, name, createInviteCode(), (req.body || {}).visibility === 'public' ? 'public' : 'private'
      ]);
      await client.query(`INSERT INTO pack_members (pack_id, user_id, role) VALUES ($1, $2, 'owner')`, [pack.rows[0].id, req.userId]);
      return pack.rows[0];
    });
    res.status(201).json({ pack: result });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/v1/packs', requireUser, async (req, res) => {
  try {
    const result = await query(`SELECT p.*, pm.role,
      COUNT(DISTINCT pm2.user_id)::int AS member_count,
      COUNT(DISTINCT fp.id)::int AS post_count
      FROM packs p JOIN pack_members pm ON pm.pack_id = p.id AND pm.user_id = $1 AND pm.status = 'active'
      LEFT JOIN pack_members pm2 ON pm2.pack_id = p.id AND pm2.status = 'active'
      LEFT JOIN feed_posts fp ON fp.pack_id = p.id AND fp.status = 'published'
      WHERE p.status = 'active' GROUP BY p.id, pm.role ORDER BY p.created_at DESC`, [req.userId]);
    res.json({ packs: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/v1/packs/:packId', requireUser, async (req, res) => {
  try {
    const access = await getPackAccess(req.params.packId, req.userId);
    if (!access) return res.status(403).json({ message: '无权访问该 PACK' });
    const [members, tasks, media] = await Promise.all([
      query(`SELECT u.id, u.nickname, u.avatar_url, pm.role, pm.status, pm.joined_at FROM pack_members pm JOIN app_users u ON u.id = pm.user_id WHERE pm.pack_id = $1 AND pm.status = 'active' ORDER BY CASE pm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, pm.joined_at`, [req.params.packId]),
      query(`SELECT pt.*, u.nickname AS assignee_nickname FROM pack_tasks pt LEFT JOIN app_users u ON u.id = pt.assignee_id WHERE pt.pack_id = $1 ORDER BY pt.status, pt.created_at DESC LIMIT 50`, [req.params.packId]),
      query(`SELECT ma.id, ma.kind, ma.object_key, ma.source_url, ma.thumbnail_url, ma.poster_url, ma.visibility, ma.processing_status, ma.moderation_status, ma.created_at FROM media_assets ma WHERE ma.pack_id = $1 AND ma.moderation_status <> 'rejected' ORDER BY ma.created_at DESC LIMIT 100`, [req.params.packId])
    ]);
    const packView = { ...access };
    if (!isPackManager(access)) delete packView.invite_code;
    res.json({ pack: packView, members: members.rows, tasks: tasks.rows, media: media.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/packs/:packId/invitations', requireUser, async (req, res) => {
  try {
    const access = await getPackAccess(req.params.packId, req.userId);
    if (!isPackManager(access)) return res.status(403).json({ message: '只有 PACK 管理员可以邀请成员' });
    const inviteeId = (req.body || {}).userId ? String(req.body.userId).trim() : null;
    const result = await query(`INSERT INTO pack_invitations (pack_id, inviter_id, invitee_id, invite_code) VALUES ($1, $2, $3, $4) RETURNING id, invite_code, status, expires_at`, [req.params.packId, req.userId, inviteeId, createInviteCode('join')]);
    res.status(201).json({ invitation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/packs/join', requireUser, async (req, res) => {
  const inviteCode = String((req.body || {}).inviteCode || '').trim();
  if (!inviteCode) return res.status(400).json({ message: 'inviteCode 不能为空' });
  try {
    const result = await withTransaction(async (client) => {
      const invite = await client.query(`SELECT pi.*, p.name FROM pack_invitations pi JOIN packs p ON p.id = pi.pack_id WHERE pi.invite_code = $1 AND pi.status = 'pending' AND pi.expires_at > NOW() FOR UPDATE`, [inviteCode]);
      if (!invite.rows[0]) return { error: '邀请不存在、已使用或已过期' };
      const row = invite.rows[0];
      await client.query(`INSERT INTO app_users (id, nickname) VALUES ($1, '山野行者') ON CONFLICT (id) DO NOTHING`, [req.userId]);
      await client.query(`INSERT INTO pack_members (pack_id, user_id, role, status) VALUES ($1, $2, 'member', 'active') ON CONFLICT (pack_id, user_id) DO UPDATE SET status = 'active'`, [row.pack_id, req.userId]);
      await client.query(`UPDATE pack_invitations SET status = 'accepted' WHERE id = $1`, [row.id]);
      return { packId: row.pack_id, name: row.name };
    });
    if (result.error) return res.status(400).json({ message: result.error });
    res.status(201).json({ joined: result });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/packs/:packId/leave', requireUser, async (req, res) => {
  try {
    const access = await getPackAccess(req.params.packId, req.userId);
    if (!access) return res.status(404).json({ message: 'PACK 不存在或你不是成员' });
    if (access.role === 'owner') return res.status(400).json({ message: '队长不能直接退出，请先转移队长或解散 PACK' });
    await query(`UPDATE pack_members SET status = 'left' WHERE pack_id = $1 AND user_id = $2`, [req.params.packId, req.userId]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/packs/:packId/tasks', requireUser, async (req, res) => {
  const title = String((req.body || {}).title || '').trim();
  if (!title) return res.status(400).json({ message: '任务标题不能为空' });
  try {
    const access = await getPackAccess(req.params.packId, req.userId);
    if (!access) return res.status(403).json({ message: '无权访问该 PACK' });
    const result = await query(`INSERT INTO pack_tasks (pack_id, creator_id, assignee_id, title, due_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [req.params.packId, req.userId, (req.body || {}).assigneeId || null, title, (req.body || {}).dueAt || null]);
    res.status(201).json({ task: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/v1/packs/:packId/media', requireUser, async (req, res) => {
  try {
    if (!await getPackAccess(req.params.packId, req.userId)) return res.status(403).json({ message: '无权访问该 PACK' });
    const result = await query(`SELECT ma.id, ma.kind, ma.object_key, ma.source_url, ma.thumbnail_url, ma.poster_url, ma.owner_id, u.nickname AS owner_nickname, ma.created_at
      FROM media_assets ma JOIN app_users u ON u.id = ma.owner_id WHERE ma.pack_id = $1 AND ma.moderation_status = 'approved' OR (ma.pack_id = $1 AND ma.moderation_status = 'pending') ORDER BY ma.created_at DESC LIMIT 200`, [req.params.packId]);
    res.json({ media: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/v1/feed', requireUser, async (req, res) => {
  const packId = req.query.packId ? Number(req.query.packId) : null;
  try {
    if (packId && !await getPackAccess(packId, req.userId)) return res.status(403).json({ message: '无权访问该 PACK 动态' });
    const result = await query(`SELECT fp.id, fp.author_id, u.nickname AS author_nickname, fp.pack_id, fp.trip_id, fp.content, fp.visibility, fp.created_at,
      (SELECT COUNT(*)::int FROM feed_likes fl WHERE fl.post_id = fp.id) AS like_count,
      EXISTS (SELECT 1 FROM feed_likes fl WHERE fl.post_id = fp.id AND fl.user_id = $2) AS liked_by_me,
      (SELECT COUNT(*)::int FROM feed_comments fc WHERE fc.post_id = fp.id AND fc.status = 'published') AS comment_count,
      COALESCE((SELECT json_agg(json_build_object('id', ma.id, 'kind', ma.kind, 'sourceUrl', ma.source_url, 'thumbnailUrl', ma.thumbnail_url, 'posterUrl', ma.poster_url) ORDER BY fpm.sort_order, ma.id)
        FROM feed_post_media fpm JOIN media_assets ma ON ma.id = fpm.media_id WHERE fpm.post_id = fp.id AND ma.moderation_status <> 'rejected'), '[]') AS media
      FROM feed_posts fp JOIN app_users u ON u.id = fp.author_id
      WHERE fp.status = 'published' AND ($1::bigint IS NULL OR fp.pack_id = $1)
        AND (fp.visibility = 'public' OR fp.author_id = $2 OR EXISTS (SELECT 1 FROM pack_members pm WHERE pm.pack_id = fp.pack_id AND pm.user_id = $2 AND pm.status = 'active'))
      ORDER BY fp.created_at DESC LIMIT 100`, [packId, req.userId]);
    res.json({ posts: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/feed/posts', requireUser, async (req, res) => {
  const body = req.body || {};
  const content = String(body.content || '').trim();
  if (!content) return res.status(400).json({ message: '动态内容不能为空' });
  const visibility = ['private', 'pack', 'public'].includes(body.visibility) ? body.visibility : 'pack';
  const packId = body.packId ? Number(body.packId) : null;
  try {
    if (packId && !await getPackAccess(packId, req.userId)) return res.status(403).json({ message: '你不是该 PACK 成员' });
    if (visibility === 'pack' && !packId) return res.status(400).json({ message: 'PACK 动态必须指定 packId' });
    const result = await withTransaction(async (client) => {
      const post = await client.query(`INSERT INTO feed_posts (author_id, pack_id, trip_id, content, visibility) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [req.userId, packId, body.tripId || null, content.slice(0, 5000), visibility]);
      const mediaIds = Array.isArray(body.mediaIds) ? body.mediaIds.map(Number).filter(Number.isInteger) : [];
      if (mediaIds.length) {
        const owned = await client.query(`SELECT id FROM media_assets WHERE id = ANY($1::bigint[]) AND owner_id = $2`, [mediaIds, req.userId]);
        if (owned.rows.length !== mediaIds.length) return { error: '存在不属于当前用户的媒体' };
        for (const [index, mediaId] of mediaIds.entries()) await client.query(`INSERT INTO feed_post_media (post_id, media_id, sort_order) VALUES ($1, $2, $3)`, [post.rows[0].id, mediaId, index]);
      }
      return post.rows[0];
    });
    if (result.error) return res.status(400).json({ message: result.error });
    res.status(201).json({ post: result });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/v1/feed/posts/:postId/comments', requireUser, async (req, res) => {
  try {
    if (!await getAccessiblePost(req.params.postId, req.userId)) return res.status(404).json({ message: '动态不存在或无权访问' });
    const result = await query(`SELECT fc.id, fc.author_id, u.nickname AS author_nickname, fc.content, fc.created_at FROM feed_comments fc JOIN app_users u ON u.id = fc.author_id WHERE fc.post_id = $1 AND fc.status = 'published' ORDER BY fc.created_at ASC`, [req.params.postId]);
    res.json({ comments: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/feed/posts/:postId/comments', requireUser, async (req, res) => {
  const content = String((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ message: '评论不能为空' });
  try {
    if (!await getAccessiblePost(req.params.postId, req.userId)) return res.status(404).json({ message: '动态不存在或无权访问' });
    await ensureUser(req.userId);
    const result = await query(`INSERT INTO feed_comments (post_id, author_id, content) VALUES ($1, $2, $3) RETURNING *`, [req.params.postId, req.userId, content.slice(0, 1000)]);
    res.status(201).json({ comment: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/feed/posts/:postId/like', requireUser, async (req, res) => {
  try {
    if (!await getAccessiblePost(req.params.postId, req.userId)) return res.status(404).json({ message: '动态不存在或无权访问' });
    const existing = await query('SELECT 1 FROM feed_likes WHERE post_id = $1 AND user_id = $2', [req.params.postId, req.userId]);
    let liked;
    if (existing.rows[0]) {
      await query('DELETE FROM feed_likes WHERE post_id = $1 AND user_id = $2', [req.params.postId, req.userId]);
      liked = false;
    } else {
      await ensureUser(req.userId);
      await query('INSERT INTO feed_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.postId, req.userId]);
      liked = true;
    }
    const count = await query('SELECT COUNT(*)::int AS count FROM feed_likes WHERE post_id = $1', [req.params.postId]);
    res.json({ liked, likeCount: count.rows[0].count });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/visits', requireUser, async (req, res) => {
  const body = req.body || {};
  const placeId = Number(body.placeId);
  const visitType = body.visitType || 'visited';
  const visitedAt = body.visitedAt;
  const coordinateSystem = String(body.coordinateSystem || 'wgs84').toLowerCase();
  if (!Number.isInteger(placeId) || !['visited', 'summit', 'planned'].includes(visitType) || !visitedAt) {
    return res.status(400).json({ message: 'placeId、visitType、visitedAt 参数不完整' });
  }
  const date = new Date(`${visitedAt}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return res.status(400).json({ message: 'visitedAt 日期无效' });
  if (visitType !== 'planned' && date.getTime() > Date.now() + 24 * 60 * 60 * 1000) return res.status(400).json({ message: '已完成的旅行不能记录未来日期' });
  if (visitType === 'planned' && body.tripId) return res.status(400).json({ message: '计划记录不能绑定已完成行程' });
  if (!['wgs84', 'gcj02'].includes(coordinateSystem)) return res.status(400).json({ message: 'coordinateSystem 必须是 wgs84 或 gcj02' });
  let latitude = Number(body.latitude);
  let longitude = Number(body.longitude);
  if (coordinateSystem === 'gcj02' && Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const converted = gcj02ToWgs84(latitude, longitude);
    latitude = converted.latitude;
    longitude = converted.longitude;
  }
  try {
    const result = await withTransaction(async (client) => {
      await client.query(`INSERT INTO app_users (id, nickname) VALUES ($1, '山野行者') ON CONFLICT (id) DO NOTHING`, [req.userId]);
      const placeResult = await client.query('SELECT * FROM places WHERE id = $1', [placeId]);
      const place = placeResult.rows[0];
      if (!place) return { error: '地点不存在' };
      if (body.tripId) {
        const trip = await client.query('SELECT id FROM trips WHERE id = $1 AND owner_id = $2', [body.tripId, req.userId]);
        if (!trip.rows[0]) return { error: '行程不存在或无权访问' };
      }
      const verification = visitType === 'planned' ? { status: 'verified', risk: 'low', distanceM: null } : await verificationForPlace(client, place, latitude, longitude, Number(body.accuracyM));
      const locationProvided = Number.isFinite(latitude) && Number.isFinite(longitude)
        && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
      const insert = await client.query(`INSERT INTO visits (user_id, place_id, trip_id, visit_type, visited_at, note, latitude, longitude, accuracy_m, location_geom, verification_status, risk_level)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $7::double precision IS NULL OR $8::double precision IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($8::double precision, $7::double precision), 4326) END, $10, $11) RETURNING *`, [
        req.userId, placeId, body.tripId || null, visitType, visitedAt, String(body.note || '').slice(0, 1000),
        locationProvided ? latitude : null, locationProvided ? longitude : null, Number.isFinite(Number(body.accuracyM)) ? Number(body.accuracyM) : null, verification.status, verification.risk
      ]);
      const visit = insert.rows[0];
      const challenges = await scoreVerifiedVisit(client, visit.id, req.userId);
      return { visit, challenges, distanceM: verification.distanceM };
    });
    if (result.error) return res.status(404).json({ message: result.error });
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/v1/challenges', requireUser, async (req, res) => {
  try {
    const challenges = await query(`SELECT c.id, c.name, c.description, c.badge, c.total_points, c.season_key, c.status, c.start_date, c.end_date,
      COUNT(DISTINCT cp.place_id)::int AS target_count,
      COUNT(DISTINCT CASE WHEN v.verification_status = 'verified' AND v.visit_type <> 'planned' THEN cp.place_id END)::int AS completed_count,
      COALESCE(SUM(CASE WHEN sl.status = 'posted' THEN sl.delta ELSE 0 END), 0)::int AS earned_points,
      EXISTS (SELECT 1 FROM challenge_members cm WHERE cm.challenge_id = c.id AND cm.subject_type = 'user' AND cm.subject_id = $1) AS joined
      FROM challenges c LEFT JOIN challenge_places cp ON cp.challenge_id = c.id
      LEFT JOIN visits v ON v.place_id = cp.place_id AND v.user_id = $1
      LEFT JOIN challenge_checkins cc ON cc.challenge_id = c.id AND cc.subject_type = 'user' AND cc.subject_id = $1 AND cc.visit_id = v.id
      LEFT JOIN score_ledger sl ON sl.source_type = 'challenge_checkin' AND sl.source_id = cc.id::text AND sl.user_id = $1
      GROUP BY c.id ORDER BY c.start_date DESC, c.id`, [req.userId]);
    res.json({ challenges: challenges.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/challenges/:challengeId/join', requireUser, async (req, res) => {
  try {
    const exists = await query('SELECT id, name FROM challenges WHERE id = $1 AND status = \'active\'', [req.params.challengeId]);
    if (!exists.rows[0]) return res.status(404).json({ message: '挑战不存在或已结束' });
    await query(`INSERT INTO challenge_members (challenge_id, subject_type, subject_id) VALUES ($1, 'user', $2) ON CONFLICT DO NOTHING`, [req.params.challengeId, req.userId]);
    res.status(201).json({ ok: true, challenge: exists.rows[0] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/challenges/:challengeId/checkins', requireUser, async (req, res) => {
  const visitId = Number((req.body || {}).visitId);
  if (!Number.isInteger(visitId)) return res.status(400).json({ message: 'visitId 无效' });
  try {
    const result = await withTransaction(async (client) => {
      const relation = await client.query(`SELECT v.id FROM visits v JOIN challenge_places cp ON cp.place_id = v.place_id
        WHERE v.id = $1 AND v.user_id = $2 AND cp.challenge_id = $3`, [visitId, req.userId, req.params.challengeId]);
      if (!relation.rows[0]) return { error: '该记录不属于此挑战' };
      const scored = await scoreVerifiedVisit(client, visitId, req.userId);
      return { scored };
    });
    if (result.error) return res.status(400).json({ message: result.error });
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/v1/challenges/:challengeId/progress', requireUser, async (req, res) => {
  try {
    const result = await query(`SELECT c.id, c.name, c.description, c.badge, c.total_points, c.season_key,
      COUNT(DISTINCT cp.place_id)::int AS target_count,
      COUNT(DISTINCT CASE WHEN v.verification_status = 'verified' AND v.visit_type <> 'planned' THEN cp.place_id END)::int AS completed_count,
      COALESCE(SUM(CASE WHEN sl.status = 'posted' THEN sl.delta ELSE 0 END), 0)::int AS earned_points
      FROM challenges c LEFT JOIN challenge_places cp ON cp.challenge_id = c.id
      LEFT JOIN visits v ON v.place_id = cp.place_id AND v.user_id = $1
      LEFT JOIN challenge_checkins cc ON cc.challenge_id = c.id AND cc.subject_type = 'user' AND cc.subject_id = $1 AND cc.visit_id = v.id
      LEFT JOIN score_ledger sl ON sl.source_type = 'challenge_checkin' AND sl.source_id = cc.id::text AND sl.user_id = $1
      WHERE c.id = $2 GROUP BY c.id`, [req.userId, req.params.challengeId]);
    if (!result.rows[0]) return res.status(404).json({ message: '挑战不存在' });
    res.json({ progress: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/v1/leaderboards/:seasonKey', requireUser, async (req, res) => {
  try {
    const cacheKey = `leaderboard:${String(req.params.seasonKey).slice(0, 40)}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json({ ...JSON.parse(cached), cached: true });
    const result = await query(`SELECT u.id, u.nickname, COALESCE(SUM(sl.delta), 0)::int AS score,
      ROW_NUMBER() OVER (ORDER BY COALESCE(SUM(sl.delta), 0) DESC, u.created_at ASC)::int AS rank
      FROM app_users u LEFT JOIN score_ledger sl ON sl.user_id = u.id AND sl.season_key = $1 AND sl.status = 'posted'
      GROUP BY u.id ORDER BY score DESC, u.created_at ASC LIMIT 100`, [req.params.seasonKey]);
    const payload = { season: req.params.seasonKey, leaderboard: result.rows };
    await cacheSet(cacheKey, JSON.stringify(payload), 30);
    res.json(payload);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/v1/me/badges', requireUser, async (req, res) => {
  try {
    const result = await query(`SELECT b.code, b.name, b.description, b.icon, ub.awarded_at FROM user_badges ub JOIN badges b ON b.id = ub.badge_id WHERE ub.user_id = $1 ORDER BY ub.awarded_at DESC`, [req.userId]);
    res.json({ badges: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/tracks/register', requireUser, async (req, res) => {
  const body = req.body || {};
  try {
    if (body.tripId && !(await getOwnedTrip(body.tripId, req.userId))) return res.status(404).json({ message: '行程不存在' });
    const result = await query(`INSERT INTO tracks (owner_id, trip_id, media_id, distance_km, elevation_gain_m, point_count, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'registered') RETURNING *`, [
      req.userId, body.tripId || null, body.mediaId || null, Number(body.distanceKm || 0), Number(body.elevationGainM || 0), Number(body.pointCount || 0)
    ]);
    res.status(201).json({ track: result.rows[0], parser: 'metadata-only; GPX file parsing worker pending' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// M4 商业闭环：活动、订单、优惠券、会员与运营接口
app.get('/api/v1/activities', requireUser, async (_req, res) => {
  try {
    const result = await query(`SELECT a.*, m.name AS merchant_name, p.name AS place_name,
        GREATEST(a.capacity - COALESCE((SELECT COUNT(*) FROM activity_participants ap WHERE ap.activity_id = a.id AND ap.status IN ('registered','checked_in')), 0), 0)::int AS remaining_capacity
      FROM activities a LEFT JOIN merchants m ON m.id = a.merchant_id LEFT JOIN places p ON p.id = a.place_id
      WHERE a.status = 'published' ORDER BY a.start_at ASC`);
    res.json({ activities: result.rows.map((row) => ({ ...row, price_yuan: centsToYuan(row.price_cents) })) });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/v1/activities/:activityId', requireUser, async (req, res) => {
  try {
    const activity = await activityWithCapacity(req.params.activityId);
    if (!activity) return res.status(404).json({ message: '活动不存在' });
    res.json({ activity: { ...activity, price_yuan: centsToYuan(activity.price_cents) } });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/v1/admin/activities', requireUser, requireAdmin, async (req, res) => {
  const body = req.body || {};
  const title = String(body.title || '').trim();
  if (!title || !body.startAt || !body.endAt) return res.status(400).json({ message: 'title、startAt、endAt 不能为空' });
  try {
    const result = await query(`INSERT INTO activities (merchant_id, challenge_id, place_id, title, description, sponsor_label, start_at, end_at, capacity, price_cents, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [
      body.merchantId || null, body.challengeId || null, body.placeId || null, title, String(body.description || '').slice(0, 4000), String(body.sponsorLabel || '').slice(0, 120) || null,
      body.startAt, body.endAt, Math.max(0, Number(body.capacity || 0)), Math.max(0, Number(body.priceCents ?? Math.round(Number(body.priceYuan || 0) * 100))), ['draft','published','closed','cancelled'].includes(body.status) ? body.status : 'draft'
    ]);
    res.status(201).json({ activity: result.rows[0] });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/v1/activities/:activityId/orders', requireUser, async (req, res) => {
  const couponCode = String((req.body || {}).couponCode || '').trim().toUpperCase();
  const clientRequestId = String(req.headers['idempotency-key'] || (req.body || {}).idempotencyKey || '').trim().slice(0, 120) || null;
  try {
    const result = await withTransaction(async (client) => {
      await ensureUser(req.userId);
      if (clientRequestId) {
        const existing = await client.query(`SELECT o.*, a.title AS activity_title FROM activity_orders o JOIN activities a ON a.id = o.activity_id WHERE o.user_id = $1 AND o.client_request_id = $2`, [req.userId, clientRequestId]);
        if (existing.rows[0]) return { order: existing.rows[0], idempotent: true };
      }
      const activityResult = await client.query(`SELECT * FROM activities WHERE id = $1 FOR UPDATE`, [req.params.activityId]);
      const activity = activityResult.rows[0];
      if (!activity || activity.status !== 'published') return { error: '活动不存在或未开放报名', status: 404 };
      if (new Date(activity.end_at) <= new Date()) return { error: '活动已结束', status: 409 };
      const duplicate = await client.query(`SELECT 1 FROM activity_participants WHERE activity_id = $1 AND user_id = $2 AND status <> 'cancelled'`, [activity.id, req.userId]);
      if (duplicate.rowCount) return { error: '你已报名该活动', status: 409 };
      if (Number(activity.capacity) > 0) {
        const count = await client.query(`SELECT COUNT(*)::int AS count FROM activity_participants WHERE activity_id = $1 AND status IN ('registered','checked_in')`, [activity.id]);
        if (Number(count.rows[0].count) >= Number(activity.capacity)) return { error: '活动名额已满', status: 409 };
      }
      let coupon = null;
      if (couponCode) {
        const couponResult = await client.query(`SELECT * FROM coupons WHERE code = $1 FOR UPDATE`, [couponCode]);
        coupon = couponResult.rows[0];
        const now = new Date();
        if (!coupon || coupon.status !== 'active' || new Date(coupon.starts_at) > now || (coupon.ends_at && new Date(coupon.ends_at) < now) || (Number(coupon.total_count) > 0 && Number(coupon.used_count) >= Number(coupon.total_count))) return { error: '优惠券不可用', status: 400 };
        await client.query(`INSERT INTO coupon_claims (coupon_id, user_id) VALUES ($1,$2) ON CONFLICT (coupon_id,user_id) DO NOTHING`, [coupon.id, req.userId]);
      }
      const original = Number(activity.price_cents);
      const amount = Math.max(0, original - couponDiscount(coupon, original));
      const orderNo = createOrderNo();
      const order = await client.query(`INSERT INTO activity_orders (order_no, activity_id, user_id, coupon_id, original_amount_cents, amount_cents, provider, client_request_id, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW() + INTERVAL '15 minutes') RETURNING *`, [orderNo, activity.id, req.userId, coupon ? coupon.id : null, original, amount, paymentMode() === 'wechat' ? 'wechat' : 'mock', clientRequestId]);
      return { order: order.rows[0], activity, idempotent: false };
    });
    if (result.error) return res.status(result.status || 400).json({ message: result.error });
    res.status(result.idempotent ? 200 : 201).json({ order: { ...result.order, original_amount_yuan: centsToYuan(result.order.original_amount_cents), amount_yuan: centsToYuan(result.order.amount_cents) }, payment_mode: paymentMode(), idempotent: result.idempotent });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/v1/orders', requireUser, async (req, res) => {
  try {
    const result = await query(`SELECT o.*, a.title AS activity_title, a.start_at, a.end_at FROM activity_orders o JOIN activities a ON a.id = o.activity_id WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 100`, [req.userId]);
    res.json({ orders: result.rows.map((row) => ({ ...row, amount_yuan: centsToYuan(row.amount_cents), original_amount_yuan: centsToYuan(row.original_amount_cents) })) });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/v1/orders/:orderNo', requireUser, async (req, res) => {
  try {
    const result = await query(`SELECT o.*, a.title AS activity_title, a.start_at, a.end_at FROM activity_orders o JOIN activities a ON a.id = o.activity_id WHERE o.order_no = $1 AND o.user_id = $2`, [req.params.orderNo, req.userId]);
    if (!result.rows[0]) return res.status(404).json({ message: '订单不存在' });
    const order = result.rows[0];
    res.json({ order: { ...order, amount_yuan: centsToYuan(order.amount_cents), original_amount_yuan: centsToYuan(order.original_amount_cents) } });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/v1/orders/:orderNo/pay', requireUser, async (req, res) => {
  if (paymentMode() !== 'mock') return res.status(501).json({ message: '当前为生产支付模式，请使用微信支付接口' });
  try {
    const result = await withTransaction(async (client) => {
      const orderResult = await client.query(`SELECT o.*, a.capacity FROM activity_orders o JOIN activities a ON a.id = o.activity_id WHERE o.order_no = $1 AND o.user_id = $2 FOR UPDATE`, [req.params.orderNo, req.userId]);
      const order = orderResult.rows[0];
      if (!order) return { error: '订单不存在', status: 404 };
      if (order.status === 'paid') return { order };
      if (order.status !== 'pending') return { error: '订单状态不可支付', status: 409 };
      if (order.expires_at && new Date(order.expires_at) <= new Date()) {
        await client.query(`UPDATE activity_orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
        return { error: '订单已过期，请重新下单', status: 409 };
      }
      const settled = await settleActivityPayment(client, order, `mock_${order.order_no}`, 'mock', { orderNo: order.order_no, amountCents: order.amount_cents });
      if (settled.error) return { error: settled.error, status: 409 };
      return { order: settled.order };
    });
    if (result.error) return res.status(result.status || 400).json({ message: result.error });
    res.json({ ok: true, order: result.order });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/v1/orders/:orderNo/refund', requireUser, async (req, res) => {
  try {
    const orderResult = await query(`SELECT * FROM activity_orders WHERE order_no = $1 AND user_id = $2`, [req.params.orderNo, req.userId]);
    const order = orderResult.rows[0];
    if (!order) return res.status(404).json({ message: '订单不存在' });
    if (order.status === 'refunded') return res.json({ ok: true, order, idempotent: true });
    if (order.status !== 'paid') return res.status(409).json({ message: '只有已支付订单可以退款' });

    if (order.provider === 'wechat') {
      if (!wechatReady()) return res.status(501).json({ message: '尚未配置完整微信支付参数，暂不能发起微信退款' });
      const refundNo = order.refund_no || createOrderNo('RF');
      await query(`UPDATE activity_orders SET refund_no = COALESCE(refund_no, $1), refund_status = 'requested' WHERE id = $2 AND status = 'paid'`, [refundNo, order.id]);
      const refundPayload = {
        out_trade_no: order.order_no,
        out_refund_no: refundNo,
        reason: String((req.body || {}).reason || '用户申请退款').slice(0, 80),
        notify_url: process.env.WECHAT_REFUND_NOTIFY_URL || process.env.WECHAT_NOTIFY_URL,
        amount: { refund: Number(order.amount_cents), total: Number(order.amount_cents), currency: 'CNY' }
      };
      let refundResponse;
      try {
        refundResponse = await wechatRequest('POST', '/v3/refund/domestic/refunds', refundPayload);
      } catch (error) {
        await query(`UPDATE activity_orders SET refund_status = 'failed', refund_payload = $1 WHERE id = $2 AND status = 'paid'`, [{ error: error.message, detail: error.detail || null }, order.id]);
        return res.status(error.status === 400 ? 400 : 502).json({ message: error.message, refundNo });
      }
      const result = await withTransaction(async (client) => {
        const currentResult = await client.query(`SELECT * FROM activity_orders WHERE id = $1 FOR UPDATE`, [order.id]);
        const current = currentResult.rows[0];
        if (!current) return { error: '订单不存在', status: 404 };
        if (current.status === 'refunded') return { order: current, idempotent: true };
        const updated = await applyWechatRefundResult(client, current, refundResponse);
        return { order: updated };
      });
      if (result.error) return res.status(result.status || 400).json({ message: result.error });
      return res.json({ ok: true, order: result.order, refund: refundResponse, pending: result.order.status !== 'refunded' });
    }

    const result = await withTransaction(async (client) => {
      const lockedResult = await client.query(`SELECT * FROM activity_orders WHERE id = $1 FOR UPDATE`, [order.id]);
      const locked = lockedResult.rows[0];
      if (!locked) return { error: '订单不存在', status: 404 };
      if (locked.status === 'refunded') return { order: locked, idempotent: true };
      if (locked.status !== 'paid') return { error: '只有已支付订单可以退款', status: 409 };
      const updated = await client.query(`UPDATE activity_orders SET status = 'refunded', refunded_at = NOW(), refund_status = 'success' WHERE id = $1 RETURNING *`, [locked.id]);
      await client.query(`UPDATE activity_participants SET status = 'cancelled' WHERE activity_id = $1 AND user_id = $2`, [locked.activity_id, req.userId]);
      if (locked.coupon_id) {
        await client.query(`UPDATE coupons SET used_count = GREATEST(used_count - 1, 0) WHERE id = $1`, [locked.coupon_id]);
        await client.query(`UPDATE coupon_claims SET used_at = NULL, order_no = NULL WHERE coupon_id = $1 AND user_id = $2`, [locked.coupon_id, req.userId]);
      }
      await client.query(`INSERT INTO payment_events (provider, event_id, order_no, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING`, [locked.provider, `refund:${locked.order_no}`, locked.order_no, { orderNo: locked.order_no, action: 'refund' }]);
      return { order: updated.rows[0] };
    });
    if (result.error) return res.status(result.status || 400).json({ message: result.error });
    res.json({ ok: true, order: result.order, idempotent: Boolean(result.idempotent) });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/v1/orders/:orderNo/payments/wechat', requireUser, async (req, res) => {
  if (!wechatReady()) return res.status(501).json({ message: '尚未配置完整微信支付参数：WECHAT_APPID、WECHAT_MCHID、WECHAT_SERIAL_NO、WECHAT_PRIVATE_KEY(_PATH)、WECHAT_NOTIFY_URL' });
  if (!req.userId.startsWith('wx:')) return res.status(400).json({ message: '微信支付需要微信登录用户' });
  try {
    const orderResult = await query(`SELECT o.*, a.title AS activity_title FROM activity_orders o JOIN activities a ON a.id = o.activity_id WHERE o.order_no = $1 AND o.user_id = $2`, [req.params.orderNo, req.userId]);
    const order = orderResult.rows[0];
    if (!order) return res.status(404).json({ message: '订单不存在' });
    if (order.status !== 'pending') return res.status(409).json({ message: '订单状态不可发起微信支付' });
    if (order.expires_at && new Date(order.expires_at) <= new Date()) return res.status(409).json({ message: '订单已过期，请重新下单' });
    if (Number(order.amount_cents) <= 0) return res.status(400).json({ message: '零金额订单无需微信支付，请直接完成报名' });
    const notifyPath = new URL(process.env.WECHAT_NOTIFY_URL).pathname;
    const data = await wechatRequest('POST', '/v3/pay/transactions/jsapi', {
      appid: process.env.WECHAT_APPID, mchid: process.env.WECHAT_MCHID, description: order.activity_title,
      out_trade_no: order.order_no, notify_url: process.env.WECHAT_NOTIFY_URL,
      amount: { total: Number(order.amount_cents), currency: 'CNY' }, payer: { openid: req.userId.slice(3) }
    });
    if (!data.prepay_id) return res.status(502).json({ message: '微信支付未返回 prepay_id' });
    await query(`UPDATE activity_orders SET provider = 'wechat' WHERE id = $1 AND status = 'pending'`, [order.id]);
    const timeStamp = String(Math.floor(Date.now() / 1000)); const nonceStr = crypto.randomBytes(16).toString('hex'); const packageValue = `prepay_id=${data.prepay_id}`;
    const payMessage = `${process.env.WECHAT_APPID}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`;
    const paySign = crypto.createSign('RSA-SHA256').update(payMessage).sign(wechatPrivateKey(), 'base64');
    res.json({ timeStamp, nonceStr, package: packageValue, signType: 'RSA', paySign, orderNo: order.order_no, notifyPath });
  } catch (error) { res.status(error.status && error.status >= 400 && error.status < 500 ? 502 : 500).json({ message: error.message }); }
});

app.post('/api/v1/payments/wechat/notify', async (req, res) => {
  if (!wechatReady() || !process.env.WECHAT_API_V3_KEY || !process.env.WECHAT_PLATFORM_CERT_PATH) return res.status(501).json({ message: '尚未配置微信支付回调验签参数：WECHAT_API_V3_KEY、WECHAT_PLATFORM_CERT_PATH' });
  if (!verifyWechatNotification(req)) return res.status(401).json({ code: 'SIGNATURE_ERROR', message: '微信支付回调验签失败' });
  try {
    const payment = decryptWechatResource(req.body.resource || {});
    if (payment.trade_state !== 'SUCCESS') return res.json({ code: 'SUCCESS', message: '已接收非成功状态' });
    const result = await withTransaction(async (client) => {
      const orderResult = await client.query(`SELECT * FROM activity_orders WHERE order_no = $1 FOR UPDATE`, [payment.out_trade_no]);
      const order = orderResult.rows[0];
      if (!order) return { error: '订单不存在' };
      if (order.status === 'paid') return { alreadyPaid: true };
      if (order.status !== 'pending') return { error: '订单状态不可更新' };
      const settled = await settleActivityPayment(client, order, payment.transaction_id, 'wechat', payment);
      return settled;
    });
    if (result.error) return res.status(409).json({ code: 'ORDER_STATE_ERROR', message: result.error });
    res.json({ code: 'SUCCESS', message: '成功', idempotent: Boolean(result.alreadyPaid) });
  } catch (error) { res.status(400).json({ code: 'DECRYPT_ERROR', message: error.message }); }
});

app.post('/api/v1/payments/wechat/refund-notify', async (req, res) => {
  if (!process.env.WECHAT_API_V3_KEY || !process.env.WECHAT_PLATFORM_CERT_PATH) return res.status(501).json({ message: '尚未配置微信支付退款回调验签参数：WECHAT_API_V3_KEY、WECHAT_PLATFORM_CERT_PATH' });
  if (!verifyWechatNotification(req)) return res.status(401).json({ code: 'SIGNATURE_ERROR', message: '微信退款回调验签失败' });
  try {
    const refund = decryptWechatResource(req.body.resource || {});
    const result = await withTransaction(async (client) => {
      const orderResult = await client.query(`SELECT * FROM activity_orders WHERE refund_no = $1 OR order_no = $2 FOR UPDATE`, [refund.out_refund_no || '', refund.out_trade_no || '']);
      const order = orderResult.rows[0];
      if (!order) return { error: '订单不存在' };
      const updated = await applyWechatRefundResult(client, order, refund);
      return { order: updated };
    });
    if (result.error) return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: result.error });
    res.json({ code: 'SUCCESS', message: '成功', orderStatus: result.order.status, refundStatus: result.order.refund_status });
  } catch (error) { res.status(400).json({ code: 'DECRYPT_ERROR', message: error.message }); }
});

app.post('/api/v1/coupons/:code/claim', requireUser, async (req, res) => {
  try {
    const coupon = await query(`SELECT * FROM coupons WHERE code = $1`, [String(req.params.code).toUpperCase()]);
    const row = coupon.rows[0];
    const now = new Date();
    if (!row || row.status !== 'active' || new Date(row.starts_at) > now || (row.ends_at && new Date(row.ends_at) < now) || (Number(row.total_count) > 0 && Number(row.used_count) >= Number(row.total_count))) return res.status(400).json({ message: '优惠券不可领取' });
    await query(`INSERT INTO coupon_claims (coupon_id, user_id) VALUES ($1,$2) ON CONFLICT (coupon_id,user_id) DO NOTHING`, [row.id, req.userId]);
    res.json({ ok: true, coupon: row });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/v1/me/coupons', requireUser, async (req, res) => {
  try {
    const result = await query(`SELECT cc.*, c.code, c.name, c.discount_type, c.value, c.ends_at, c.status FROM coupon_claims cc JOIN coupons c ON c.id = cc.coupon_id WHERE cc.user_id = $1 ORDER BY cc.claimed_at DESC`, [req.userId]);
    res.json({ coupons: result.rows });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/v1/admin/coupons', requireUser, requireAdmin, async (req, res) => {
  const body = req.body || {};
  if (!body.code || !body.name || !['fixed','percent'].includes(body.discountType)) return res.status(400).json({ message: '优惠券参数不完整' });
  try {
    const result = await query(`INSERT INTO coupons (merchant_id, code, name, discount_type, value, total_count, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [body.merchantId || null, String(body.code).trim().toUpperCase(), String(body.name).slice(0, 120), body.discountType, Number(body.value), Number(body.totalCount || 0), body.startsAt || new Date(), body.endsAt || null]);
    res.status(201).json({ coupon: result.rows[0] });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/v1/membership/plans', requireUser, async (_req, res) => {
  try { const result = await query(`SELECT * FROM membership_plans WHERE status = 'active' ORDER BY price_cents`); res.json({ plans: result.rows.map((p) => ({ ...p, price_yuan: centsToYuan(p.price_cents) })) }); }
  catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/v1/membership/me', requireUser, async (req, res) => {
  try { res.json({ membership: await getMembership(req.userId) }); }
  catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/v1/membership/subscribe', requireUser, async (req, res) => {
  try {
    const planResult = await query(`SELECT * FROM membership_plans WHERE code = $1 AND status = 'active'`, [String((req.body || {}).planCode || '').trim()]);
    const plan = planResult.rows[0];
    if (!plan) return res.status(404).json({ message: '会员计划不存在' });
    if (paymentMode() !== 'mock') return res.status(501).json({ message: '会员微信支付适配尚未配置' });
    const subscription = await withTransaction(async (client) => {
      const start = new Date();
      const end = new Date(start.getTime() + Number(plan.duration_days) * 86400000);
      const orderNo = createOrderNo('MEM');
      const result = await client.query(`INSERT INTO membership_subscriptions (user_id, plan_id, order_no, provider, start_at, end_at) VALUES ($1,$2,$3,'mock',$4,$5) RETURNING *`, [req.userId, plan.id, orderNo, start, end]);
      return result.rows[0];
    });
    res.status(201).json({ subscription, plan });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/v1/activities/:activityId/checkin', requireUser, async (req, res) => {
  try {
    const result = await query(`UPDATE activity_participants SET status = 'checked_in', checked_in_at = NOW() WHERE activity_id = $1 AND user_id = $2 AND status = 'registered' RETURNING *`, [req.params.activityId, req.userId]);
    if (!result.rows[0]) return res.status(409).json({ message: '只有已支付报名用户可以签到，或已经签到' });
    res.json({ ok: true, participant: result.rows[0] });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/v1/admin/challenges/:challengeId/sponsor', requireUser, requireAdmin, async (req, res) => {
  try {
    const result = await query(`UPDATE challenges SET merchant_id = $1, sponsor_label = $2 WHERE id = $3 RETURNING *`, [req.body.merchantId || null, String(req.body.sponsorLabel || '').slice(0, 120) || null, req.params.challengeId]);
    if (!result.rows[0]) return res.status(404).json({ message: '挑战不存在' });
    res.json({ challenge: result.rows[0] });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/v1/admin/commerce/summary', requireUser, requireAdmin, async (_req, res) => {
  try {
    const [orders, participants, members, coupons] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total_orders, COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_orders, COUNT(*) FILTER (WHERE status = 'refunded')::int AS refunded_orders, COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid'),0)::int AS paid_amount_cents FROM activity_orders`),
      query(`SELECT COUNT(*)::int AS total_participants, COUNT(*) FILTER (WHERE status = 'checked_in')::int AS checked_in FROM activity_participants WHERE status <> 'cancelled'`),
      query(`SELECT COUNT(*)::int AS active_members FROM membership_subscriptions WHERE status = 'active' AND end_at > NOW()`),
      query(`SELECT COUNT(*)::int AS claimed_coupons, COUNT(*) FILTER (WHERE used_at IS NOT NULL)::int AS used_coupons FROM coupon_claims`)
    ]);
    res.json({ orders: { ...orders.rows[0], paid_amount_yuan: centsToYuan(orders.rows[0].paid_amount_cents) }, participants: participants.rows[0], members: members.rows[0], coupons: coupons.rows[0] });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/v1/admin/orders', requireUser, requireAdmin, async (_req, res) => {
  try { const result = await query(`SELECT o.*, a.title AS activity_title, u.nickname FROM activity_orders o JOIN activities a ON a.id = o.activity_id JOIN app_users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 200`); res.json({ orders: result.rows }); }
  catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/v1/admin/media', requireUser, requireAdmin, async (req, res) => {
  const moderationStatus = String(req.query.moderationStatus || '').trim();
  const processingStatus = String(req.query.processingStatus || '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 200);
  try {
    const conditions = [];
    const params = [];
    if (['pending', 'approved', 'rejected'].includes(moderationStatus)) { params.push(moderationStatus); conditions.push(`ma.moderation_status = $${params.length}`); }
    if (['pending', 'ready', 'rejected'].includes(processingStatus)) { params.push(processingStatus); conditions.push(`ma.processing_status = $${params.length}`); }
    params.push(limit);
    const result = await query(`SELECT ma.*, u.nickname, t.name AS trip_name, p.name AS place_name,
        COALESCE((SELECT json_agg(mj ORDER BY mj.created_at DESC) FROM media_jobs mj WHERE mj.media_id = ma.id), '[]'::json) AS jobs
      FROM media_assets ma JOIN app_users u ON u.id = ma.owner_id
      LEFT JOIN trips t ON t.id = ma.trip_id
      LEFT JOIN visits v ON v.id = ma.visit_id
      LEFT JOIN places p ON p.id = v.place_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY ma.created_at DESC LIMIT $${params.length}`, params);
    res.json({ media: result.rows });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/v1/admin/media/:mediaId/review', requireUser, requireAdmin, async (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ message: 'status 必须是 approved 或 rejected' });
  const note = String((req.body || {}).note || '').slice(0, 500) || null;
  try {
    const result = await query(`UPDATE media_assets SET moderation_status = $1, moderated_by = $2, moderated_at = NOW(), moderation_note = $3 WHERE id = $4 RETURNING *`, [status, req.userId, note, req.params.mediaId]);
    if (!result.rows[0]) return res.status(404).json({ message: '媒体不存在' });
    res.json({ media: result.rows[0] });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/v1/admin/activities', requireUser, requireAdmin, async (_req, res) => {
  try { const result = await query(`SELECT a.*, COALESCE(COUNT(ap.user_id) FILTER (WHERE ap.status <> 'cancelled'),0)::int AS participant_count FROM activities a LEFT JOIN activity_participants ap ON ap.activity_id = a.id GROUP BY a.id ORDER BY a.start_at DESC`); res.json({ activities: result.rows }); }
  catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/v1/admin/reviews', requireUser, requireAdmin, async (_req, res) => {
  try {
    const result = await query(`SELECT v.id, v.user_id, v.place_id, p.name, p.kind, v.visit_type, v.visited_at, v.latitude, v.longitude, v.accuracy_m, v.verification_status, v.risk_level, v.note, v.created_at
      FROM visits v JOIN places p ON p.id = v.place_id WHERE v.verification_status = 'manual_review' ORDER BY v.created_at ASC LIMIT 100`);
    res.json({ reviews: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/v1/admin/visits/:visitId/review', requireUser, requireAdmin, async (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!['verified', 'rejected'].includes(status)) return res.status(400).json({ message: 'status 必须是 verified 或 rejected' });
  try {
    const result = await withTransaction(async (client) => {
      const updated = await client.query(`UPDATE visits SET verification_status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3 RETURNING *`, [status, req.userId, req.params.visitId]);
      if (!updated.rows[0]) return { error: '记录不存在' };
      if (status === 'verified') await scoreVerifiedVisit(client, req.params.visitId, updated.rows[0].user_id);
      return { visit: updated.rows[0] };
    });
    if (result.error) return res.status(404).json({ message: result.error });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

waitForDatabase().then(runMigrations).then(() => {
  app.listen(port, () => console.log(`行迹山河 MVP listening on :${port}`));
}).catch((error) => {
  console.error('Database startup failed:', error);
  process.exit(1);
});
