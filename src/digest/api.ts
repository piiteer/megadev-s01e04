import type { Hono } from 'hono';
import type { RigConfig } from '../config.js';
import { readNight } from './reader.js';
import type { DigestRow } from './types.js';

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export function registerDigestApi(app: Hono, config: Pick<RigConfig, 'runsDir'>): void {
  app.get('/api/digest/:night', (c) => {
    let rows: DigestRow[];
    try {
      ({ rows } = readNight(config.runsDir, c.req.param('night')));
    } catch (error) {
      if (error instanceof RangeError || isMissingFile(error)) {
        return c.json({ error: 'not found' }, 404);
      }
      throw error;
    }

    return c.json(rows.toSorted((a, b) => a.job.localeCompare(b.job)));
  });
}
