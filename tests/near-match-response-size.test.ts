/**
 * Regression tests for the near_matches response-size path (D20).
 *
 * `remember` reported overlapping observations by quoting their FULL stored
 * text — up to MAX_NEAR_MATCHES of them, each up to 50,000 chars. Observed live
 * on 2026-09-09 writing a 151,987-char research ledger split across four
 * observations of one entity: part 3 produced a 68,255-char response and part 4
 * a 115,271-char response, both rejected by the MCP client for exceeding its
 * token cap. Both writes had SUCCEEDED — parsing the persisted bodies showed
 * `success: true`, `replaced: false` and a fresh `observationId` each time — but
 * the caller saw only an error string, and the natural remedy for an error is a
 * retry, which double-writes.
 *
 * The fix is previews plus an `observation_id` on every entity. The tests below
 * pin the budget, and each one carries a positive control: a bound that a fixture
 * cannot clear is a test that passes while proving nothing.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-near-match-size-${Date.now()}.db`);

// Must set env before importing project modules (config.ts reads eagerly)
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-near-match-size';
process.env.HIPPO_DB_PATH = DB_PATH;
delete process.env.HIPPO_APPEND_ONLY_PREFIXES; // exercise the shipped defaults

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { merge } = await import('../src/mcp/tools/merge.js');
const { findEntityByName } = await import('../src/db/entities.js');
const { getObservationsByEntity } = await import('../src/db/observations.js');

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

/**
 * The budget a successful `remember` response must stay under, serialized the
 * way the MCP server actually serializes it (`JSON.stringify(result, null, 2)`
 * in src/mcp/server.ts — pretty-printing inflates, so measuring the compact form
 * would understate the real payload).
 *
 * 8 KB is deliberately loose. The point is not to pin the exact size, which will
 * drift with message wording; it is to sit far below both a single fixture
 * observation (~45 KB) and the 115,271-char response actually observed, so the
 * old unbounded shape cannot pass.
 */
const RESPONSE_BUDGET_BYTES = 8192;
const OBSERVATION_CHARS = 45_000;

/** Serialize exactly as the tool handler does. */
function wireSize(result: unknown): number {
  return JSON.stringify(result, null, 2).length;
}

/**
 * Every part shares a header, which is what carries them over the near-match
 * threshold — the same way real harvest entries clear it on a shared skeleton
 * rather than on shared substance. The bulk after it is distinct per part.
 */
function ledgerPart(part: number): string {
  const header =
    'RESEARCH LEDGER — EO market formation, sequel run. Structure: sources, extraction notes, ' +
    'contradictions flagged for review, open threads, and the running confidence table. ' +
    'Each part continues the previous one; numbering is sequential and the format is fixed. ';
  const body = `Part ${part} findings. `;
  return (header + body).padEnd(OBSERVATION_CHARS, `part-${part}-payload `);
}

/** `createObservation` hardcodes datetime('now'), so distinct days need SQL. */
function backdateObservation(observationId: string, day: string): void {
  getDatabase()
    .prepare("UPDATE observations SET created_at = ? || ' 12:00:00' WHERE id = ?")
    .run(day, observationId);
}

function observationsFor(entityName: string) {
  const entity = findEntityByName(entityName);
  assert.ok(entity, `entity ${entityName} should exist`);
  return getObservationsByEntity(entity!.id);
}

