/**
 * Migrate media URLs from Cloudflare R2 public dev domain to custom CDN domain.
 *
 * Usage:
 *   node migrate-r2-to-cdn-domain.js           # dry-run (preview only)
 *   node migrate-r2-to-cdn-domain.js --apply   # write changes to MongoDB
 *   node migrate-r2-to-cdn-domain.js --apply --verbose
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const News = require('./models/News');
const Ad = require('./models/Ad');
const Category = require('./models/Category');
const ViralVideo = require('./models/ViralVideo');
const Notification = require('./models/Notification');
const Admin = require('./models/Admin');

const NEW_CDN_BASE = process.env.CDN_MIGRATION_TARGET_URL
  || process.env.CLOUDFLARE_R2_PUBLIC_URL
  || 'https://media.yellowsingam.com';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const BATCH_SIZE = 500;
const LOG_FILE = path.join(__dirname, 'migrate-r2-cdn.log');

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, `${line}\n`);
}

function normalizeCdnBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function migrateUrl(value, cdnBase) {
  if (!value || typeof value !== 'string') return value;
  if (!/r2\.dev/i.test(value)) return value;
  return value.replace(/https?:\/\/pub-[a-z0-9]+\.r2\.dev/gi, cdnBase);
}

function buildQuery(fieldConfig) {
  const conditions = [];

  fieldConfig.stringFields.forEach((field) => {
    conditions.push({ [field]: { $regex: 'r2\\.dev', $options: 'i' } });
  });

  fieldConfig.arrayFields.forEach((field) => {
    conditions.push({ [field]: { $elemMatch: { $regex: 'r2\\.dev', $options: 'i' } } });
  });

  return conditions.length > 0 ? { $or: conditions } : {};
}

async function countMatches(Model, fieldConfig) {
  const query = buildQuery(fieldConfig);
  return Model.countDocuments(query);
}

async function migrateStringField(Model, field, cdnBase) {
  const query = { [field]: { $regex: 'r2\\.dev', $options: 'i' } };
  const matched = await Model.countDocuments(query);
  if (!matched) return { matched: 0, changed: 0 };

  if (!APPLY) {
    return { matched, changed: matched };
  }

  const docs = await Model.find(query).select(`_id ${field}`).lean();
  let changed = 0;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const ops = [];

    batch.forEach((doc) => {
      const nextValue = migrateUrl(doc[field], cdnBase);
      if (nextValue === doc[field]) return;
      changed += 1;
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { [field]: nextValue } }
        }
      });
    });

    if (ops.length > 0) {
      await Model.bulkWrite(ops, { ordered: false });
      log(`  ${field}: batch ${Math.floor(i / BATCH_SIZE) + 1}, updated ${ops.length}`);
    }
  }

  return { matched, changed };
}

async function migrateArrayField(Model, field, cdnBase) {
  const query = { [field]: { $elemMatch: { $regex: 'r2\\.dev', $options: 'i' } } };
  const matched = await Model.countDocuments(query);
  if (!matched) return { matched: 0, changed: 0 };

  if (!APPLY) {
    return { matched, changed: matched };
  }

  const docs = await Model.find(query).select(`_id ${field}`).lean();
  let changed = 0;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const ops = [];

    batch.forEach((doc) => {
      const nextValue = (doc[field] || []).map((item) => migrateUrl(item, cdnBase));
      const hasChange = nextValue.some((item, index) => item !== doc[field][index]);
      if (!hasChange) return;
      changed += 1;
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { [field]: nextValue } }
        }
      });
    });

    if (ops.length > 0) {
      await Model.bulkWrite(ops, { ordered: false });
      log(`  ${field}[]: batch ${Math.floor(i / BATCH_SIZE) + 1}, updated ${ops.length}`);
    }
  }

  return { matched, changed };
}

async function migrateCollection(Model, name, fieldConfig, cdnBase) {
  const matched = await countMatches(Model, fieldConfig);
  log(`\n[${name}] matched documents: ${matched}`);

  if (!APPLY) {
    log(`[${name}] would update: ${matched}`);
    return { matched, changed: matched };
  }

  let changed = 0;

  for (const field of fieldConfig.stringFields) {
    const result = await migrateStringField(Model, field, cdnBase);
    changed += result.changed;
    log(`[${name}] field ${field}: updated ${result.changed}`);
  }

  for (const field of fieldConfig.arrayFields) {
    const result = await migrateArrayField(Model, field, cdnBase);
    changed += result.changed;
    log(`[${name}] field ${field}[]: updated ${result.changed}`);
  }

  log(`[${name}] total updated fields/docs: ${changed}`);
  return { matched, changed };
}

async function run() {
  const cdnBase = normalizeCdnBase(NEW_CDN_BASE);

  if (!cdnBase.startsWith('https://')) {
    throw new Error('CDN target must be an https URL, e.g. https://media.yellowsingam.com');
  }

  if (cdnBase.includes('r2.dev')) {
    throw new Error(
      'CLOUDFLARE_R2_PUBLIC_URL still points to r2.dev. Update .env to https://media.yellowsingam.com before --apply.'
    );
  }

  if (APPLY) {
    fs.writeFileSync(LOG_FILE, '');
  }

  log('R2 → CDN migration started');
  log(`Mode: ${APPLY ? 'APPLY (writing to DB)' : 'DRY RUN (preview only)'}`);
  log(`Target CDN: ${cdnBase}`);
  log(`Log file: ${LOG_FILE}`);

  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/short_news';
  await mongoose.connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });

  const collections = [
    [News, 'News', {
      stringFields: ['imageUrl', 'mediaUrl', 'thumbnailUrl', 'authorProfileImage'],
      arrayFields: ['imageUrls']
    }],
    [Ad, 'Ads', {
      stringFields: ['imageUrl'],
      arrayFields: ['imageUrls']
    }],
    [Category, 'Categories', {
      stringFields: ['imageUrl'],
      arrayFields: []
    }],
    [ViralVideo, 'ViralVideos', {
      stringFields: ['mediaUrl', 'thumbnailUrl'],
      arrayFields: []
    }],
    [Notification, 'Notifications', {
      stringFields: ['imageUrl'],
      arrayFields: []
    }],
    [Admin, 'Admins', {
      stringFields: ['profileImage'],
      arrayFields: []
    }]
  ];

  const summary = { matched: 0, changed: 0 };

  for (const [Model, name, fieldConfig] of collections) {
    const result = await migrateCollection(Model, name, fieldConfig, cdnBase);
    summary.matched += result.matched;
    summary.changed += result.changed;
  }

  log('\nSummary');
  log(`  Matched: ${summary.matched}`);
  log(`  ${APPLY ? 'Updated' : 'Would update'}: ${summary.changed}`);

  if (!APPLY) {
    log('\nDry run complete. Re-run with --apply to save changes.');
  } else {
    log('\nMigration complete.');
    log('Next: restart Node server and test images/videos in the app.');
  }

  await mongoose.disconnect();
}

run().catch(async (error) => {
  log(`Migration failed: ${error.message}`);
  try {
    await mongoose.disconnect();
  } catch (disconnectError) {
    // ignore
  }
  process.exit(1);
});
