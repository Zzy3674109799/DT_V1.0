const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storageRoot = process.env.STORAGE_ROOT || path.join(__dirname, 'storage');
const pollMs = Math.max(500, Number(process.env.MEDIA_WORKER_POLL_MS || 1500));
let stopping = false;

async function waitForDatabase() {
  for (;;) {
    try {
      await pool.query('SELECT 1');
      const table = await pool.query(`SELECT to_regclass('public.media_jobs') AS name`);
      if (table.rows[0].name) return;
      throw new Error('media_jobs 尚未完成迁移');
    } catch (error) {
      console.error('媒体 worker 等待数据库:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

async function claimJob() {
  const result = await pool.query(`WITH next_job AS (
      SELECT id FROM media_jobs
      WHERE status = 'pending' AND available_at <= NOW() AND attempts < max_attempts
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE media_jobs j SET status = 'processing', attempts = j.attempts + 1, started_at = NOW(), updated_at = NOW()
    FROM next_job WHERE j.id = next_job.id RETURNING j.*`);
  return result.rows[0] || null;
}

async function completeJob(job, payload = {}) {
  await pool.query(`UPDATE media_jobs SET status = 'completed', payload = payload || $1::jsonb,
    completed_at = NOW(), updated_at = NOW(), error = NULL WHERE id = $2`, [payload, job.id]);
}

async function failJob(job, error) {
  const retry = Number(job.attempts) < Number(job.max_attempts);
  await pool.query(`UPDATE media_jobs SET status = $1, error = $2, available_at = CASE WHEN $1 = 'pending' THEN NOW() + INTERVAL '30 seconds' ELSE available_at END, updated_at = NOW() WHERE id = $3`, [retry ? 'pending' : 'failed', String(error.message || error).slice(0, 2000), job.id]);
}

async function processJob(job) {
  const mediaResult = await pool.query('SELECT * FROM media_assets WHERE id = $1', [job.media_id]);
  const media = mediaResult.rows[0];
  if (!media) return completeJob(job, { skipped: true, reason: 'media_deleted' });

  const result = { worker: 'metadata-only', processedAt: new Date().toISOString() };
  if (job.job_type === 'metadata' && media.storage_provider === 'local') {
    const absolutePath = path.resolve(storageRoot, media.object_key);
    if (absolutePath.startsWith(path.resolve(storageRoot) + path.sep)) {
      try {
        const stat = await fs.promises.stat(absolutePath);
        result.fileSize = stat.size;
        result.modifiedAt = stat.mtime.toISOString();
        await pool.query(`UPDATE media_assets SET byte_size = CASE WHEN byte_size = 0 THEN $1 ELSE byte_size END,
          metadata = metadata || $2::jsonb WHERE id = $3`, [stat.size, { worker: result }, media.id]);
      } catch (error) {
        result.fileMissing = true;
        result.error = error.code || error.message;
      }
    }
  }
  if (job.job_type === 'thumbnail' && media.kind !== 'gpx') {
    const field = media.kind === 'video' ? 'poster_url' : 'thumbnail_url';
    await pool.query(`UPDATE media_assets SET ${field} = COALESCE(${field}, source_url), metadata = metadata || $1::jsonb WHERE id = $2`, [{ [`${field}Deferred`]: true }, media.id]);
    result.deferred = true;
  }
  if (job.job_type === 'transcode') result.deferred = true;
  if (job.job_type === 'moderation') result.pendingReview = media.moderation_status === 'pending';
  await completeJob(job, result);
}

async function run() {
  await waitForDatabase();
  console.log('媒体 worker 已启动');
  while (!stopping) {
    try {
      const job = await claimJob();
      if (job) await processJob(job).catch((error) => failJob(job, error));
      else await new Promise((resolve) => setTimeout(resolve, pollMs));
    } catch (error) {
      console.error('媒体 worker 执行失败:', error.message);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  await pool.end();
}

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
run().catch((error) => { console.error(error); process.exit(1); });
