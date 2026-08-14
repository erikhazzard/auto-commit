/**
 * @fileoverview Builds bounded, immutable evidence packets from a frozen Git index.
 *
 * @custody
 * - Owns: changed-path manifests, secret/size gates, applicable agent context, and work-spec discovery.
 * - Does not own: live-worktree staging, model prompting, message validation, or commit creation.
 * @intent
 * Give both models complete snapshot evidence without silently truncating large or binary inputs.
 * @invariants
 * - Every manifest row comes from one or more entries in the captured base plus frozen index.
 * - Secrets are checked before repository content reaches either model.
 * - Direct/owning work specs are mandatory; broad exact-reference matches are bounded suggestions.
 */

import crypto from 'node:crypto';
import path from 'node:path';

import {
  AutomaticCommitError,
  runGitCommand,
  runProcess,
} from './git-snapshot.js';

const TARGET_EVIDENCE_ENTRIES = 160;
const TARGET_EVIDENCE_MANIFEST_BYTES = 160_000;
const MIN_DELETED_PATH_GROUP_ENTRIES = 20;
const MAX_PATH_GROUP_SAMPLES = 6;
const LFS_ATTRIBUTE_PATH_BATCH_SIZE = 500;
const MAX_RAW_MANIFEST_BYTES = 128 * 1024 * 1024;
const MAX_PER_FILE_DIFF_BYTES = 2_000_000;
const MAX_PATCH_CONTEXT_BYTES = 300_000;
const MAX_DIFF_STAT_CONTEXT_BYTES = 32_000;
const MAX_NON_LFS_BLOB_BYTES = 10 * 1024 * 1024;
const MAX_SECRET_SCAN_BATCH_BYTES = 16 * 1024 * 1024;
const MAX_CONTEXT_DOCUMENT_BYTES = 48_000;
const MAX_AGENT_CONTRACT_CONTEXT_BYTES = 64_000;
const MAX_WORK_SPEC_CONTEXT_BYTES = 96_000;
const MAX_REQUIRED_WORK_SPECS = 200;
const MAX_RELATED_WORK_SPEC_SUGGESTIONS = 30;

const BINARY_FILE_EXTENSION_PATTERN = /\.(?:avif|bin|blend|bmp|br|bz2|dae|fbx|flac|gif|glb|gltfpack|gz|ico|jpeg|jpg|ktx2|m4a|mp3|mp4|ogg|otf|pdf|png|tar|ttf|wav|webm|webp|woff2?|zip)$/i;
const DEPENDENCY_LOCKFILE_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'deno.lock',
  'flake.lock',
  'gemfile.lock',
  'go.sum',
  'mix.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'package.resolved',
  'packages.lock.json',
  'paket.lock',
  'pipfile.lock',
  'pnpm-lock.yaml',
  'podfile.lock',
  'poetry.lock',
  'pubspec.lock',
  'uv.lock',
  'yarn.lock',
]);
const SECRET_PATTERNS = Object.freeze([
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
]);

function hashBuffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function decodeUtf8Head(buffer) {
  return buffer.toString('utf8').replace(/\uFFFD$/u, '');
}

function decodeUtf8Tail(buffer) {
  return buffer.toString('utf8').replace(/^\uFFFD/u, '');
}

function splitNullTerminated(buffer) {
  const values = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    values.push(buffer.subarray(start, index).toString('utf8'));
    start = index + 1;
  }
  if (start < buffer.length) values.push(buffer.subarray(start).toString('utf8'));
  return values.filter((value) => value.length > 0);
}

function parseRawChanges(buffer) {
  const tokens = splitNullTerminated(buffer);
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index];
    index += 1;
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])(\d*)$/.exec(header);
    if (!match || index >= tokens.length) {
      throw new AutomaticCommitError('INVALID_GIT_OUTPUT', 'Could not parse git diff --raw output.');
    }
    const firstPath = tokens[index];
    index += 1;
    const renameOrCopy = match[5] === 'R' || match[5] === 'C';
    const nextPath = renameOrCopy ? tokens[index] : firstPath;
    if (renameOrCopy) index += 1;
    changes.push({
      id: `change-${String(changes.length + 1).padStart(3, '0')}`,
      status: match[5] + match[6],
      oldPath: renameOrCopy ? firstPath : (match[5] === 'A' ? null : firstPath),
      path: nextPath,
      oldMode: match[1],
      newMode: match[2],
      oldOid: match[3],
      newOid: match[4],
    });
  }
  return changes;
}

