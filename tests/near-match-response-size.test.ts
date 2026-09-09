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
 * The budget covers the OVERLAP report, not the DESTRUCTION report.
 *
 * `replaced_observation` and `replaced_observations` quote rows that have been
 * deleted, so the response is their only copy and capping them would defeat the
 * recoverability they exist for. They are deliberately uncapped, which means a
 * `replaced: true` response can legitimately be large — that is not the defect
 * D20 fixes, and the mitigation there is the persisted-body check in CLAUDE.md,
 * not a smaller payload. Strip them before measuring, or this asserts the
 * opposite of the decision.
 */
function wireSizeOfOverlapReport(result: Record<string, unknown>): number {
  const { replaced_observation, replaced_observations, ...rest } = result;
  void replaced_observation;
  void replaced_observations;
  return wireSize(rest);
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

/**
 * Every previewed near match, plus the control that keeps the assertion honest:
 * the row the id addresses must be big enough that echoing it would have blown
 * the budget. Without it a fixture shrunk below 201 chars passes while proving
 * nothing — the vacuous-guard failure this repo has already had three times.
 */
function assertPreviewedAndControlled(
  result: { near_matches?: Array<{ content: string; observation_id?: string }> },
  entityName: string
): void {
  const stored = observationsFor(entityName);
  for (const match of result.near_matches ?? []) {
    assert.ok(match.content.length <= 201, 'each near match is a preview');
    const row = stored.find(o => o.id === match.observation_id);
    assert.ok(row, 'observation_id must address a real row');
    assert.ok(
      row!.content.length > RESPONSE_BUDGET_BYTES,
      `control: the quoted row (${row!.content.length}) must exceed the budget`
    );
  }
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
    assertPreviewedAndControlled(result, entity);
    assert.ok(
      wireSize(result) <= RESPONSE_BUDGET_BYTES,
      `deduplicated response was ${wireSize(result)} bytes`
    );
  });

  test('the replaced path previews too', async () => {
    // The third return, and the one no assertion reached before: re-pointing
    // ONLY this branch back at the uncapped array left all 340 tests green
    // while the response went to ~90KB, with a 45,000-char near match in it.
    // The replace branch is also the one that just DELETED something, so it is
    // the worst place to lose the bound.
    const entity = 'raw:research:ledger-replace';

    const older = await remember({ entity, content: ledgerPart(1) });
    backdateObservation(older.observationId, '2026-09-01');

    // Same day, and shorter than what follows → the dedup REPLACE branch.
    const victim = ledgerPart(2).slice(0, OBSERVATION_CHARS - 500);
    await remember({ entity, content: victim });
    const result = await remember({ entity, content: ledgerPart(2) });

    assert.equal(result.replaced, true, 'must be on the replace path');
    assert.ok(result.near_matches?.length, 'the out-of-day overlap must still be reported');
    assertPreviewedAndControlled(result, entity);
    const overlapBytes = wireSizeOfOverlapReport(result as unknown as Record<string, unknown>);
    assert.ok(
      overlapBytes <= RESPONSE_BUDGET_BYTES,
      `replaced response's overlap report was ${overlapBytes} bytes`
    );

    // Criterion 4, and the asymmetry stated as an assertion rather than a
    // comment: the DESTRUCTION disclosure is NOT capped, so the full response
    // is legitimately over the budget while the overlap report inside it is
    // not. If a later change ever caps replaced_observation, this fails and
    // sends the reader to the decision rather than to a mystery.
    assert.equal(result.replaced_observation, victim, 'the evicted text stays whole');
    assert.ok(
      wireSize(result) > RESPONSE_BUDGET_BYTES,
      'the uncapped destruction disclosure is what makes this response large'
    );
  });
});

describe('every path that attaches near_matches says it is a preview', () => {
  test('the no-match, deduplicated and replaced messages all disclose it', async () => {
    // The field used to hold the full stored text. A caller that cannot tell it
    // now holds a truncated one will compose a replacement from it and destroy
    // the remainder — so the disclosure has to ride on all three returns, not
    // just the one where it was easiest to add. Nothing else in this file
    // asserts the message wording, so without this the whole clause could be
    // deleted with the suite still green.
    // One entity per path. Sharing one would make the paths interfere: every
    // ledgerPart is padded to the same length, so a same-day sibling left over
    // from the previous step becomes the best match at equal length and sends
    // the write down the SKIP branch instead of the replace branch.
    const seed = async (entity: string) => {
      const older = await remember({ entity, content: ledgerPart(1) });
      backdateObservation(older.observationId, '2026-09-01');
    };

    await seed('raw:research:disclosure-nomatch');
    const noMatch = await remember({ entity: 'raw:research:disclosure-nomatch', content: ledgerPart(2) });
    assert.ok(noMatch.near_matches?.length);
    assert.equal(noMatch.replaced, false);
    assert.match(noMatch.message, /PREVIEW, not the stored text/);
    // It must NOT hand over a copy-pasteable merge recipe: this message fires on
    // every overlap >= 0.5 whatever the novelty, and `merge` keeps only the
    // content it is given, which this response no longer carries.
    assert.doesNotMatch(noMatch.message, /merge\(/);

    await seed('raw:research:disclosure-replaced');
    const victim = ledgerPart(2).slice(0, OBSERVATION_CHARS - 500);
    await remember({ entity: 'raw:research:disclosure-replaced', content: victim });
    const replaced = await remember({ entity: 'raw:research:disclosure-replaced', content: ledgerPart(2) });
    assert.equal(replaced.replaced, true, 'fixture must reach the replace branch');
    assert.ok(replaced.near_matches?.length);
    assert.match(replaced.message, /preview, not the stored text/);

    await seed('raw:research:disclosure-deduped');
    await remember({ entity: 'raw:research:disclosure-deduped', content: ledgerPart(2) });
    const deduped = await remember({
      entity: 'raw:research:disclosure-deduped',
      content: ledgerPart(2).slice(0, OBSERVATION_CHARS - 500),
    });
    assert.equal(deduped.deduplicated, true, 'fixture must reach the skip branch');
    assert.ok(deduped.near_matches?.length);
    assert.match(deduped.message, /preview, not the stored text/);
  });
});

describe('observation_id is the handle the preview replaces', () => {
  test('a reported near match can still be consolidated, by id', async () => {
    // The capability the full text used to provide: `merge` requires at least
    // two ids, satisfied by this response's own `observationId` plus the near
    // match's, with no new tool.
    //
    // What this proves is the MECHANICS — the two handles address distinct real
    // rows and `merge` accepts them. It is deliberately not a safety claim.
    // `merge` keeps only the `content` passed to it, so a caller that composed
    // that text from the 200-char preview would destroy the rest, which is why
    // `onboard` step 4 makes re-reading the near match step 1 and merging step
    // 2. The id is the handle; it is not, on its own, the workflow.
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
