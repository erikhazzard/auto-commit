/**
 * @fileoverview Git/process custody for the automatic commit sweeper.
 *
 * @custody
 * - Owns: repository safety preflight, frozen staged snapshots, process execution, and exact-index commits.
 * - Does not own: evidence packets, process locks, model prompts, watch policy, pushing, or history rewriting.
 * @intent
 * Keep the live-worktree and Git transaction boundary isolated from commit-message authorship.
 * @invariants
 * - The analyzed index is immutable and identified by its base OID plus canonical staged entries.
 * - Commit proceeds only while live HEAD, branch, and index still match the captured snapshot.
 * - Only git add -A and git commit mutate repository state.
 * @failure
 * Failures preserve staged and worktree content. An ambiguous commit exit is reconciled from the resulting commit.
 * @proof
 * `npm test`
 * @edit_policy
 * Snapshot identity, safety gates, and commit reconciliation changes require the core-flow proof to change or pass.
 * @see
 * `bin/auto-commit.js`
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs, { constants as fsConstants } from 'node:fs/promises';
import path from 'node:path';

const PROCESS_TERMINATION_GRACE_MS = 5_000;
const STAGE_RECHECK_MS = 150;
const MAX_PROCESS_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_PROCESS_STDERR_BYTES = 96 * 1024;

export class AutomaticCommitError extends Error {
  constructor(code, message, { retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AutomaticCommitError';
    this.code = code;
    this.retryable = retryable;
  }
}

function hashBuffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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
function appendBoundedTail(current, chunk, maximumBytes) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length <= maximumBytes ? combined : combined.subarray(combined.length - maximumBytes);
}

export async function runProcess({
  command,
  args,
  cwd,
  env = process.env,
  input,
  timeoutMs = 60_000,
  maximumStdoutBytes = MAX_PROCESS_STDOUT_BYTES,
  signal,
}) {
  if (signal?.aborted) {
    throw new AutomaticCommitError('INTERRUPTED', `${command} was interrupted.`);
  }
  return await new Promise((resolve, reject) => {
    const ownsProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: ownsProcessGroup,
    });
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let terminalError = null;
    let stdinError = null;
    let stdinSettled = false;
    let childClose = null;
    let promiseSettled = false;
    let terminationTimer = null;

    const settleProcess = () => {
      if (promiseSettled || !childClose || (!terminalError && !stdinSettled)) return;
      promiseSettled = true;
      clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      signal?.removeEventListener('abort', onAbort);
      if (terminalError) {
        reject(terminalError);
        return;
      }
      if (stdinError && childClose.code === 0) {
        reject(stdinError);
        return;
      }
      resolve({
        code: childClose.code,
        signal: childClose.signal,
        stdout: Buffer.concat(stdoutChunks),
        stderr: stderrTail,
      });
    };

    const stopChild = () => {
      if (child.exitCode !== null || child.killed) return;
      const signalProcess = (signalName) => {
        try {
          if (ownsProcessGroup) process.kill(-child.pid, signalName);
          else child.kill(signalName);
        } catch (error) {
          if (error?.code === 'ESRCH') return;
          try {
            child.kill(signalName);
          } catch (fallbackError) {
            if (fallbackError?.code !== 'ESRCH') throw fallbackError;
          }
        }
      };
      signalProcess('SIGTERM');
      terminationTimer = setTimeout(() => {
        try {
          signalProcess('SIGKILL');
        } catch {
          // The close path will surface the original timeout/interruption.
        }
      }, PROCESS_TERMINATION_GRACE_MS);
      terminationTimer.unref?.();
    };

    const timeout = setTimeout(() => {
      terminalError = new AutomaticCommitError('PROCESS_TIMEOUT', `${command} timed out after ${timeoutMs}ms.`, { retryable: true });
      stopChild();
    }, timeoutMs);
    timeout.unref?.();

    const onAbort = () => {
      terminalError = new AutomaticCommitError('INTERRUPTED', `${command} was interrupted.`);
      stopChild();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumStdoutBytes && !terminalError) {
        terminalError = new AutomaticCommitError(
          'OUTPUT_LIMIT',
          `${command} produced more than ${maximumStdoutBytes} stdout bytes.`,
        );
        stopChild();
        return;
      }
      if (!terminalError) stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderrTail = appendBoundedTail(stderrTail, chunk, MAX_PROCESS_STDERR_BYTES);
    });
    child.once('error', (error) => {
      terminalError = new AutomaticCommitError('PROCESS_START_FAILED', `Could not start ${command}: ${error.message}`, {
        retryable: error?.code !== 'ENOENT',
        cause: error,
      });
    });
    child.stdin.once('finish', () => {
      stdinSettled = true;
      settleProcess();
    });
    child.stdin.once('error', (error) => {
      stdinSettled = true;
      if (!terminalError) {
        stdinError = new AutomaticCommitError('PROCESS_STDIN_FAILED', `Could not write input to ${command}: ${error.message}`, {
          retryable: true,
          cause: error,
        });
        // EPIPE usually means the child already exited. Preserve its nonzero code and stderr as the primary diagnosis.
        if (error?.code !== 'EPIPE') {
          terminalError = stdinError;
          stopChild();
        }
      }
      settleProcess();
    });
    child.stdin.once('close', () => {
      if (stdinSettled) return;
      stdinSettled = true;
      if (input !== undefined && !terminalError) {
        stdinError = new AutomaticCommitError(
          'PROCESS_STDIN_FAILED',
          `Input closed before it was fully written to ${command}.`,
          { retryable: true },
        );
      }
      settleProcess();
    });
    child.once('close', (code, childSignal) => {
      childClose = {
        code: Number.isInteger(code) ? code : 1,
        signal: childSignal,
      };
      settleProcess();
    });

    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

export async function runGitCommand({ repoRoot, args, env, allowedExitCodes = [0], maximumStdoutBytes, signal }) {
  const result = await runProcess({
    command: 'git',
    args,
    cwd: repoRoot,
    env,
    timeoutMs: 120_000,
    maximumStdoutBytes,
    signal,
  });
  if (!allowedExitCodes.includes(result.code)) {
    const detail = result.stderr.toString('utf8').trim() || `exit ${result.code}`;
    throw new AutomaticCommitError('GIT_COMMAND_FAILED', `git ${args[0]} failed: ${detail}`, { retryable: true });
  }
  return result;
}

async function pathExists(absolutePath) {
  try {
    await fs.lstat(absolutePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function resolveRepositoryRoot(startDirectory, signal) {
  const result = await runGitCommand({ repoRoot: startDirectory, args: ['rev-parse', '--show-toplevel'], signal });
  return await fs.realpath(result.stdout.toString('utf8').trim());
}

async function resolveGitPath(repoRoot, relativeOrAbsolutePath) {
  return path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.resolve(repoRoot, relativeOrAbsolutePath);
}

async function resolveDefaultHooksDirectory(repoRoot, signal) {
  const commonDirectory = await resolveGitCommonDirectory(repoRoot, signal);
  return path.join(commonDirectory, 'hooks');
}

export async function resolveGitCommonDirectory(repoRoot, signal) {
  const commonDirResult = await runGitCommand({ repoRoot, args: ['rev-parse', '--git-common-dir'], signal });
  const commonDirectory = await resolveGitPath(repoRoot, commonDirResult.stdout.toString('utf8').trim());
  return await fs.realpath(commonDirectory);
}

export async function resolveExecutable(executable, repoRoot, env = process.env) {
  const explicitPath = executable.includes(path.sep);
  const searchDirectories = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = explicitPath
    ? [path.resolve(repoRoot, executable)]
    : searchDirectories.map((directory) => path.join(directory, executable));
  const visitedPaths = new Set();
  const incompatibleCandidates = [];
  for (const candidate of candidates) {
    let resolvedCandidate;
    try {
      await fs.access(candidate, fsConstants.X_OK);
      resolvedCandidate = await fs.realpath(candidate);
    } catch {
      continue;
    }
    if (visitedPaths.has(resolvedCandidate)) continue;
    visitedPaths.add(resolvedCandidate);

    // Ratatosk app-server shims answer --version but intentionally reject exec, so probe the required subcommand.
    try {
      const probe = await runProcess({
        command: resolvedCandidate,
        args: ['exec', '--help'],
        cwd: repoRoot,
        env,
        timeoutMs: 10_000,
        maximumStdoutBytes: 512_000,
      });
      if (probe.code === 0) return resolvedCandidate;
      const detail = probe.stderr.toString('utf8').trim().split(/\r?\n/u).filter(Boolean).at(-1)
        || `exit ${probe.code}`;
      incompatibleCandidates.push(`${resolvedCandidate}: ${detail.slice(-300)}`);
    } catch (error) {
      incompatibleCandidates.push(`${resolvedCandidate}: ${String(error?.message || error).slice(-300)}`);
    }
  }
  if (incompatibleCandidates.length > 0) {
    throw new AutomaticCommitError(
      'CODEX_INCOMPATIBLE',
      `No Codex CLI with non-interactive exec support was found. ${incompatibleCandidates.slice(0, 3).join(' | ')}. Pass --codex-bin <path> to a compatible CLI.`,
    );
  }
  throw new AutomaticCommitError('CODEX_NOT_FOUND', `Could not resolve executable '${executable}'.`);
}

export async function readSymbolicBranchOrThrow(repoRoot, signal) {
  const result = await runGitCommand({
    repoRoot,
    args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    allowedExitCodes: [0, 1],
    signal,
  });
  const branch = result.stdout.toString('utf8').trim();
  if (result.code !== 0 || !branch) {
    throw new AutomaticCommitError('DETACHED_HEAD', 'Automatic commits require an attached branch.');
  }
  return branch;
}

export async function readHeadOidOrThrow(repoRoot, signal) {
  const result = await runGitCommand({
    repoRoot,
    args: ['rev-parse', '--verify', 'HEAD^{commit}'],
    allowedExitCodes: [0, 128],
    signal,
  });
  const oid = result.stdout.toString('utf8').trim();
  if (result.code !== 0 || !oid) {
    throw new AutomaticCommitError('UNBORN_HEAD', 'Automatic commits require an existing HEAD commit.');
  }
  return oid;
}

export async function assertSafeRepositoryState({ repoRoot, signal }) {
  const stateNames = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-apply', 'rebase-merge'];
  for (const stateName of stateNames) {
    const result = await runGitCommand({ repoRoot, args: ['rev-parse', '--git-path', stateName], signal });
    const absolutePath = await resolveGitPath(repoRoot, result.stdout.toString('utf8').trim());
    if (await pathExists(absolutePath)) {
      throw new AutomaticCommitError('GIT_OPERATION_IN_PROGRESS', `Refusing to commit while ${stateName} exists.`);
    }
  }

  const conflicts = await runGitCommand({ repoRoot, args: ['diff', '--name-only', '--diff-filter=U', '-z'], signal });
  if (conflicts.stdout.length > 0) {
    throw new AutomaticCommitError('UNRESOLVED_CONFLICT', 'Refusing to commit with unresolved index conflicts.');
  }

  const indexLockResult = await runGitCommand({ repoRoot, args: ['rev-parse', '--git-path', 'index.lock'], signal });
  if (await pathExists(await resolveGitPath(repoRoot, indexLockResult.stdout.toString('utf8').trim()))) {
    throw new AutomaticCommitError('INDEX_LOCKED', 'The Git index is locked by another process.', { retryable: true });
  }

  const configuredHooksPath = await runGitCommand({
    repoRoot,
    args: ['config', '--path', '--get', 'core.hooksPath'],
    allowedExitCodes: [0, 1],
    signal,
  });
  const hooksPath = configuredHooksPath.code === 0
    ? await resolveGitPath(repoRoot, configuredHooksPath.stdout.toString('utf8').trim())
    : await resolveDefaultHooksDirectory(repoRoot, signal);
  for (const hookName of ['pre-commit', 'prepare-commit-msg', 'commit-msg']) {
    const hookPath = path.join(hooksPath, hookName);
    try {
      const stats = await fs.stat(hookPath);
      if (stats.isFile() && (stats.mode & 0o111) !== 0) {
        throw new AutomaticCommitError(
          'INDEX_OR_MESSAGE_HOOK',
          `Refusing automatic commit because executable ${hookName} may change the analyzed index or message.`,
        );
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  await runGitCommand({ repoRoot, args: ['var', 'GIT_AUTHOR_IDENT'], signal });
  await runGitCommand({ repoRoot, args: ['var', 'GIT_COMMITTER_IDENT'], signal });
}

function parseStageMap(buffer) {
  const map = new Map();
  for (const record of splitNullTerminated(buffer)) {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match) throw new AutomaticCommitError('INVALID_GIT_OUTPUT', 'Could not parse git ls-files --stage output.');
    if (match[3] !== '0') throw new AutomaticCommitError('UNRESOLVED_CONFLICT', `Index stage ${match[3]} exists for ${match[4]}.`);
    map.set(match[4], { mode: match[1], oid: match[2] });
  }
  return map;
}

async function readStageBuffer({ repoRoot, env, signal }) {
  return (await runGitCommand({ repoRoot, args: ['ls-files', '--stage', '-z'], env, signal })).stdout;
}

export async function delay(ms, signal) {
  if (ms <= 0) return;
  if (signal?.aborted) {
    throw new AutomaticCommitError('INTERRUPTED', 'Automatic commit was interrupted.');
  }
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(new AutomaticCommitError('INTERRUPTED', 'Automatic commit was interrupted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Snapshot capture protocol:
 * - Stage all repository changes into the live index.
 * - Copy and fingerprint that index without reading through live worktree paths.
 * - Wait briefly, stage again, and require the canonical staged entries to be identical.
 * - Analyze only the second copied index; later worktree edits belong to the next sweep.
 */
