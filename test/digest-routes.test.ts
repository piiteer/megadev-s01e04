import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const configFor = (runsDir: string) => ({
  adapter: 'shim',
  installed: '2026-10-29T14:06:00+01:00',
  beatEverySeconds: 60,
  runsDir,
});

async function withRuns<T>(files: Record<string, string>, run: (runsDir: string) => Promise<T>): Promise<T> {
  const runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-routes-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(runsDir, name), contents);
    }
    return await run(runsDir);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
}

const validRun = JSON.stringify({
  at: '2026-10-28T23:00:02+01:00',
  job: 'rig/rotate-logs',
  status: 'ok',
  owner: 'lane-07',
});

describe('digest page route', () => {
  it('renders a night with rows', async () => {
    await withRuns({ '2026-10-28.jsonl': `${validRun}\n` }, async (runsDir) => {
      const res = await createApp(configFor(runsDir)).request('/digest/2026-10-28');

      expect(res.status).toBe(200);
      expect(await res.text()).toContain('rig/rotate-logs');
    });
  });

  it('returns 404 when the night file is missing', async () => {
    await withRuns({}, async (runsDir) => {
      const res = await createApp(configFor(runsDir)).request('/digest/2026-10-28');

      expect(res.status).toBe(404);
    });
  });

  it('renders an empty night', async () => {
    await withRuns({ '2026-10-28.jsonl': '' }, async (runsDir) => {
      const res = await createApp(configFor(runsDir)).request('/digest/2026-10-28');
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(html).toContain('nothing ran');
    });
  });

  it('renders valid rows when the night contains a bad line', async () => {
    await withRuns({ '2026-10-28.jsonl': `not json\n${validRun}\n` }, async (runsDir) => {
      const res = await createApp(configFor(runsDir)).request('/digest/2026-10-28');
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(html).toContain('rig/rotate-logs');
      expect(html).not.toContain('not json');
    });
  });
});

describe('digest JSON route', () => {
  it('returns jobs in the same order as the page for the supplied night', async () => {
    const app = createApp(configFor('runs'));
    const pageResponse = await app.request('/digest/2026-10-28');
    const apiResponse = await app.request('/api/digest/2026-10-28');
    const html = await pageResponse.text();
    const pageJobs = [...html.matchAll(/<tr>\s*<td>([^<]+)<\/td>/g)].map((match) => match[1]);
    const apiRows: { job: string }[] = await apiResponse.json();

    expect(pageResponse.status).toBe(200);
    expect(apiResponse.status).toBe(200);
    expect(apiRows.map((row) => row.job)).toEqual(pageJobs);
  });

  it('returns a night as JSON rows', async () => {
    await withRuns({ '2026-10-28.jsonl': `${validRun}\n` }, async (runsDir) => {
      const res = await createApp(configFor(runsDir)).request('/api/digest/2026-10-28');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        {
          job: 'rig/rotate-logs',
          owner: 'lane-07',
          runs: 1,
          retries: 0,
          lastStatus: 'ok',
          lastError: null,
          firstAt: '2026-10-28T23:00:02+01:00',
          lastAt: '2026-10-28T23:00:02+01:00',
        },
      ]);
    });
  });

  it('returns 404 when the night file is missing', async () => {
    await withRuns({}, async (runsDir) => {
      const res = await createApp(configFor(runsDir)).request('/api/digest/2026-10-28');

      expect(res.status).toBe(404);
    });
  });

  it('returns an empty array for an empty night', async () => {
    await withRuns({ '2026-10-28.jsonl': '' }, async (runsDir) => {
      const res = await createApp(configFor(runsDir)).request('/api/digest/2026-10-28');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });

  it('returns valid rows when the night contains a bad line', async () => {
    await withRuns({ '2026-10-28.jsonl': `not json\n${validRun}\n` }, async (runsDir) => {
      const res = await createApp(configFor(runsDir)).request('/api/digest/2026-10-28');

      expect(res.status).toBe(200);
      const rows: unknown = await res.json();
      expect(rows).toEqual([
        expect.objectContaining({ job: 'rig/rotate-logs' }),
      ]);
    });
  });
});