describe('a successful remember response stays inside a token budget', () => {
  test('N large overlapping observations do not inflate the response', async () => {
    const entity = 'raw:research:ledger-size';

    // Backdate each prior part to its own day: same-day dedup would otherwise
    // collapse them into one observation, and the test would measure a
    // one-match response while claiming to measure N.
    for (let part = 1; part <= 5; part++) {
      const written = await remember({ entity, content: ledgerPart(part) });
      backdateObservation(written.observationId, `2026-09-0${part}`);
    }
    assert.equal(observationsFor(entity).length, 5, 'all five parts must be stored separately');

    const result = await remember({ entity, content: ledgerPart(6) });

    // Precondition: the report has to actually fire. Without this the budget
    // assertion below passes on an empty near_matches and proves nothing.
    assert.ok(result.near_matches, 'near_matches must be present');
    assert.ok(
      result.near_matches!.length >= 2,
      `fixture must produce multiple overlaps, got ${result.near_matches!.length}`
    );
    assert.equal(result.success, true);
    assert.equal(result.replaced, false, 'nothing may be deleted on this path');

    // Positive control: a SINGLE overlapping observation, at full length, is
    // already over five times the whole budget — so the pre-D20 shape (up to
    // three of these quoted verbatim) could not have passed this assertion.
    const quoted = observationsFor(entity).find(
      o => o.id === result.near_matches![0].observation_id
    );
    assert.ok(quoted, 'observation_id must address a real row');
    assert.ok(
      quoted!.content.length > RESPONSE_BUDGET_BYTES,
      `control: one stored observation (${quoted!.content.length}) must exceed the budget`
    );

    assert.ok(
      wireSize(result) <= RESPONSE_BUDGET_BYTES,
      `response was ${wireSize(result)} bytes, budget is ${RESPONSE_BUDGET_BYTES}`
    );
    for (const match of result.near_matches!) {
      assert.ok(match.content.length <= 201, 'each near match is a preview');
    }
  });

  test('the deduplicated path previews too', async () => {
    // The truncation site sits before the `bestMatch` branch, so the skip and
    // replace returns are covered by the same code. Pinned because a refactor
    // that moved it after the branch would leave these two paths unbounded and
    // every assertion above would still pass.
    const entity = 'raw:research:ledger-dedup';

    const older = await remember({ entity, content: ledgerPart(1) });
    backdateObservation(older.observationId, '2026-09-01');

    const sameDayLong = ledgerPart(2);
    await remember({ entity, content: sameDayLong });
    // Shorter than the same-day observation → the dedup SKIP branch.
    const result = await remember({ entity, content: sameDayLong.slice(0, OBSERVATION_CHARS - 500) });

    assert.equal(result.deduplicated, true, 'must be on the skip path');
    assert.ok(result.near_matches?.length, 'the out-of-day overlap must still be reported');
    for (const match of result.near_matches!) {
      assert.ok(match.content.length <= 201, 'each near match is a preview');
    }
    assert.ok(
      wireSize(result) <= RESPONSE_BUDGET_BYTES,
      `deduplicated response was ${wireSize(result)} bytes`
    );
  });
});

describe('observation_id is the handle the preview replaces', () => {
  test('a reported near match can still be consolidated, by id', async () => {
    // The capability the full text used to provide. `merge` takes ids and
    // requires at least two of them — satisfied by this response's own
    // `observationId` plus the near match's, with no new tool and no need for
    // the stored text. This is the conformance evidence for "previews are not
    // lossy off the log entities".
    const entity = 'project:consolidate-by-id';

    const older = await remember({ entity, content: ledgerPart(1) });
    backdateObservation(older.observationId, '2026-09-01');

    const written = await remember({ entity, content: ledgerPart(2) });
    const target = written.near_matches?.[0];
    assert.ok(target?.observation_id, 'a non-append-only near match must carry its id');
    assert.notEqual(
      target!.observation_id,
      written.observationId,
      'the two handles must be distinct observations'
    );

    const merged = await merge({
      observation_ids: [written.observationId, target!.observation_id!],
      content: 'Consolidated EO market formation ledger, parts 1-2.',
    });

    assert.equal(merged.success, true);
    assert.equal(merged.merged_count, 2);

    const remaining = observationsFor(entity);
    assert.equal(remaining.length, 1, 'both sources must be gone');
    assert.equal(remaining[0].id, merged.new_observation_id);
  });

  test('append-only entities are handed no id at all', async () => {
    // Negative control for the D10 hazard. An observation_id is a `forget` and
    // `merge` key, so returning one on a log entity would re-open invited
    // deletion in a shorter string than the content preview closed. Without
    // this test, a refactor that adds the id unconditionally regresses D10
    // silently — every other assertion in this file would still pass.
    const entity = 'ops:daily-log:size-check';

    const older = await remember({ entity, content: ledgerPart(1) });
    backdateObservation(older.observationId, '2026-09-01');

    const result = await remember({ entity, content: ledgerPart(2) });

    assert.equal(result.append_only, true, 'fixture must be on the append-only path');
    assert.ok(result.near_matches?.length, 'the overlap must still be reported');
    for (const match of result.near_matches!) {
      assert.equal(match.observation_id, undefined, 'no delete key on a log entity');
      assert.ok(match.content.length <= 201, 'preview only');
    }
    assert.match(result.message, /Do NOT consolidate/);
    assert.equal(observationsFor(entity).length, 2, 'both entries survive');
  });
});