export async function stageAndFreeze({ repoRoot, tempDirectory, baseOid, signal }) {
  await runGitCommand({ repoRoot, args: ['add', '-A', '--', '.'], signal });
  const indexPathResult = await runGitCommand({ repoRoot, args: ['rev-parse', '--git-path', 'index'], signal });
  const liveIndexPath = await resolveGitPath(repoRoot, indexPathResult.stdout.toString('utf8').trim());
  const firstIndexPath = path.join(tempDirectory, 'index-first');
  await fs.copyFile(liveIndexPath, firstIndexPath);
  await fs.chmod(firstIndexPath, 0o600);
  const firstEnv = { ...process.env, GIT_INDEX_FILE: firstIndexPath, GIT_OPTIONAL_LOCKS: '0' };
  const firstStageBuffer = await readStageBuffer({ repoRoot, env: firstEnv, signal });

  await delay(STAGE_RECHECK_MS, signal);
  await runGitCommand({ repoRoot, args: ['add', '-A', '--', '.'], signal });
  const snapshotIndexPath = path.join(tempDirectory, 'index');
  await fs.copyFile(liveIndexPath, snapshotIndexPath);
  await fs.chmod(snapshotIndexPath, 0o600);
  const snapshotEnv = { ...process.env, GIT_INDEX_FILE: snapshotIndexPath, GIT_OPTIONAL_LOCKS: '0' };
  const snapshotStageBuffer = await readStageBuffer({ repoRoot, env: snapshotEnv, signal });
  if (!crypto.timingSafeEqual(
    Buffer.from(hashBuffer(firstStageBuffer), 'hex'),
    Buffer.from(hashBuffer(snapshotStageBuffer), 'hex'),
  )) {
    throw new AutomaticCommitError(
      'STAGE_CHANGED_DURING_CAPTURE',
      'The staged tree changed during the capture window; retry after writers settle.',
      { retryable: true },
    );
  }

  const diffResult = await runGitCommand({
    repoRoot,
    args: ['diff', '--cached', '--quiet', baseOid, '--'],
    env: snapshotEnv,
    allowedExitCodes: [0, 1],
    signal,
  });
  return {
    clean: diffResult.code === 0,
    liveIndexPath,
    snapshotIndexPath,
    snapshotEnv,
    stageBuffer: snapshotStageBuffer,
    stageMap: parseStageMap(snapshotStageBuffer),
    stageHash: hashBuffer(snapshotStageBuffer),
    snapshotId: hashBuffer(Buffer.concat([Buffer.from(`${baseOid}\0`), snapshotStageBuffer])),
  };
}

