import { buildApp } from './app';
import { config } from './config';
import { pool } from './db/client';

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: config.GATEWAY_PORT, host: config.GATEWAY_HOST });
    app.log.info(`Gateway running on ${config.GATEWAY_HOST}:${config.GATEWAY_PORT}`);
    app.log.info(`API docs at http://localhost:${config.GATEWAY_PORT}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});

main();
