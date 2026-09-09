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
 * The gap this closes: observation ids are handed out by `remember`
 * (`observationId`), `recall` (`observation_id`), `export`, and — since the
 * near-match preview cap on branch `claude/zealous-bhaskara-725771` — by
 * `remember`'s `near_matches`, where the id sits beside a 200-char preview of
 * a row that may be 50,000 chars long. Both tools that ACCEPT an id destroy
 * rows: `forget` deletes them, `merge` deletes every source and keeps only the
 * text the caller composes. Until now there was no id-taking read, so a caller
 * holding a destruction key had no bounded way to see what it addressed.
 *
 * Bounded by construction: exactly the one row named, and a row can never
 * exceed the 50,000-char cap `remember` and `merge` both enforce at the wire
 * boundary. That is a real bound but a modest one — roughly 12,500 tokens, not
 * "small". It is the floor for seeing that content at all, which is the claim
 * being made, and nothing more.
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
    // An observation whose entity row is gone is a broken invariant, not a
    // miss. Say which, rather than reporting it as a plain not-found and
    // sending the caller to look for a deletion that never happened.
    return {
      success: false,
      append_only: false,
      message: `Observation ${input.observation_id} exists but its entity (${observation.entity_id}) is missing. This is a data integrity problem, not a deleted memory.`,
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
