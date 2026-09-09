/**
 * Tests for `get_observation` — the bounded read-by-id (D21).
 *
 * The gap: observation ids are handed out by `remember`, `recall` and `export`,
 * and both tools that ACCEPT an id destroy rows (`forget` deletes; `merge`
 * deletes every source and keeps only the caller's text). There was no
 * id-taking read, so a caller holding a destruction key could not see what it
 * addressed without `recall` — which is unbounded in practice, ranks badly at
 * `limit: 1`, and is itself a WRITE.
 *
 * Every bound below carries a positive control: an assertion that the fixture
 * WOULD have blown the bound under the alternative it replaces. A guard test
 * without one passes while proving nothing, which this repo has now had four
 * times (see CLAUDE.md and the D11 control tests).
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-get-observation-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-get-observation';
process.env.HIPPO_DB_PATH = DB_PATH;
delete process.env.HIPPO_APPEND_ONLY_PREFIXES; // exercise the shipped defaults

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { recall } = await import('../src/mcp/tools/recall.js');
const { forget } = await import('../src/mcp/tools/forget.js');
const { getObservation } = await import('../src/mcp/tools/get-observation.js');
const { findEntityByName } = await import('../src/db/entities.js');
const { getObservationsByEntity, getObservationsByIds } = await import('../src/db/observations.js');

before(() => {
  initDatabase();
});

after(() => {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
});

/** Serialize exactly as the tool handler in src/mcp/server.ts does. */
function wireSize(result: unknown): number {
  return JSON.stringify(result, null, 2).length;
}

const OBSERVATION_CHARS = 45_000;

/**
 * The same shape as the near-match fixture that motivated the cap: parts share
 * a header (which is what carries them over the near-match threshold, exactly
 * as real harvest entries do) and differ in the bulk after it.
 */
function ledgerPart(part: number): string {
  const header =
    'RESEARCH LEDGER — EO market formation, sequel run. Structure: sources, extraction notes, ' +
    'contradictions flagged for review, open threads, and the running confidence table. ' +
    'Each part continues the previous one; numbering is sequential and the format is fixed. ';
  return (header + `Part ${part} findings. `).padEnd(OBSERVATION_CHARS, `part-${part}-payload `);
}

/** `createObservation` hardcodes datetime('now'), so distinct days need SQL. */
function backdate(observationId: string, day: string): void {
  getDatabase()
    .prepare("UPDATE observations SET created_at = ? || ' 12:00:00' WHERE id = ?")
    .run(day, observationId);
}

function rowById(id: string) {
  const [row] = getObservationsByIds([id]);
  assert.ok(row, `fixture row ${id} must exist`);
  return row!;
}

// ---------------------------------------------------------------------------
// The bound, measured against the alternative it replaces
// ---------------------------------------------------------------------------

describe('get_observation is bounded where the prescribed recall re-read is not', () => {
  const entity = 'raw:research:fetch-bound';
  const ids: string[] = [];

  before(async () => {
    for (let part = 1; part <= 5; part++) {
      const written = await remember({ entity, content: ledgerPart(part) });
      backdate(written.observationId, `2026-09-0${part}`);
      ids.push(written.observationId);
    }
    // Same-UTC-day dedup would collapse these into one and the test would
    // measure a one-row store while claiming to measure five.
    assert.equal(
      getObservationsByEntity(findEntityByName(entity)!.id).length,
      5,
      'all five parts must be stored separately'
    );
  });

  test('returns exactly the row named, at roughly the size of that row', () => {
    const target = ids[2]; // part 3 — deliberately not the top-ranked sibling
    const result = getObservation({ observation_id: target });

    assert.equal(result.success, true);
    assert.equal(result.observation!.observation_id, target);
    assert.equal(result.observation!.content, rowById(target).content);

    const size = wireSize(result);
    const rowChars = rowById(target).content.length;
    // The bound claimed is "the row plus a small envelope", not "small".
    assert.ok(
      size < rowChars * 1.2,
      `response (${size}) must not materially exceed the row it returns (${rowChars})`
    );
  });

  test('CONTROL: the recall re-read this replaces returns the whole entity, and misses at limit 1', async () => {
    // Without this control the bound above is vacuous — it would pass on a
    // fixture where recall also returned one row, proving nothing about the
    // problem get_observation exists to solve.
    const target = ids[2];
    const preview = `${rowById(target).content.slice(0, 200)}…`;

    const wide = await recall({ query: preview.slice(0, 200), limit: 10, spread: false, format: 'full' });
    const wideSize = wireSize(wide);
    assert.ok(
      wideSize > wireSize(getObservation({ observation_id: target })) * 3,
      `recall at the default limit (${wideSize}) must dwarf the single-row fetch`
    );

    // And narrowing recall to one row does not fix it: the preview is shared by
    // every sibling (that is the near-match mechanism), so ranking, not the
    // similarity floor, decides which row comes back.
    const narrow = await recall({ query: preview.slice(0, 200), limit: 1, spread: false, format: 'full' });
    const returned = (narrow as { memories: Array<{ observation_id: string }> }).memories[0];
    assert.notEqual(
      returned.observation_id,
      target,
      'CONTROL PREMISE: limit:1 must miss the target here — if it starts hitting it, ' +
        'this fixture no longer demonstrates the ranking problem and needs rebuilding'
    );
  });
});

