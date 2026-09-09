import { findEntityByName, findEntityById, searchEntities, getEntityVersion } from '../../db/entities.js';
import { getObservationsByEntity, type Observation } from '../../db/observations.js';
import { getRelationshipsByEntity, getRelatedEntities } from '../../db/relationships.js';
import { semanticSearch } from '../../embeddings/embedder.js';

export interface ContextInput {
  topic: string;
  depth?: number;
}

interface EntityContext {
  name: string;
  type: string | null;
  version_hash?: string | null;
  observations: Array<{
    content: string;
    source: string | null;
    remembered_at: string;
    kind: string | null;
  }>;
}

interface RelationshipInfo {
  from: string;
  to: string;
  type: string;
}

export interface ContextResult {
  success: boolean;
  entity?: EntityContext;
  relationships: RelationshipInfo[];
  related_entities: EntityContext[];
  message: string;
}

export async function context(input: ContextInput): Promise<ContextResult> {
  const depth = Math.min(Math.max(input.depth ?? 1, 0), 3);

  // Find entity: exact → LIKE → semantic fallback
  let entity = findEntityByName(input.topic);

  if (!entity) {
    const likeResults = searchEntities(input.topic);
    if (likeResults.length > 0) {
      entity = likeResults[0];
    }
  }

  if (!entity) {
    // Semantic fallback: search for memories about this topic
    // Require minimum similarity to avoid false matches on unrelated queries
    //
    // Deliberately uncaught (D16). This is the LAST leg of exact -> LIKE ->
    // semantic, so unlike `recall` there is never a partial answer to return
    // when it fails: the only other outcome is the `success: false, "No entity
    // found for topic X"` below, which is a false claim if the leg that would
    // have found it never ran. `recall` can honestly degrade because it still
    // has keyword hits; here the degraded answer IS the misleading one.
    const SEMANTIC_THRESHOLD = 0.2;
    // The floor goes INTO the search, not onto the row it returns (D22). This
    // reads only `[0]`, and the search ranks by the boosted composite, so a row
    // under the floor could hold position 0 on its recall count alone and make
    // this branch answer "No entity found" while a qualifying entity sat at
    // [1]. Reproduced on a two-row fixture: raw 0.202 vs 0.143, a recall count
    // of 100 on the lower one, and the topic stopped resolving. Same shape as
    // the `recall` half of D22 and the same one-argument fix; worth stating
    // that it is not merely defensive here, because the loss is total — this is
    // the last leg of exact -> LIKE -> semantic, so a miss is the whole answer.
    const semanticResults = await semanticSearch(input.topic, {
      limit: 5,
      minSimilarity: SEMANTIC_THRESHOLD,
    });
    if (semanticResults.length > 0 && semanticResults[0].similarity >= SEMANTIC_THRESHOLD) {
      entity = findEntityById(semanticResults[0].entity_id) ?? undefined;
    }
  }

  if (!entity) {
    return {
      success: false,
      relationships: [],
      related_entities: [],
      message: `No entity found for topic "${input.topic}".`,
    };
  }

  // Get observations for the main entity
  const observations = getObservationsByEntity(entity.id);
  const version = getEntityVersion(entity.name);
  const entityContext: EntityContext = {
    name: entity.name,
    type: entity.type,
    version_hash: version?.version_hash ?? null,
    observations: observations.map(formatObs),
  };

  // Get direct relationships
  const rels = getRelationshipsByEntity(entity.id);
  const relationships: RelationshipInfo[] = rels.map(r => ({
    from: r.from_name,
    to: r.to_name,
    type: r.relation_type,
  }));

  // Follow relationships via BFS to depth N
  const relatedMap = getRelatedEntities(entity.id, depth);
  const relatedEntities: EntityContext[] = [];

  for (const [relId, info] of relatedMap) {
    const relObs = getObservationsByEntity(relId);
    relatedEntities.push({
      name: info.name,
      type: info.type,
      observations: relObs.map(formatObs),
    });
  }

  return {
    success: true,
    entity: entityContext,
    relationships,
    related_entities: relatedEntities,
    message: `Found "${entity.name}" with ${observations.length} observations, ${relationships.length} relationships, and ${relatedEntities.length} related entities.`,
  };
}

function formatObs(obs: Observation) {
  return {
    content: obs.content,
    source: obs.source,
    remembered_at: obs.created_at,
    kind: obs.kind ?? null,
  };
}
