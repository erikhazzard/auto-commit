/**
 * @fileoverview Builds bounded, immutable evidence packets from a frozen Git index.
 *
 * @custody
 * - Owns: changed-path manifests, secret/size gates, applicable agent context, and work-spec discovery.
 * - Does not own: live-worktree staging, model prompting, message validation, or commit creation.
 * @intent
 * Give both models complete snapshot evidence without silently truncating large or binary inputs.
 * @invariants
 * - Every manifest row comes from the captured base plus frozen index.
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

const MAX_CHANGED_ENTRIES = 500;
const MAX_PER_FILE_DIFF_BYTES = 2_000_000;
const MAX_PATCH_CONTEXT_BYTES = 300_000;
const MAX_PACKET_BYTES = 850_000;
const MAX_NON_LFS_BLOB_BYTES = 10 * 1024 * 1024;
const MAX_CONTEXT_DOCUMENT_BYTES = 48_000;
const MAX_AGENT_CONTRACT_CONTEXT_BYTES = 64_000;
const MAX_WORK_SPEC_CONTEXT_BYTES = 96_000;
const MAX_REQUIRED_WORK_SPECS = 200;
const MAX_RELATED_WORK_SPEC_SUGGESTIONS = 30;

const BINARY_FILE_EXTENSION_PATTERN = /\.(?:avif|bin|blend|bmp|br|bz2|dae|fbx|flac|gif|glb|gltfpack|gz|ico|jpeg|jpg|ktx2|m4a|mp3|mp4|ogg|otf|pdf|png|tar|ttf|wav|webm|webp|woff2?|zip)$/i;
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
  const result = await runGitCommand({
    repoRoot,
    args: ['check-attr', '--cached', '-z', 'filter', '--', ...changedPaths],
    env,
    signal,
  });
  const values = splitNullTerminated(result.stdout);
  const lfsPaths = new Set();
  for (let index = 0; index + 2 < values.length; index += 3) {
    if (values[index + 1] === 'filter' && values[index + 2] === 'lfs') lfsPaths.add(values[index]);
  }
  return lfsPaths;
}

function assertSafeChangedPathsAndBlobs({ changes, blobSizes, stageMap, lfsTrackedPaths }) {
  if (changes.length > MAX_CHANGED_ENTRIES) {
    throw new AutomaticCommitError('TOO_MANY_CHANGES', `Refusing ${changes.length} changed entries; maximum is ${MAX_CHANGED_ENTRIES}.`);
  }
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

function createBoundedPatchExcerpt(patch, maximumBytes, label) {
  const patchBuffer = Buffer.from(patch);
  if (patchBuffer.length <= maximumBytes) return patch;
  const marker = `\n[patch body omitted between bounded excerpts: ${patchBuffer.length} bytes; sha256 ${hashBuffer(patchBuffer)}; ${label}]\n`;
  const excerptBytes = Math.max(0, maximumBytes - Buffer.byteLength(marker));
  const headBytes = Math.ceil(excerptBytes * 0.7);
  const tailBytes = Math.max(0, excerptBytes - headBytes);
  const head = decodeUtf8Head(patchBuffer.subarray(0, headBytes));
  const tail = decodeUtf8Tail(patchBuffer.subarray(Math.max(headBytes, patchBuffer.length - tailBytes)));
  return `${head}${marker}${tail}`;
}

async function readBoundedPatch({ repoRoot, baseOid, manifest, env, signal }) {
  const textualChanges = manifest.filter((change) => !change.metadataOnly);
  if (textualChanges.length === 0) return '';
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
    excerpts.push(createBoundedPatchExcerpt(fullPatch, perChangeBudget, change.path));
  }
  return excerpts.join('\n');
}

async function scanMetadataOnlyBlobsForSecrets({ repoRoot, manifest, env, signal }) {
  const scannedOids = new Set();
  for (const change of manifest) {
    if (!change.metadataOnly || /^0+$/.test(change.newOid) || scannedOids.has(change.newOid)) continue;
    scannedOids.add(change.newOid);
    const result = await runGitCommand({
      repoRoot,
      args: ['cat-file', 'blob', change.newOid],
      env,
      maximumStdoutBytes: MAX_NON_LFS_BLOB_BYTES,
      signal,
    });
    const secretViolation = findSecretViolation(result.stdout.toString('latin1'));
    if (secretViolation) {
      throw new AutomaticCommitError(
        'SECRET_DETECTED',
        `A high-confidence ${secretViolation} signature was found in metadata-only staged content; no model was called.`,
      );
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

async function findWorkSpecCandidates({ repoRoot, changes, stageMap, env, signal }) {
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

  const searchPaths = [...new Set(changes
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

  const requiredCandidates = [...candidates.values()]
    .filter((candidate) => candidate.required)
    .sort((left, right) => left.path.localeCompare(right.path));
  if (requiredCandidates.length > MAX_REQUIRED_WORK_SPECS) {
    throw new AutomaticCommitError(
      'TOO_MANY_REQUIRED_WORK_SPECS',
      `Found ${requiredCandidates.length} directly owned work specs; maximum is ${MAX_REQUIRED_WORK_SPECS}.`,
    );
  }
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
  return { candidates: result, omittedSuggestionCount };
}

export async function buildEvidencePacket({ repoRoot, baseOid, branch, repositoryName, snapshot, signal }) {
  const rawResult = await runGitCommand({
    repoRoot,
    args: ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--find-renames', baseOid, '--'],
    env: snapshot.snapshotEnv,
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

  const manifest = changes.map((change) => {
    const oldBlobSize = blobSizes.get(change.oldOid) || 0;
    const blobSize = blobSizes.get(change.newOid) || 0;
    return {
      ...change,
      oldBlobSize,
      blobSize,
      metadataOnly: BINARY_FILE_EXTENSION_PATTERN.test(change.path)
        || (change.oldPath ? BINARY_FILE_EXTENSION_PATTERN.test(change.oldPath) : false)
        || Math.max(oldBlobSize, blobSize) > 512_000,
    };
  });
  await scanMetadataOnlyBlobsForSecrets({ repoRoot, manifest, env: snapshot.snapshotEnv, signal });

  const patch = await readBoundedPatch({
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
      blobSize: agentBlobSizes.get(row.oid) || 0,
      ...context,
    });
  }

  const workSpecDiscovery = await findWorkSpecCandidates({
    repoRoot,
    changes,
    stageMap: snapshot.stageMap,
    env: snapshot.snapshotEnv,
    signal,
  });
  const stat = (await runGitCommand({
    repoRoot,
    args: ['diff', '--cached', '--stat', '--find-renames', baseOid, '--'],
    env: snapshot.snapshotEnv,
    signal,
  })).stdout.toString('utf8');
  const recentCommits = (await runGitCommand({
    repoRoot,
    args: ['log', '-12', '--format=%h%x09%s%n%b%n---', baseOid],
    env: snapshot.snapshotEnv,
    maximumStdoutBytes: 80_000,
    signal,
  })).stdout.toString('utf8');

  const packet = {
    snapshotId: snapshot.snapshotId,
    baseOid,
    branch,
    repositoryName,
    manifest,
    diffStat: stat,
    patch,
    applicableAgentContracts: agentContracts,
    workSpecCandidates: workSpecDiscovery.candidates,
    requiredWorkSpecPaths: workSpecDiscovery.candidates
      .filter((candidate) => candidate.required)
      .map((candidate) => candidate.path),
    workSpecDiscovery: { omittedSuggestionCount: workSpecDiscovery.omittedSuggestionCount },
    recentCommits,
  };
  const serialized = JSON.stringify(packet);
  if (Buffer.byteLength(serialized) > MAX_PACKET_BYTES) {
    throw new AutomaticCommitError(
      'MODEL_PACKET_LIMIT',
      `The complete evidence packet is ${Buffer.byteLength(serialized)} bytes; maximum is ${MAX_PACKET_BYTES}.`,
    );
  }
  const packetSecretViolation = findSecretViolation(`+${serialized.replaceAll('\n', '\n+')}`);
  if (packetSecretViolation) {
    throw new AutomaticCommitError(
      'SECRET_DETECTED',
      `A high-confidence ${packetSecretViolation} signature was found in context; no model was called.`,
    );
  }
  return packet;
}