function parseCommitTreeRows(buffer) {
  const rows = [];
  for (const record of splitNullTerminated(buffer)) {
    const match = /^(\d{6}) (?:blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record);
    if (!match) throw new AutomaticCommitError('INVALID_GIT_OUTPUT', 'Could not parse git ls-tree output.');
    rows.push(`${match[1]} ${match[2]} 0\t${match[3]}\0`);
  }
  return Buffer.from(rows.sort().join(''));
}

function normalizeStageRows(buffer) {
  return Buffer.from(splitNullTerminated(buffer).sort().map((row) => `${row}\0`).join(''));
}

async function verifyCommittedSnapshot({ repoRoot, baseOid, expectedStageBuffer, expectedMessage, signal }) {
  const headOid = await readHeadOidOrThrow(repoRoot, signal);
  const parentResult = await runGitCommand({ repoRoot, args: ['rev-list', '--parents', '-n', '1', headOid], signal });
  const parents = parentResult.stdout.toString('utf8').trim().split(/\s+/).slice(1);
  if (parents.length !== 1 || parents[0] !== baseOid) {
    throw new AutomaticCommitError(
      'COMMIT_PARENT_MISMATCH',
      `HEAD advanced, but its parent is not captured base ${baseOid}; manual inspection is required.`,
    );
  }
  const treeResult = await runGitCommand({ repoRoot, args: ['ls-tree', '-r', '-z', headOid], signal });
  const expectedRows = normalizeStageRows(expectedStageBuffer);
  const actualRows = parseCommitTreeRows(treeResult.stdout);
  if (hashBuffer(expectedRows) !== hashBuffer(actualRows)) {
    throw new AutomaticCommitError('COMMIT_TREE_MISMATCH', 'HEAD advanced, but the commit tree differs from the analyzed index.');
  }
  const messageResult = await runGitCommand({ repoRoot, args: ['log', '-1', '--format=%B', headOid], signal });
  if (messageResult.stdout.toString('utf8').trimEnd() !== expectedMessage.trimEnd()) {
    throw new AutomaticCommitError('COMMIT_MESSAGE_MISMATCH', 'HEAD advanced, but its message differs from the validated message.');
  }
  return headOid;
}

