/**
 * @fileoverview Deterministically partitions frozen evidence for bounded parallel Luna analysis.
 *
 * @custody
 * - Owns: disjoint change assignment, evidence-byte balancing, shard-local context, and deterministic report IDs.
 * - Does not own: model invocation, schema validation, full-snapshot coverage authority, or commit creation.
 * @invariants
 * - Every full-packet manifest ID appears in exactly one shard.
 * - Detailed patch evidence never appears in a shard that does not own its change ID.
 * - One-shard and multi-shard snapshots use the same packet and merge path.
 * @failure
 * Invalid packet relationships fail before a model is called.
 * @proof
 * `npm test`
 */

import { AutomaticCommitError } from './git-snapshot.js';

const MAXIMUM_LUNA_SHARDS = 4;
const TARGET_CHANGES_PER_SHARD = 8;
const TARGET_EVIDENCE_BYTES_PER_SHARD = 120_000;
const MAXIMUM_MERGED_WORKSTREAMS = 50;

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function selectShardCount(packet) {
  const changeCount = packet.manifest.length;
  if (changeCount <= 1) return changeCount;
  const detailedEvidenceBytes = byteLength(packet.patches);
  const byChangeCount = Math.ceil(changeCount / TARGET_CHANGES_PER_SHARD);
  const byEvidenceBytes = Math.ceil(detailedEvidenceBytes / TARGET_EVIDENCE_BYTES_PER_SHARD);
  return Math.min(changeCount, MAXIMUM_LUNA_SHARDS, Math.max(1, byChangeCount, byEvidenceBytes));
}

function buildChangeWeights(packet) {
  const patchBytesByChangeId = new Map(packet.patches.map((patch) => [patch.changeId, byteLength(patch)]));
  return new Map(packet.manifest.map((change) => [
    change.id,
    Math.max(1_024, patchBytesByChangeId.get(change.id) || Math.min(120_000, change.blobSize || change.oldBlobSize || 0)),
  ]));
}

function assignChangesToShards(packet, shardCount) {
  const weights = buildChangeWeights(packet);
  const manifestOrder = new Map(packet.manifest.map((change, index) => [change.id, index]));
  const bins = Array.from({ length: shardCount }, (_, index) => ({ index, weight: 0, changes: [] }));
  const largestFirst = [...packet.manifest].sort((left, right) => (
    weights.get(right.id) - weights.get(left.id)
    || manifestOrder.get(left.id) - manifestOrder.get(right.id)
  ));
  for (const change of largestFirst) {
    bins.sort((left, right) => left.weight - right.weight || left.index - right.index);
    bins[0].changes.push(change);
    bins[0].weight += weights.get(change.id);
  }
  return bins
    .sort((left, right) => left.index - right.index)
    .map((bin) => ({
      ...bin,
      changes: bin.changes.sort((left, right) => manifestOrder.get(left.id) - manifestOrder.get(right.id)),
    }));
}

function intersectsAssignedChanges(item, assignedChangeIds) {
  return item.relatedChangeIds?.some((changeId) => assignedChangeIds.has(changeId));
}

function compactManifestOverview(manifest) {
  return manifest.map((change) => ({
    id: change.id,
    status: change.status,
    oldPath: change.oldPath,
    path: change.path,
    metadataOnly: change.metadataOnly,
  }));
}

export function createLunaShardPackets(packet) {
  if (!Array.isArray(packet.manifest) || packet.manifest.length === 0 || !Array.isArray(packet.patches)) {
    throw new AutomaticCommitError('INVALID_EVIDENCE_PACKET', 'Luna sharding requires a non-empty manifest and structured patches.');
  }
  const shardCount = selectShardCount(packet);
  const unmappedRequiredWorkSpec = packet.workSpecCandidates.find((candidate) => (
    candidate.required
    && (!Array.isArray(candidate.relatedChangeIds) || candidate.relatedChangeIds.length === 0)
  ));
  if (unmappedRequiredWorkSpec) {
    throw new AutomaticCommitError(
      'INVALID_EVIDENCE_PACKET',
      `Required work spec ${unmappedRequiredWorkSpec.path} is not associated with a manifest change.`,
    );
  }
  const assignments = assignChangesToShards(packet, shardCount);
  const allChangeIds = new Set(packet.manifest.map((change) => change.id));
  const assignedChangeIds = assignments.flatMap((assignment) => assignment.changes.map((change) => change.id));
  if (assignedChangeIds.length !== allChangeIds.size || new Set(assignedChangeIds).size !== allChangeIds.size) {
    throw new AutomaticCommitError('INVALID_EVIDENCE_SHARDS', 'Luna shard assignment did not cover the manifest exactly once.');
  }

  const manifestOverview = compactManifestOverview(packet.manifest);
  return assignments.map((assignment, index) => {
    const shardChangeIds = new Set(assignment.changes.map((change) => change.id));
    const workSpecCandidates = packet.workSpecCandidates.filter((candidate) => (
      intersectsAssignedChanges(candidate, shardChangeIds)
    ));
    return {
      ...packet,
      manifest: assignment.changes,
      manifestOverview,
      patches: packet.patches.filter((patch) => shardChangeIds.has(patch.changeId)),
      applicableAgentContracts: packet.applicableAgentContracts.filter((contract) => (
        intersectsAssignedChanges(contract, shardChangeIds)
      )),
      workSpecCandidates,
      requiredWorkSpecPaths: workSpecCandidates
        .filter((candidate) => candidate.required)
        .map((candidate) => candidate.path),
      shard: {
        index: index + 1,
        count: shardCount,
        assignedChangeIds: [...shardChangeIds],
        estimatedEvidenceBytes: assignment.weight,
      },
    };
  });
}

export function mergeLunaShardReports({ packet, shardReports }) {
  if (!Array.isArray(shardReports) || shardReports.length === 0) {
    throw new AutomaticCommitError('INVALID_MODEL_OUTPUT', 'Luna returned no shard reports.');
  }
  const workstreams = shardReports.flatMap((report, shardIndex) => report.workstreams.map((workstream, streamIndex) => {
    const {
      userJourneyCandidate,
      developerJourneyCandidate,
      engineeringUnlockCandidate,
      ...sharedWorkstream
    } = workstream;
    return {
      ...sharedWorkstream,
      id: `shard-${String(shardIndex + 1).padStart(2, '0')}-stream-${String(streamIndex + 1).padStart(2, '0')}`,
      valueCandidates: [
        userJourneyCandidate && { kind: 'user_journey', text: userJourneyCandidate },
        developerJourneyCandidate && { kind: 'developer_journey', text: developerJourneyCandidate },
        engineeringUnlockCandidate && { kind: 'engineering_unlock', text: engineeringUnlockCandidate },
      ].filter(Boolean),
    };
  }));
  if (workstreams.length > MAXIMUM_MERGED_WORKSTREAMS) {
    throw new AutomaticCommitError(
      'INVALID_MODEL_OUTPUT',
      `Merged Luna report contains ${workstreams.length} workstreams; maximum is ${MAXIMUM_MERGED_WORKSTREAMS}.`,
    );
  }
  return {
    snapshotId: packet.snapshotId,
    workstreams,
  };
}