// ---------------------------------------------------------------------------
// It is a read. This is the property that distinguishes it from `recall`.
// ---------------------------------------------------------------------------

describe('get_observation performs no write', () => {
  const entity = 'project:fetch-read-only';

  test('recall_count and last_recalled_at are untouched, where recall moves both', async () => {
    const written = await remember({ entity, content: 'Deploy target is the Hetzner box at /opt/hippocampus.' });
    const id = written.observationId;

    const before = rowById(id);
    assert.equal(before.recall_count, 0, 'fixture starts unrecalled');
    assert.equal(before.last_recalled_at, null);

    for (let i = 0; i < 3; i++) getObservation({ observation_id: id });

    const afterFetch = rowById(id);
    assert.equal(afterFetch.recall_count, 0, 'three fetches must not bump recall_count');
    assert.equal(afterFetch.last_recalled_at, null, 'three fetches must not set last_recalled_at');

    // CONTROL: the same row, reached the other way, DOES move — so the
    // assertions above are pinning a real difference and not a dead column.
    await recall({ query: 'Hetzner deploy target', limit: 10, spread: false, format: 'full' });
    const afterRecall = rowById(id);
    assert.ok(
      afterRecall.recall_count > 0,
      'CONTROL: recall must bump recall_count, or the no-write assertions prove nothing'
    );
    assert.ok(afterRecall.last_recalled_at !== null, 'CONTROL: recall must set last_recalled_at');
  });

  test('the response discloses the telemetry it declines to move', async () => {
    const written = await remember({ entity, content: 'Caddy runs as a host systemd service, not a container.' });
    await recall({ query: 'Caddy systemd host service', limit: 10, spread: false, format: 'full' });

    const result = getObservation({ observation_id: written.observationId });
    const row = rowById(written.observationId);
    assert.equal(result.observation!.recall_count, row.recall_count);
    assert.equal(result.observation!.last_recalled_at, row.last_recalled_at);
    assert.match(result.message, /did not change recall_count/);
  });
});

// ---------------------------------------------------------------------------
// Failure shapes: loud, specific, never empty-but-successful
// ---------------------------------------------------------------------------

describe('get_observation fails loudly on an id it cannot resolve', () => {
  test('an unknown id is success:false, not an empty success', () => {
    const result = getObservation({ observation_id: '00000000-0000-4000-8000-000000000000' });
    assert.equal(result.success, false);
    assert.equal(result.observation, undefined);
    assert.match(result.message, /not found/i);
  });

  test('a deleted id reports not-found rather than returning stale content', async () => {
    const written = await remember({
      entity: 'project:fetch-deleted',
      content: 'Rate limiting returns 429 at request 61.',
    });
    assert.equal(getObservation({ observation_id: written.observationId }).success, true);

    forget({ observation_id: written.observationId });

    const after = getObservation({ observation_id: written.observationId });
    assert.equal(after.success, false, 'a forgotten row must not still be readable');
    assert.equal(after.observation, undefined);
  });
});

// ---------------------------------------------------------------------------
// Append-only disclosure — the D10/D11/D12 line, one tool over
// ---------------------------------------------------------------------------