async function reconcileCommitAttempt({
  repoRoot,
  baseOid,
  expectedStageBuffer,
  expectedMessage,
  commitFailure = null,
}) {
  const verificationController = new AbortController();
  const verificationTimeout = setTimeout(() => verificationController.abort(), 30_000);
  try {
    const currentHead = await readHeadOidOrThrow(repoRoot, verificationController.signal);
    if (currentHead === baseOid && commitFailure) {
      if (commitFailure instanceof AutomaticCommitError) throw commitFailure;
      throw new AutomaticCommitError(
        'GIT_COMMIT_FAILED',
        `git commit failed: ${commitFailure.stderr.toString('utf8').trim() || `exit ${commitFailure.code}`}`,
        { retryable: true },
      );
    }
    if (currentHead === baseOid) {
      throw new AutomaticCommitError('GIT_COMMIT_FAILED', 'git commit exited successfully without advancing HEAD.', { retryable: true });
    }
    return await verifyCommittedSnapshot({
      repoRoot,
      baseOid,
      expectedStageBuffer,
      expectedMessage,
      signal: verificationController.signal,
    });
  } finally {
    clearTimeout(verificationTimeout);
  }
}

export async function commitFrozenSnapshot({ repoRoot, baseOid, branch, snapshot, commitMessage, tempDirectory, log, signal }) {
  const liveHead = await readHeadOidOrThrow(repoRoot, signal);
  const liveBranch = await readSymbolicBranchOrThrow(repoRoot, signal);
  if (liveHead !== baseOid || liveBranch !== branch) {
    throw new AutomaticCommitError('HEAD_DRIFT', 'HEAD or the checked-out branch changed during message generation.', { retryable: true });
  }
  const liveStageBuffer = await readStageBuffer({ repoRoot, env: process.env, signal });
  if (hashBuffer(liveStageBuffer) !== snapshot.stageHash) {
    throw new AutomaticCommitError('INDEX_DRIFT', 'The live Git index changed during message generation.', { retryable: true });
  }

  const snapshotStageBuffer = await readStageBuffer({ repoRoot, env: snapshot.snapshotEnv, signal });
  if (hashBuffer(snapshotStageBuffer) !== snapshot.stageHash) {
    throw new AutomaticCommitError('SNAPSHOT_INDEX_DRIFT', 'The frozen Git index changed during message generation.');
  }
  const commitIndexPath = path.join(tempDirectory, 'commit-index');
  await fs.copyFile(snapshot.snapshotIndexPath, commitIndexPath);
  await fs.chmod(commitIndexPath, 0o600);
  const commitEnv = { ...process.env, GIT_INDEX_FILE: commitIndexPath, GIT_OPTIONAL_LOCKS: '0' };
  const commitStageBuffer = await readStageBuffer({ repoRoot, env: commitEnv, signal });
  if (hashBuffer(commitStageBuffer) !== snapshot.stageHash) {
    throw new AutomaticCommitError('SNAPSHOT_INDEX_DRIFT', 'The commit index differs from the analyzed Git index.');
  }

  const messagePath = path.join(tempDirectory, 'commit-message.txt');
  await fs.writeFile(messagePath, commitMessage, { mode: 0o600 });
  log('Committing the frozen staged snapshot...', {
    phase: 'COMMIT',
    state: 'active',
    gapBefore: true,
    prettyMessage: 'Writing the frozen snapshot',
  });
  let commitResult;
  try {
    commitResult = await runProcess({
      command: 'git',
      args: ['commit', '-F', messagePath, '--cleanup=verbatim'],
      cwd: repoRoot,
      env: commitEnv,
      timeoutMs: 120_000,
      signal,
    });
  } catch (error) {
    if (!(error instanceof AutomaticCommitError)) throw error;
    commitResult = error;
  }
  const commitOid = await reconcileCommitAttempt({
    repoRoot,
    baseOid,
    expectedStageBuffer: snapshot.stageBuffer,
    expectedMessage: commitMessage,
    commitFailure: commitResult instanceof AutomaticCommitError || commitResult.code !== 0 ? commitResult : null,
  });
  try {
    await runGitCommand({ repoRoot, args: ['add', '-A', '--', '.'], signal });
  } catch (error) {
    log(`Commit ${commitOid.slice(0, 12)} succeeded, but the live index could not be refreshed: ${error.message}`, {
      phase: 'COMMIT',
      state: 'warning',
      prettyMessage: `Committed ${commitOid.slice(0, 12)}; index refresh failed`,
      detail: error.message,
    });
  }
  return commitOid;
}