async function readBlobSizes({ repoRoot, oids, env, signal }) {
  const uniqueOids = [...new Set(oids.filter((oid) => !/^0+$/.test(oid)))];
  if (uniqueOids.length === 0) return new Map();
  const result = await runProcess({
    command: 'git',
    args: ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    cwd: repoRoot,
    env,
    input: `${uniqueOids.join('\n')}\n`,
    timeoutMs: 120_000,
    maximumStdoutBytes: Math.max(1_048_576, uniqueOids.length * 160),
    signal,
  });
  if (result.code !== 0) {
    throw new AutomaticCommitError('GIT_COMMAND_FAILED', `git cat-file failed: ${result.stderr.toString('utf8').trim()}`);
  }
  const sizes = new Map();
  for (const line of result.stdout.toString('utf8').trim().split('\n')) {
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(line);
    if (!match) throw new AutomaticCommitError('INVALID_GIT_OUTPUT', `Unexpected git cat-file row: ${line}`);
    sizes.set(match[1], Number.parseInt(match[2], 10));
  }
  return sizes;
}

async function readLfsTrackedPaths({ repoRoot, changedPaths, env, signal }) {
  if (changedPaths.length === 0) return new Set();
  const lfsPaths = new Set();
  for (let start = 0; start < changedPaths.length; start += LFS_ATTRIBUTE_PATH_BATCH_SIZE) {
    const result = await runGitCommand({
      repoRoot,
      args: [
        'check-attr', '--cached', '-z', 'filter', '--',
        ...changedPaths.slice(start, start + LFS_ATTRIBUTE_PATH_BATCH_SIZE),
      ],
      env,
      signal,
    });
    const values = splitNullTerminated(result.stdout);
    for (let index = 0; index + 2 < values.length; index += 3) {
      if (values[index + 1] === 'filter' && values[index + 2] === 'lfs') lfsPaths.add(values[index]);
    }
  }
  return lfsPaths;
}

function assertSafeChangedPathsAndBlobs({ changes, blobSizes, stageMap, lfsTrackedPaths }) {
  for (const change of changes) {
    for (const changedPath of [change.oldPath, change.path].filter(Boolean)) {
      if (changedPath.includes('\uFFFD')) {
        throw new AutomaticCommitError('UNSUPPORTED_PATH_ENCODING', 'A changed path is not valid UTF-8.');
      }
      const basename = path.posix.basename(changedPath).toLowerCase();
      const unsafeEnvironmentFile = basename === '.env' || (
        basename.startsWith('.env.') && !/\.(?:example|sample|template)$/.test(basename)
      );
      if (unsafeEnvironmentFile || /^(?:id_rsa|id_ed25519|credentials|secrets?\.json)$/i.test(basename)) {
        throw new AutomaticCommitError('SENSITIVE_PATH', `Refusing sensitive-looking path: ${changedPath}`);
      }
      if (changedPath.startsWith('.codex/skills/') || changedPath.startsWith('.claude/skills/')) {
        throw new AutomaticCommitError('MATERIALIZED_SKILL_PATH', `Refusing staged skill-symlink child: ${changedPath}`);
      }
    }
    if (change.oldMode === '160000' || change.newMode === '160000') {
      throw new AutomaticCommitError('GITLINK_CHANGE', `Refusing automatic gitlink/submodule change: ${change.path}`);
    }
    const blobSize = blobSizes.get(change.newOid) || 0;
    if (blobSize > MAX_NON_LFS_BLOB_BYTES && !lfsTrackedPaths.has(change.path)) {
      throw new AutomaticCommitError(
        'OVERSIZED_BLOB',
        `Refusing ${change.path}: staged blob is ${blobSize} bytes, above ${MAX_NON_LFS_BLOB_BYTES}.`,
      );
    }
  }
  for (const protectedSymlinkPath of ['.codex/skills', '.claude/skills']) {
    const row = stageMap.get(protectedSymlinkPath);
    if (row && row.mode !== '120000') {
      throw new AutomaticCommitError('MATERIALIZED_SKILL_PATH', `${protectedSymlinkPath} must remain a mode-120000 symlink.`);
    }
  }
}

function isDependencyLockfile(filePath) {
  return DEPENDENCY_LOCKFILE_NAMES.has(path.posix.basename(filePath).toLowerCase());
}

