import path from 'node:path';
import { config } from './config.js';
import { openDb } from './db.js';
import { createScheduler } from './scheduler.js';
import { createServer } from './server.js';

// --demo: 데모 데이터(data/demo.db)로 웹 서버만 실행
if (process.argv.includes('--demo')) {
  config.demo = true;
  config.enableCollector = false;
  config.dbPath = path.resolve(process.env.DEMO_DB_PATH || 'data/demo.db');
}

const db = openDb(config.dbPath);

if (process.argv.includes('--collect-once')) {
  const scheduler = createScheduler(db, config);
  await scheduler.runOnce();
  await scheduler.updateFollowers();
  process.exit(0);
}

const server = createServer(db, config);
server.listen(config.port, () => {
  console.log(`StreamInsight 실행 중: http://localhost:${config.port}${config.demo ? '  (데모 데이터)' : ''}`);
});

let scheduler = null;
if (config.enableCollector) {
  scheduler = createScheduler(db, config);
  scheduler.start();
}

const shutdown = () => {
  scheduler?.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
