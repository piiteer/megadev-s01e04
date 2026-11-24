import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, ReadNight, RunStatus } from './types.js';

type RunEvent = {
  at: string;
  job: string;
  status: RunStatus;
  owner: string | null;
  error?: string;
};

const statuses = new Set<RunStatus>(['ok', 'retry', 'fail']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRun(line: string): RunEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(value)) return null;
  if (typeof value.at !== 'string' || typeof value.job !== 'string') return null;
  if (typeof value.status !== 'string' || !statuses.has(value.status as RunStatus)) return null;
  if (value.owner !== null && typeof value.owner !== 'string') return null;
  if ('error' in value && typeof value.error !== 'string') return null;

  return {
    at: value.at,
    job: value.job,
    status: value.status as RunStatus,
    owner: value.owner,
    ...('error' in value ? { error: value.error as string } : {}),
  };
}

// Read runs/<night>.jsonl, keeping timestamps exactly as written in the log.
export const readNight: ReadNight = (runsDir, night) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(night)) {
    throw new RangeError(`Invalid night: ${night}`);
  }

  const contents = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  const lines = contents === '' ? [] : contents.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  const rowsByJob = new Map<string, DigestRow>();
  let badLines = 0;

  for (const line of lines) {
    const event = parseRun(line);
    if (!event) {
      badLines += 1;
      continue;
    }

    const row = rowsByJob.get(event.job);
    if (!row) {
      rowsByJob.set(event.job, {
        job: event.job,
        owner: event.owner,
        runs: 1,
        retries: event.status === 'retry' ? 1 : 0,
        lastStatus: event.status,
        lastError: event.error ?? null,
        firstAt: event.at,
        lastAt: event.at,
      });
      continue;
    }

    row.owner = event.owner;
    row.runs += 1;
    if (event.status === 'retry') row.retries += 1;
    row.lastStatus = event.status;
    if (event.error !== undefined) row.lastError = event.error;
    row.lastAt = event.at;
  }

  return { rows: [...rowsByJob.values()], badLines };
};
