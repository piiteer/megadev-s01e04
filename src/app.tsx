import { Hono } from 'hono';
import { loadConfig, type RigConfig } from './config.js';
import { readNight } from './digest/reader.js';
import type { NightReadResult } from './digest/types.js';
import { lane } from './lane.js';
import { readStatus } from './status.js';
import { DigestPage } from './views/digest.js';
import { Layout } from './views/layout.js';
import { StatusBoard } from './views/status.js';

export function createApp(config: RigConfig = loadConfig()) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, lane: lane().id }));

  app.get('/', (c) =>
    c.html(
      <Layout title="status" lane={lane()}>
        <StatusBoard status={readStatus(config)} />
      </Layout>,
    ),
  );

  app.get('/digest/:night', (c) => {
    let result: NightReadResult;
    try {
      result = readNight(config.runsDir, c.req.param('night'));
    } catch (error) {
      if (error instanceof RangeError || isMissingFile(error)) return c.notFound();
      throw error;
    }

    return c.html(
      <Layout title={`digest · ${c.req.param('night')}`} lane={lane()}>
        <DigestPage night={c.req.param('night')} rows={result.rows} />
      </Layout>,
    );
  });

  return app;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