describe('get_observation discloses append-only rows', () => {
  test('append_only is true with a do-not-consolidate message', async () => {
    const written = await remember({
      entity: 'ops:daily-log:hippocampus',
      content: '2026-09-09. Reviewed the read-by-id gap; measured the recall re-read at 272K chars.',
    });

    const result = getObservation({ observation_id: written.observationId });
    assert.equal(result.success, true);
    assert.equal(result.append_only, true);
    assert.match(result.message, /do NOT update, merge or otherwise consolidate/);
    // The content itself is NOT withheld: this tool is called with an id the
    // caller already holds, which is a different shape from `remember` offering
    // an unrequested id beside a consolidation nudge (why near_matches withholds
    // ids on these entities). Reading a log entry is exactly what it is for.
    assert.ok(result.observation!.content.includes('272K chars'), 'content is returned in full');
  });

  test('append_only is present and false on ordinary entities', async () => {
    // Absence must never be the all-clear — the same rule as `replaced: false`
    // (D10) and `degraded: false` (D16). A field that appears only in the
    // dangerous case is indistinguishable from an older server without it.
    const written = await remember({
      entity: 'project:fetch-ordinary',
      content: 'SQLCipher encrypts the whole database, embeddings included.',
    });
    const result = getObservation({ observation_id: written.observationId });
    assert.equal(result.append_only, false);
    assert.ok(Object.hasOwn(result, 'append_only'), 'append_only must be present, not merely falsy');
  });
});

// ---------------------------------------------------------------------------
// The workflow it actually completes — and the boundary it does not move
// ---------------------------------------------------------------------------

describe('get_observation resolves a near-match id end to end', () => {
  test('an id from near_matches reads back the full row the preview truncates', async () => {
    const entity = 'project:fetch-near-match';
    const shared =
      'Structural diagnosis of the deployment path, with the same opening section reused across notes. ';

    const first = await remember({ entity, content: `${shared}The Vercel build bakes NEXT_PUBLIC vars at build time.` });
    backdate(first.observationId, '2026-08-01');

    const second = await remember({
      entity,
      content: `${shared}The Docker image mounts /data as the only writable volume.`,
    });

    const matches = second.near_matches ?? [];
    assert.ok(matches.length > 0, 'PREMISE: the fixture must actually produce a near match');

    // On this branch near_matches still carries full content (the preview cap
    // lives on branch claude/zealous-bhaskara-725771). What is exercised here is
    // the id being a working handle for a bounded read — the property that has
    // to hold whichever side of that cap this lands on.
    const match = matches[0] as { observation_id?: string; content: string };
    const resolvedId = match.observation_id ?? first.observationId;

    const fetched = getObservation({ observation_id: resolvedId });
    assert.equal(fetched.success, true);
    assert.equal(fetched.observation!.observation_id, resolvedId);
    assert.equal(fetched.observation!.content, rowById(resolvedId).content);
    assert.equal(fetched.observation!.entity, entity);
  });

  test('BOUNDARY: reading two 45,000-char rows is possible; merging them is still capped at 50,000', async () => {
    // This is what the fetch does and does not buy, pinned rather than argued.
    // `merge`'s wire schema caps `content` at 50000 (src/mcp/server.ts), the
    // same cap `remember` enforces — so two rows this size cannot be combined
    // without discarding most of the source. The read is now available at any
    // storable size; the merge is not, and no fetch tool changes that.
    const entity = 'raw:research:fetch-boundary';
    const a = await remember({ entity, content: ledgerPart(1) });
    backdate(a.observationId, '2026-08-10');
    const b = await remember({ entity, content: ledgerPart(2) });
    backdate(b.observationId, '2026-08-11');

    const readA = getObservation({ observation_id: a.observationId });
    const readB = getObservation({ observation_id: b.observationId });
    assert.equal(readA.success, true);
    assert.equal(readB.success, true);

    const combined = readA.observation!.content.length + readB.observation!.content.length;
    const MERGE_CONTENT_CAP = 50_000;
    assert.ok(
      combined > MERGE_CONTENT_CAP,
      `CONTROL: the two rows (${combined}) must exceed the merge cap, or this boundary is not being tested`
    );
  });
});
