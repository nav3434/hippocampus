import { getObservationsByIds } from '../../db/observations.js';
import { findEntityById, getEntityVersion } from '../../db/entities.js';
import { isAppendOnlyEntity } from '../../config.js';

export interface GetObservationInput {
  observation_id: string;
}

interface FetchedObservation {
  observation_id: string;
  entity: string;
  entity_type: string | null;
  content: string;
  kind: string | null;
  source: string | null;
  importance: number;
  remembered_at: string;
  /**
   * Access telemetry, returned but NOT written by this tool — see the module
   * doc below. Disclosed precisely because the tool leaves it alone: a caller
   * that cares whether its reads are shaping retrieval can see the number it
   * is not moving.
   */
  recall_count: number;
  last_recalled_at: string | null;
  /** The parent entity's hash, so a fetch can seed the same cache `recall` does. */
  version_hash: string | null;
}

export interface GetObservationResult {
  success: boolean;
  /**
   * Present on EVERY response, `false` on ordinary entities. Same rule as
   * `remember`'s `replaced` and `recall`'s `degraded` (D10, D16): a field that
   * appears only in the dangerous case cannot be told apart from an older
   * server that never had the field, so absence must never be the all-clear.
   */
  append_only: boolean;
  observation?: FetchedObservation;
  message: string;
}

/**
 * Read exactly one observation by its id.
 *
 * The gap this closes: observation ids are handed out by `remember` (as
 * `observationId`), by `recall` with `format: "full"`, and by `export` with
 * `format: "json"` — the other recall/export formats return text blobs with no
 * ids. Both tools that ACCEPT an id destroy rows: `forget` deletes them,
 * `merge` deletes every source and keeps only the text the caller composes.
 * Until now there was no id-taking read, so a caller holding a destruction key
 * had no bounded way to see what it addressed.
 *
 * Bounded by construction, and the bound is on the ROW, not on the response:
 * exactly the one row named, and a row cannot exceed the 50,000-char cap
 * `remember` enforces on write. JSON escaping then inflates that on the wire —
 * measured 1.01x on prose, 1.21x on newline-dense text, and 2.01x on a row of
 * pure quote characters, so the serialized worst case is ~100,000 chars.
 * A real bound, then, but not a small one, and stated as what it is.
 *
 * This is a READ. It does not touch `recall_count` or `last_recalled_at`,
 * following the rule the codebase already keeps: search bumps access telemetry
 * (`recall` alone calls `touchRecalledObservations`), targeted reads by name do
 * not (`context` and `export` never have). A fetch by id is a targeted read.
 */
export function getObservation(input: GetObservationInput): GetObservationResult {
  const [observation] = getObservationsByIds([input.observation_id]);

  if (!observation) {
    // `success: false` with a message, not a throw, and not an empty-but-
    // successful shape. The D13 rule is that an empty answer must never be
    // indistinguishable from "nothing is stored" — here it cannot be: the
    // caller named one specific id and is told that id was not found, which
    // is a definite fact about a definite row rather than a silent filter
    // matching nothing. Mirrors `forget`'s not-found path.
    return {
      success: false,
      append_only: false,
      message: `Observation ${input.observation_id} not found. It may have been deleted, merged into another observation, or the id may be from a different store.`,
    };
  }

  const entity = findEntityById(observation.entity_id);
  if (!entity) {
    // Unreachable in-process: `entity_id` is `REFERENCES entities(id) ON
    // DELETE CASCADE` with `foreign_keys = ON`, so deleting an entity takes
    // its observations with it. It becomes reachable only across connections,
    // because the two SELECTs above are not in one transaction — a second
    // process deleting the entity between them lands here. In THAT case the
    // memory really was deleted, so this message must not assert the opposite;
    // an earlier draft called it a data-integrity problem and would have been
    // wrong in the one situation it can actually occur. Wrapping both reads in
    // a transaction would remove the ambiguity, at the cost of ceremony on a
    // path no in-process caller can reach.
    return {
      success: false,
      append_only: false,
      message: `Observation ${input.observation_id} exists but its entity (${observation.entity_id}) could not be read. Either the entity was deleted between the two reads this call makes, or the rows are inconsistent — this call cannot tell which, and says so rather than guessing.`,
    };
  }

  const appendOnly = isAppendOnlyEntity(entity.name);
  const version = getEntityVersion(entity.name);

  return {
    success: true,
    append_only: appendOnly,
    observation: {
      observation_id: observation.id,
      entity: entity.name,
      entity_type: entity.type,
      content: observation.content,
      kind: observation.kind ?? null,
      source: observation.source,
      importance: observation.importance,
      remembered_at: observation.created_at,
      recall_count: observation.recall_count,
      last_recalled_at: observation.last_recalled_at,
      version_hash: version?.version_hash ?? null,
    },
    message: appendOnly
      ? `Observation from "${entity.name}", which is an append-only entity: its observations are dated records, and overlap between them is the shared format, not redundancy. Read it, but do NOT update, merge or otherwise consolidate it.`
      : `Observation from "${entity.name}". This read did not change recall_count or last_recalled_at.`,
  };
}