function collectPopulatedDirectories(stageMap) {
  const populatedDirectories = new Set();
  for (const stagedPath of stageMap.keys()) {
    for (let directory = path.posix.dirname(stagedPath); directory !== '.' && directory !== '/';) {
      populatedDirectories.add(directory);
      const parent = path.posix.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return populatedDirectories;
}

function findRemovedSubtreeRoot(filePath, populatedDirectories) {
  let removedRoot = null;
  for (let directory = path.posix.dirname(filePath); directory !== '.' && directory !== '/';) {
    if (populatedDirectories.has(directory)) break;
    removedRoot = directory;
    const parent = path.posix.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return removedRoot;
}

function selectBoundarySamples(values, maximumItems) {
  if (values.length <= maximumItems) return values;
  const headCount = Math.ceil(maximumItems / 2);
  const tailCount = Math.floor(maximumItems / 2);
  return [...values.slice(0, headCount), ...values.slice(-tailCount)];
}

function summarizeFileTypes(filePaths) {
  const counts = new Map();
  for (const filePath of filePaths) {
    const extension = path.posix.extname(filePath).toLowerCase() || '[no extension]';
    counts.set(extension, (counts.get(extension) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([type, count]) => ({ type, count }));
}

function summarizeStatuses(changes) {
  const counts = new Map();
  for (const change of changes) counts.set(change.status, (counts.get(change.status) || 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([status, count]) => ({ status, count }));
}

function createPathGroupUnit({ members, groupPath, kind, evidenceDisposition, blobSizes, orderByChangeId }) {
  const sortedMembers = [...members].sort((left, right) => orderByChangeId.get(left.id) - orderByChangeId.get(right.id));
  const memberPaths = [...new Set(sortedMembers.flatMap((member) => [member.oldPath, member.path]).filter(Boolean))].sort();
  const statuses = summarizeStatuses(sortedMembers);
  return {
    id: sortedMembers[0].id,
    kind,
    status: statuses.length === 1 ? statuses[0].status : 'mixed',
    statusCounts: statuses,
    path: groupPath,
    entryCount: sortedMembers.length,
    samplePaths: selectBoundarySamples(memberPaths, MAX_PATH_GROUP_SAMPLES),
    fileTypes: summarizeFileTypes(memberPaths),
    pathsSha256: hashBuffer(Buffer.from(sortedMembers
      .map((member) => `${member.status}\0${member.oldPath || ''}\0${member.path}`)
      .join('\0'))),
    oldBlobSize: sortedMembers.reduce((total, member) => total + (blobSizes.get(member.oldOid) || 0), 0),
    blobSize: sortedMembers.reduce((total, member) => total + (blobSizes.get(member.newOid) || 0), 0),
    metadataOnly: true,
    evidenceDisposition,
    _members: sortedMembers,
    _order: orderByChangeId.get(sortedMembers[0].id),
  };
}

function pathDepth(filePath) {
  return filePath.split('/').filter(Boolean).length;
}

function serializedEvidenceUnitsBytes(units) {
  return Buffer.byteLength(JSON.stringify(units.map(({ _members, _order, ...unit }) => unit)));
}

function compactEvidenceUnits(units, { blobSizes, orderByChangeId }) {
  let compactedUnits = units;
  while (
    compactedUnits.length > TARGET_EVIDENCE_ENTRIES
    || serializedEvidenceUnitsBytes(compactedUnits) > TARGET_EVIDENCE_MANIFEST_BYTES
  ) {
    const manifestBytes = serializedEvidenceUnitsBytes(compactedUnits);
    const byteBoundEntryTarget = manifestBytes > TARGET_EVIDENCE_MANIFEST_BYTES
      ? Math.max(1, Math.floor(compactedUnits.length * TARGET_EVIDENCE_MANIFEST_BYTES / manifestBytes))
      : compactedUnits.length;
    const entryTarget = Math.min(TARGET_EVIDENCE_ENTRIES, byteBoundEntryTarget);
    const candidatesByDirectory = new Map();
    for (const unit of compactedUnits) {
      for (let directory = path.posix.dirname(unit.path); directory !== '.' && directory !== '/';) {
        if (!candidatesByDirectory.has(directory)) candidatesByDirectory.set(directory, []);
        candidatesByDirectory.get(directory).push(unit);
        const parent = path.posix.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    const candidates = [...candidatesByDirectory]
      .filter(([, members]) => members.length >= 2)
      .sort((left, right) => (
        pathDepth(right[0]) - pathDepth(left[0])
        || right[1].length - left[1].length
        || left[0].localeCompare(right[0])
      ));
    const selectedUnits = new Set();
    const groupedUnits = [];
    let projectedCount = compactedUnits.length;
    for (const [directory, candidateUnits] of candidates) {
      const availableUnits = candidateUnits.filter((unit) => !selectedUnits.has(unit));
      if (availableUnits.length < 2) continue;
      for (const unit of availableUnits) selectedUnits.add(unit);
      groupedUnits.push(createPathGroupUnit({
        members: availableUnits.flatMap((unit) => unit._members),
        groupPath: directory,
        kind: 'changed_path_group',
        evidenceDisposition: 'adaptive-path-summary',
        blobSizes,
        orderByChangeId,
      }));
      projectedCount -= availableUnits.length - 1;
      if (projectedCount <= entryTarget) break;
    }

    if (groupedUnits.length === 0) {
      if (compactedUnits.length === 1) break;
      const unitsToCollapse = compactedUnits.length - entryTarget + 1;
      const fallbackUnits = compactedUnits.slice(0, unitsToCollapse);
      for (const unit of fallbackUnits) selectedUnits.add(unit);
      groupedUnits.push(createPathGroupUnit({
        members: fallbackUnits.flatMap((unit) => unit._members),
        groupPath: '.',
        kind: 'changed_path_group',
        evidenceDisposition: 'adaptive-path-summary',
        blobSizes,
        orderByChangeId,
      }));
    }
    compactedUnits = [
      ...compactedUnits.filter((unit) => !selectedUnits.has(unit)),
      ...groupedUnits,
    ].sort((left, right) => left._order - right._order);
  }
  return compactedUnits;
}

function buildEvidenceManifest({ changes, blobSizes, stageMap }) {
  const orderByChangeId = new Map(changes.map((change, index) => [change.id, index]));
  const populatedDirectories = collectPopulatedDirectories(stageMap);
  const deletedMembersByRoot = new Map();
  for (const change of changes) {
    if (change.status !== 'D') continue;
    const removedRoot = findRemovedSubtreeRoot(change.path, populatedDirectories);
    if (!removedRoot) continue;
    if (!deletedMembersByRoot.has(removedRoot)) deletedMembersByRoot.set(removedRoot, []);
    deletedMembersByRoot.get(removedRoot).push(change);
  }
  const retainedDeletedGroups = new Map([...deletedMembersByRoot]
    .filter(([, members]) => members.length >= MIN_DELETED_PATH_GROUP_ENTRIES));
  const deletedGroupByChangeId = new Map();
  for (const [removedRoot, members] of retainedDeletedGroups) {
    for (const member of members) deletedGroupByChangeId.set(member.id, removedRoot);
  }

  const evidenceUnits = [];
  const emittedDeletedGroups = new Set();
  let dependencyLockfileCount = 0;
  let summarizedDeletionCount = 0;
  for (const change of changes) {
    const deletedGroupRoot = deletedGroupByChangeId.get(change.id);
    if (deletedGroupRoot) {
      const members = retainedDeletedGroups.get(deletedGroupRoot);
      if (emittedDeletedGroups.has(deletedGroupRoot)) continue;
      emittedDeletedGroups.add(deletedGroupRoot);
      summarizedDeletionCount += members.length;
      evidenceUnits.push(createPathGroupUnit({
        members,
        groupPath: deletedGroupRoot,
        kind: 'deleted_path_group',
        evidenceDisposition: 'deleted-subtree-summary',
        blobSizes,
        orderByChangeId,
      }));
      continue;
    }

    const oldBlobSize = blobSizes.get(change.oldOid) || 0;
    const blobSize = blobSizes.get(change.newOid) || 0;
    const dependencyLockfile = isDependencyLockfile(change.path)
      || (change.oldPath ? isDependencyLockfile(change.oldPath) : false);
    const binaryFile = BINARY_FILE_EXTENSION_PATTERN.test(change.path)
      || (change.oldPath ? BINARY_FILE_EXTENSION_PATTERN.test(change.oldPath) : false);
    const oversizedFile = Math.max(oldBlobSize, blobSize) > 512_000;
    if (dependencyLockfile) dependencyLockfileCount += 1;
    const manifestEntry = {
      ...change,
      oldBlobSize,
      blobSize,
      metadataOnly: dependencyLockfile || binaryFile || oversizedFile,
    };
    if (dependencyLockfile) manifestEntry.evidenceDisposition = 'dependency-lockfile';
    else if (binaryFile) manifestEntry.evidenceDisposition = 'binary-or-media';
    else if (oversizedFile) manifestEntry.evidenceDisposition = 'oversized-content';
    evidenceUnits.push({
      ...manifestEntry,
      _members: [change],
      _order: orderByChangeId.get(change.id),
    });
  }

  const compactedUnits = compactEvidenceUnits(evidenceUnits, { blobSizes, orderByChangeId });
  const evidenceIdByRawChangeId = new Map();
  for (const unit of compactedUnits) {
    for (const member of unit._members) evidenceIdByRawChangeId.set(member.id, unit.id);
  }
  const metadataOnlyEvidenceIds = new Set(compactedUnits
    .filter((unit) => unit.metadataOnly)
    .map((unit) => unit.id));
  const metadataOnlyChanges = changes
    .filter((change) => metadataOnlyEvidenceIds.has(evidenceIdByRawChangeId.get(change.id)))
    .map((change) => ({ ...change, metadataOnly: true }));
  const manifest = compactedUnits.map(({ _members, _order, ...unit }) => unit);
  const adaptiveGroups = manifest.filter((unit) => unit.kind === 'changed_path_group');
  return {
    manifest,
    evidenceIdByRawChangeId,
    metadataOnlyChanges,
    summary: {
      dependencyLockfileCount,
      summarizedDeletionCount,
      summarizedDeletionGroupCount: retainedDeletedGroups.size,
      adaptiveGroupedChangeCount: adaptiveGroups.reduce((total, group) => total + group.entryCount, 0),
      adaptiveGroupCount: adaptiveGroups.length,
    },
  };
}

function findSecretViolation(text) {
  for (const [label, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

async function readBlobText({ repoRoot, oid, env, maximumBytes, label, signal }) {
  const result = await runGitCommand({
    repoRoot,
    args: ['cat-file', 'blob', oid],
    env,
    maximumStdoutBytes: maximumBytes,
    signal,
  });
  const text = result.stdout.toString('utf8');
  if (text.includes('\uFFFD')) {
    throw new AutomaticCommitError('NON_TEXT_CONTEXT', `${label} is not valid UTF-8 text.`);
  }
  return text;
}

async function readBoundedTextContext({
  repoRoot,
  oid,
  blobSize,
  maximumContextBytes,
  env,
  label,
  omissionLabel,
  signal,
}) {
  if (blobSize <= maximumContextBytes) {
    const content = await readBlobText({ repoRoot, oid, env, maximumBytes: maximumContextBytes, label, signal });
    return { content, contextDisposition: 'complete', contentSha256: hashBuffer(Buffer.from(content)) };
  }
  const result = await runProcess({
    command: 'git',
    args: ['cat-file', 'blob', oid],
    cwd: repoRoot,
    env,
    timeoutMs: 120_000,
    maximumStdoutBytes: blobSize,
    signal,
  });
  if (result.code !== 0) {
    throw new AutomaticCommitError('GIT_COMMAND_FAILED', `git cat-file failed while reading ${label}.`);
  }
  const content = result.stdout.toString('utf8');
  if (content.includes('\uFFFD')) {
    return {
      content: `[${omissionLabel} body omitted: ${blobSize} bytes, non-UTF-8, blob ${oid}]`,
      contextDisposition: 'metadata-only',
      contentSha256: hashBuffer(result.stdout),
    };
  }
  const marker = `\n\n[${omissionLabel} body omitted between bounded excerpts of ${blobSize} bytes; blob ${oid}]\n\n`;
  const excerptBytes = Math.max(0, maximumContextBytes - Buffer.byteLength(marker));
  const contentBuffer = Buffer.from(content);
  const headBytes = Math.ceil(excerptBytes * 0.7);
  const tailBytes = Math.max(0, excerptBytes - headBytes);
  const head = decodeUtf8Head(contentBuffer.subarray(0, headBytes));
  const tail = decodeUtf8Tail(contentBuffer.subarray(Math.max(headBytes, contentBuffer.length - tailBytes)));
  return {
    content: `${head}${marker}${tail}`,
    contextDisposition: 'bounded-excerpt',
    contentSha256: hashBuffer(result.stdout),
  };
}

function createBoundedExcerpt(content, maximumBytes, { label, bodyLabel }) {
  const contentBuffer = Buffer.from(content);
  if (contentBuffer.length <= maximumBytes) return content;
  const marker = `\n[${bodyLabel} omitted between bounded excerpts: ${contentBuffer.length} bytes; sha256 ${hashBuffer(contentBuffer)}; ${label}]\n`;
  const excerptBytes = Math.max(0, maximumBytes - Buffer.byteLength(marker));
  const headBytes = Math.ceil(excerptBytes * 0.7);
  const tailBytes = Math.max(0, excerptBytes - headBytes);
  const head = decodeUtf8Head(contentBuffer.subarray(0, headBytes));
  const tail = decodeUtf8Tail(contentBuffer.subarray(Math.max(headBytes, contentBuffer.length - tailBytes)));
  return `${head}${marker}${tail}`;
}

function createBoundedPatchExcerpt(patch, maximumBytes, label) {
  return createBoundedExcerpt(patch, maximumBytes, { label, bodyLabel: 'patch body' });
}

async function readBoundedPatches({ repoRoot, baseOid, manifest, env, signal }) {
  const textualChanges = manifest.filter((change) => !change.metadataOnly);
  if (textualChanges.length === 0) return [];
  const perChangeBudget = Math.max(512, Math.floor(MAX_PATCH_CONTEXT_BYTES / textualChanges.length));
  const excerpts = [];
  for (const change of textualChanges) {
    const changePaths = [...new Set([change.oldPath, change.path].filter(Boolean))];
    const fullPatch = (await runGitCommand({
      repoRoot,
      args: [
        'diff', '--cached', '--no-ext-diff', '--no-textconv', '--unified=30', '--find-renames',
        baseOid, '--', ...changePaths,
      ],
      env,
      maximumStdoutBytes: MAX_PER_FILE_DIFF_BYTES,
      signal,
    })).stdout.toString('utf8');
    const secretViolation = findSecretViolation(fullPatch);
    if (secretViolation) {
      throw new AutomaticCommitError(
        'SECRET_DETECTED',
        `A high-confidence ${secretViolation} signature was found in the staged diff for ${change.path}; no model was called.`,
      );
    }
    excerpts.push({
      changeId: change.id,
      path: change.path,
      content: createBoundedPatchExcerpt(fullPatch, perChangeBudget, change.path),
    });
  }
  return excerpts;
}

async function scanMetadataOnlyBlobsForSecrets({ repoRoot, manifest, blobSizes, env, signal }) {
  const pendingOids = [];
  const seenOids = new Set();
  for (const change of manifest) {
    if (!change.metadataOnly || !change.newOid || /^0+$/.test(change.newOid) || seenOids.has(change.newOid)) continue;
    seenOids.add(change.newOid);
    pendingOids.push(change.newOid);
  }
  for (let start = 0; start < pendingOids.length;) {
    const batch = [];
    let batchBlobBytes = 0;
    while (start < pendingOids.length) {
      const oid = pendingOids[start];
      const blobSize = blobSizes.get(oid) || 0;
      if (batch.length > 0 && batchBlobBytes + blobSize > MAX_SECRET_SCAN_BATCH_BYTES) break;
      batch.push({ oid, blobSize });
      batchBlobBytes += blobSize;
      start += 1;
    }
    const result = await runProcess({
      command: 'git',
      args: ['cat-file', '--batch'],
      cwd: repoRoot,
      env,
      input: `${batch.map(({ oid }) => oid).join('\n')}\n`,
      timeoutMs: 120_000,
      maximumStdoutBytes: batchBlobBytes + (batch.length * 160),
      signal,
    });
    if (result.code !== 0) {
      throw new AutomaticCommitError('GIT_COMMAND_FAILED', 'git cat-file failed while scanning metadata-only content.');
    }
    let offset = 0;
    for (const expected of batch) {
      const headerEnd = result.stdout.indexOf(10, offset);
      if (headerEnd < 0) throw new AutomaticCommitError('INVALID_GIT_OUTPUT', 'Missing git cat-file batch header.');
      const header = result.stdout.subarray(offset, headerEnd).toString('utf8');
      const match = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(header);
      if (!match || match[1] !== expected.oid || Number.parseInt(match[2], 10) !== expected.blobSize) {
        throw new AutomaticCommitError('INVALID_GIT_OUTPUT', `Unexpected git cat-file batch row: ${header}`);
      }
      const contentStart = headerEnd + 1;
      const contentEnd = contentStart + expected.blobSize;
      if (contentEnd >= result.stdout.length || result.stdout[contentEnd] !== 10) {
        throw new AutomaticCommitError('INVALID_GIT_OUTPUT', `Incomplete git cat-file content for ${expected.oid}.`);
      }
      const secretViolation = findSecretViolation(result.stdout.subarray(contentStart, contentEnd).toString('latin1'));
      if (secretViolation) {
        throw new AutomaticCommitError(
          'SECRET_DETECTED',
          `A high-confidence ${secretViolation} signature was found in metadata-only staged content; no model was called.`,
        );
      }
      offset = contentEnd + 1;
    }
  }
}

function findApplicableAgentPaths(changedPaths, stageMap) {
  const result = new Set();
  if (stageMap.has('AGENTS.md')) result.add('AGENTS.md');
  for (const changedPath of changedPaths) {
    if (path.posix.basename(changedPath) === 'AGENTS.md' && stageMap.has(changedPath)) result.add(changedPath);
    for (let directory = path.posix.dirname(changedPath); directory !== '.' && directory !== '/';) {
      const candidate = `${directory}/AGENTS.md`;
      if (stageMap.has(candidate)) result.add(candidate);
      const parent = path.posix.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...result].sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
}

function pathsForChange(change) {
  return [change.oldPath, change.path].filter(Boolean);
}

function findAgentRelatedChangeIds(agentPath, changes, evidenceIdByRawChangeId) {
  if (agentPath === 'AGENTS.md') return [...new Set(changes.map((change) => evidenceIdByRawChangeId.get(change.id)))];
  const agentDirectory = path.posix.dirname(agentPath);
  return [...new Set(changes
    .filter((change) => pathsForChange(change).some((changedPath) => (
      changedPath === agentPath || changedPath.startsWith(`${agentDirectory}/`)
    )))
    .map((change) => evidenceIdByRawChangeId.get(change.id)))];
}

function findWorkSpecRelatedChangeIds(candidate, changes, evidenceIdByRawChangeId) {
  const workSpecDirectory = path.posix.dirname(candidate.path);
  return [...new Set(changes
    .filter((change) => pathsForChange(change).some((changedPath) => (
      changedPath === candidate.path
      || changedPath.startsWith(`${workSpecDirectory}/`)
      || candidate.content.includes(changedPath)
    )))
    .map((change) => evidenceIdByRawChangeId.get(change.id)))];
}

function addWorkSpecCandidate(candidateMap, candidate) {
  const existing = candidateMap.get(candidate.path);
  const candidateRank = candidate.relationshipHint === 'touched' ? 3 : candidate.required ? 2 : 1;
  const existingRank = existing?.relationshipHint === 'touched' ? 3 : existing?.required ? 2 : existing ? 1 : 0;
  if (candidateRank > existingRank) candidateMap.set(candidate.path, candidate);
}

function isSpecificWorkSpecReferencePath(changedPath) {
  if (!changedPath.includes('/')) return false;
  return !new Set([
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    'package.json',
    'package-lock.json',
    'work-spec.md',
  ]).has(path.posix.basename(changedPath));
}

async function findWorkSpecCandidates({ repoRoot, changes, referenceChanges = changes, stageMap, env, signal }) {
  const candidates = new Map();
  const directEntryByPath = new Map();
  for (const change of changes) {
    directEntryByPath.set(change.path, change);
    if (change.oldPath) directEntryByPath.set(change.oldPath, change);
    for (const changedPath of [change.oldPath, change.path].filter(Boolean)) {
      if (/(?:^|\/)docs\/work\/.+\/work-spec\.md$/.test(changedPath)) {
        addWorkSpecCandidate(candidates, {
          path: changedPath,
          relationshipHint: 'touched',
          required: true,
          evidence: 'The work spec is changed directly in this snapshot.',
        });
      }
      let directory = path.posix.dirname(changedPath);
      while (directory !== '.' && directory !== '/') {
        const candidatePath = `${directory}/work-spec.md`;
        if (stageMap.has(candidatePath)) {
          addWorkSpecCandidate(candidates, {
            path: candidatePath,
            relationshipHint: candidatePath === changedPath ? 'touched' : 'related',
            required: true,
            evidence: `The work spec owns changed path ${changedPath}.`,
          });
          break;
        }
        const parent = path.posix.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
  }

  const searchPaths = [...new Set(referenceChanges
    .flatMap((change) => [change.oldPath, change.path])
    .filter((changedPath) => changedPath && isSpecificWorkSpecReferencePath(changedPath)))];
  for (let start = 0; start < searchPaths.length; start += 30) {
    const patterns = searchPaths.slice(start, start + 30);
    const args = ['grep', '--cached', '-l', '-z', '-F'];
    for (const pattern of patterns) args.push('-e', pattern);
    args.push('--', ':(glob)docs/work/**/work-spec.md', ':(glob)games/*/docs/work/**/work-spec.md');
    const result = await runGitCommand({ repoRoot, args, env, allowedExitCodes: [0, 1], signal });
    for (const workSpecPath of splitNullTerminated(result.stdout)) {
      addWorkSpecCandidate(candidates, {
        path: workSpecPath,
        relationshipHint: 'related',
        required: false,
        evidence: 'The staged work spec names at least one changed path exactly.',
      });
    }
  }

  const allRequiredCandidates = [...candidates.values()]
    .filter((candidate) => candidate.required)
    .sort((left, right) => left.path.localeCompare(right.path));
  const requiredCandidates = allRequiredCandidates.slice(0, MAX_REQUIRED_WORK_SPECS);
  const omittedRequiredCount = Math.max(0, allRequiredCandidates.length - requiredCandidates.length);
  const optionalCandidates = [...candidates.values()]
    .filter((candidate) => !candidate.required)
    .sort((left, right) => left.path.localeCompare(right.path));
  const selectedCandidates = [
    ...requiredCandidates,
    ...optionalCandidates.slice(0, MAX_RELATED_WORK_SPEC_SUGGESTIONS),
  ];
  const omittedSuggestionCount = Math.max(0, optionalCandidates.length - MAX_RELATED_WORK_SPEC_SUGGESTIONS);

  let totalBytes = 0;
  const result = [];
  for (let candidateIndex = 0; candidateIndex < selectedCandidates.length; candidateIndex += 1) {
    const candidate = selectedCandidates[candidateIndex];
    const currentRow = stageMap.get(candidate.path);
    const directEntry = directEntryByPath.get(candidate.path);
    const oid = currentRow?.oid || directEntry?.oldOid;
    if (!oid || /^0+$/.test(oid)) continue;
    const blobSize = (await readBlobSizes({ repoRoot, oids: [oid], env, signal })).get(oid) || 0;
    const candidatesRemaining = selectedCandidates.length - candidateIndex;
    const maximumContextBytes = Math.max(
      512,
      Math.min(MAX_CONTEXT_DOCUMENT_BYTES, Math.floor((MAX_WORK_SPEC_CONTEXT_BYTES - totalBytes) / candidatesRemaining)),
    );
    const context = await readBoundedTextContext({
      repoRoot,
      oid,
      blobSize,
      maximumContextBytes,
      env,
      label: candidate.path,
      omissionLabel: 'work-spec',
      signal,
    });
    totalBytes += Buffer.byteLength(context.content);
    result.push({ ...candidate, blobSize, ...context });
  }
  return { candidates: result, omittedRequiredCount, omittedSuggestionCount };
}

export async function buildEvidencePacket({ repoRoot, baseOid, branch, repositoryName, snapshot, signal }) {
  const rawResult = await runGitCommand({
    repoRoot,
    args: ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--find-renames', baseOid, '--'],
    env: snapshot.snapshotEnv,
    maximumStdoutBytes: MAX_RAW_MANIFEST_BYTES,
    signal,
  });
  const changes = parseRawChanges(rawResult.stdout);
  const blobSizes = await readBlobSizes({
    repoRoot,
    oids: changes.flatMap((change) => [change.oldOid, change.newOid]),
    env: snapshot.snapshotEnv,
    signal,
  });
  const changedPaths = [...new Set(changes.flatMap((change) => [change.oldPath, change.path]).filter(Boolean))];
  const lfsTrackedPaths = await readLfsTrackedPaths({
    repoRoot,
    changedPaths,
    env: snapshot.snapshotEnv,
    signal,
  });
  assertSafeChangedPathsAndBlobs({ changes, blobSizes, stageMap: snapshot.stageMap, lfsTrackedPaths });

  // Model context is finite even when a Git snapshot is not. Preserve every raw path through safety and
  // work-spec discovery, then progressively summarize coherent path cohorts instead of rejecting a large sweep.
  const evidenceManifest = buildEvidenceManifest({ changes, blobSizes, stageMap: snapshot.stageMap });
  const { manifest, evidenceIdByRawChangeId } = evidenceManifest;
  await scanMetadataOnlyBlobsForSecrets({
    repoRoot,
    manifest: evidenceManifest.metadataOnlyChanges,
    blobSizes,
    env: snapshot.snapshotEnv,
    signal,
  });

  const patches = await readBoundedPatches({
    repoRoot,
    baseOid,
    manifest,
    env: snapshot.snapshotEnv,
    signal,
  });

  const agentPaths = findApplicableAgentPaths(changedPaths, snapshot.stageMap);
  const agentBlobSizes = await readBlobSizes({
    repoRoot,
    oids: agentPaths.map((agentPath) => snapshot.stageMap.get(agentPath).oid),
    env: snapshot.snapshotEnv,
    signal,
  });
  const agentContracts = [];
  let agentContextBytes = 0;
  for (let agentIndex = 0; agentIndex < agentPaths.length; agentIndex += 1) {
    const agentPath = agentPaths[agentIndex];
    const row = snapshot.stageMap.get(agentPath);
    const agentsRemaining = agentPaths.length - agentIndex;
    const maximumContextBytes = Math.max(
      512,
      Math.min(
        MAX_CONTEXT_DOCUMENT_BYTES,
        Math.floor((MAX_AGENT_CONTRACT_CONTEXT_BYTES - agentContextBytes) / agentsRemaining),
      ),
    );
    const context = await readBoundedTextContext({
      repoRoot,
      oid: row.oid,
      blobSize: agentBlobSizes.get(row.oid) || 0,
      maximumContextBytes,
      env: snapshot.snapshotEnv,
      label: agentPath,
      omissionLabel: 'agent-contract',
      signal,
    });
    agentContextBytes += Buffer.byteLength(context.content);
    agentContracts.push({
      path: agentPath,
      relatedChangeIds: findAgentRelatedChangeIds(agentPath, changes, evidenceIdByRawChangeId),
      blobSize: agentBlobSizes.get(row.oid) || 0,
      ...context,
    });
  }

  const workSpecDiscovery = await findWorkSpecCandidates({
    repoRoot,
    changes,
    referenceChanges: manifest,
    stageMap: snapshot.stageMap,
    env: snapshot.snapshotEnv,
    signal,
  });
  const stat = (await runGitCommand({
    repoRoot,
    args: changes.length > 1_000
      ? ['diff', '--cached', '--shortstat', '--find-renames', baseOid, '--']
      : ['diff', '--cached', '--stat', '--find-renames', baseOid, '--'],
    env: snapshot.snapshotEnv,
    signal,
  })).stdout.toString('utf8');
  const boundedStat = createBoundedExcerpt(stat, MAX_DIFF_STAT_CONTEXT_BYTES, {
    label: 'git diff --stat',
    bodyLabel: 'diff stat body',
  });
  const recentCommits = (await runGitCommand({
    repoRoot,
    args: ['log', '-12', '--format=%h%x09%s%n%b%n---', baseOid],
    env: snapshot.snapshotEnv,
    maximumStdoutBytes: 80_000,
    signal,
  })).stdout.toString('utf8');

  const workSpecCandidates = workSpecDiscovery.candidates.map((candidate) => ({
    ...candidate,
    relatedChangeIds: findWorkSpecRelatedChangeIds(candidate, changes, evidenceIdByRawChangeId),
  }));
  const packet = {
    snapshotId: snapshot.snapshotId,
    baseOid,
    branch,
    repositoryName,
    rawChangeCount: changes.length,
    evidenceCompaction: evidenceManifest.summary,
    manifest,
    diffStat: boundedStat,
    patches,
    applicableAgentContracts: agentContracts,
    workSpecCandidates,
    requiredWorkSpecPaths: workSpecCandidates
      .filter((candidate) => candidate.required)
      .map((candidate) => candidate.path),
    workSpecDiscovery: {
      omittedRequiredCount: workSpecDiscovery.omittedRequiredCount,
      omittedSuggestionCount: workSpecDiscovery.omittedSuggestionCount,
    },
    recentCommits,
  };
  const serialized = JSON.stringify(packet);
  const packetSecretViolation = findSecretViolation(`+${serialized.replaceAll('\n', '\n+')}`);
  if (packetSecretViolation) {
    throw new AutomaticCommitError(
      'SECRET_DETECTED',
      `A high-confidence ${packetSecretViolation} signature was found in context; no model was called.`,
    );
  }
  return packet;
}
