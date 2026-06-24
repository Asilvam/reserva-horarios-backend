const Redis = require('ioredis');

async function collectKeys(redis, pattern) {
  let cursor = '0';
  const keys = [];

  do {
    const [nextCursor, chunk] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', '500');
    cursor = nextCursor;
    if (chunk.length > 0) {
      keys.push(...chunk);
    }
  } while (cursor !== '0');

  return keys;
}

async function run() {
  const mode = process.argv[2] || 'check';
  const redisUrl = process.env.REDIS_URL || process.env.REDISCLOUD_URL || 'redis://localhost:6379';
  const redis = new Redis(redisUrl);

  try {
    if (mode === 'check') {
      const dbsize = await redis.dbsize();
      const eventKeys = await collectKeys(redis, 'event:*');
      console.log(`Redis URL: ${redisUrl}`);
      console.log(`DB size: ${dbsize}`);
      console.log(`event:* keys: ${eventKeys.length}`);
      return;
    }

    if (mode === 'clean') {
      const keys = await collectKeys(redis, 'event:*');
      if (keys.length === 0) {
        console.log('No event:* keys found. Nothing to delete.');
        return;
      }

      const deleted = await redis.del(...keys);
      console.log(`Deleted ${deleted} keys (pattern: event:*).`);
      return;
    }

    throw new Error(`Unknown mode '${mode}'. Use 'check' or 'clean'.`);
  } finally {
    await redis.quit();
  }
}

run().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
