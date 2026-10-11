// dbBackupService.js — automated MongoDB backups to Cloudflare R2.
// Every backup is a single gzipped mongodump archive, stored under a private,
// UNGUESSABLE key (random token) so the public media domain can't serve it to a
// stranger; downloads always go through the admin-only streaming route. Keeps the
// most recent RETENTION backups and auto-deletes older ones.
//
// Restore (manual, when ever needed):
//   mongorestore --uri="<MONGODB_URI>" --gzip --archive=<downloaded-file>.gz --drop

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const {
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { s3Client, bucketName } = require('../config/cloudflare');

const PREFIX = 'db-backups/';
const RETENTION = 4; // keep the most recent 4 (≈ 12h of 3-hourly backups)

// IST "YYYY-MM-DD_HH-mm" for the human-readable part of the filename.
function istStamp(d = new Date()) {
  const t = new Date(d.getTime() + 5.5 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}_${p(t.getUTCHours())}-${p(t.getUTCMinutes())}`;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 16 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').toString().slice(0, 500)));
      resolve({ stdout, stderr });
    });
  });
}

/** Create a fresh backup, upload to R2, then enforce retention. */
async function createBackup() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/short_news';
  if (!bucketName) throw new Error('R2 bucket not configured');

  const stamp = istStamp();
  const token = crypto.randomBytes(8).toString('hex');
  const key = `${PREFIX}backup-${stamp}-${token}.gz`;
  const tmpFile = path.join(os.tmpdir(), `dbbackup-${stamp}-${token}.gz`);

  // Dump from a secondary when available so the primary isn't loaded.
  await run('mongodump', [
    '--uri', uri,
    `--archive=${tmpFile}`,
    '--gzip',
    '--readPreference=secondaryPreferred',
  ]);

  const stat = fs.statSync(tmpFile);
  try {
    // STREAM the (large) archive to R2 in 10 MB multipart chunks — constant, low
    // memory. A plain PutObject buffers the whole body to sign it, which OOM-crashed
    // the app process on the ~1 GB dump.
    const uploader = new Upload({
      client: s3Client,
      queueSize: 3,
      partSize: 10 * 1024 * 1024,
      params: {
        Bucket: bucketName,
        Key: key,
        Body: fs.createReadStream(tmpFile),
        ContentType: 'application/gzip',
        CacheControl: 'no-store',
      },
    });
    await uploader.done();
  } finally {
    fs.unlink(tmpFile, () => {});
  }

  await enforceRetention();
  return { key, sizeBytes: stat.size, createdAt: new Date() };
}

/** List backups, newest first: [{ key, name, sizeBytes, lastModified }]. */
async function listBackups() {
  const out = await s3Client.send(new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: PREFIX,
    MaxKeys: 1000,
  }));
  const items = (out.Contents || [])
    .filter((o) => o.Key && o.Key !== PREFIX)
    .map((o) => ({
      key: o.Key,
      name: o.Key.slice(PREFIX.length),
      sizeBytes: o.Size || 0,
      lastModified: o.LastModified || null,
    }));
  items.sort((a, b) => (b.lastModified?.getTime() || 0) - (a.lastModified?.getTime() || 0));
  return items;
}

/** Delete everything beyond the most recent RETENTION backups. */
async function enforceRetention() {
  const items = await listBackups();
  const old = items.slice(RETENTION);
  for (const it of old) {
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: it.key }));
    } catch (_) {}
  }
  return old.length;
}

/** Stream a backup object to an Express response as an attachment download. */
async function streamDownload(key, res) {
  if (!key || !key.startsWith(PREFIX) || key.includes('..')) {
    res.status(400).send('Invalid backup key');
    return;
  }
  const obj = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(key)}"`);
  if (obj.ContentLength) res.setHeader('Content-Length', obj.ContentLength);
  obj.Body.pipe(res);
}

async function deleteBackup(key) {
  if (!key || !key.startsWith(PREFIX) || key.includes('..')) throw new Error('Invalid backup key');
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
  return true;
}

module.exports = { createBackup, listBackups, enforceRetention, streamDownload, deleteBackup, RETENTION, PREFIX };
