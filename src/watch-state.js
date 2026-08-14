/**
 * @fileoverview Watch fingerprinting and single-instance locking for the automatic commit sweeper.
 *
 * @custody
 * - Owns: settled-worktree fingerprints and one active sweeper per canonical Git common directory.
 * - Does not own: staging, model invocation, commit creation, or supervision.
 * @intent
 * Keep long-lived watch coordination separate from frozen snapshot and commit mechanics.
 * @invariants
 * - Fingerprints include NUL-safe Git status plus content for ordinary files and targets for symlinks.
 * - Lock recovery removes only a dead owner lock for the same canonical Git directory.
 * @failure
 * Unknown lock ownership fails closed; interrupted polling preserves repository state.
 * @proof
 * `npm test`
 * @edit_policy
 * Fingerprint and lock changes require the spawned watch journey to pass.
 * @see
 * `bin/auto-commit.js`, `src/git-snapshot.js`
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AutomaticCommitError,
  resolveGitCommonDirectory,
  runGitCommand,
} from './git-snapshot.js';

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

export async function readDirtyFingerprint(repoRoot, signal) {
  const result = await runGitCommand({
    repoRoot,
    args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    signal,
  });
  if (result.stdout.length === 0) return { clean: true, fingerprint: null };
  const hash = crypto.createHash('sha256').update(result.stdout);
  const tokens = splitNullTerminated(result.stdout);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) continue;
    const status = token.slice(0, 2);
    const changedPath = token.slice(3);
    const paths = [changedPath];
    if (/[RC]/.test(status) && index + 1 < tokens.length) paths.push(tokens[index += 1]);
    for (const relativePath of paths) {
      const absolutePath = path.resolve(repoRoot, relativePath);
      try {
        const stats = await fs.lstat(absolutePath, { bigint: true });
        hash.update(`${relativePath}\0${stats.mode}\0${stats.size}\0${stats.mtimeNs}\0`);
        if (stats.isSymbolicLink()) {
          hash.update(await fs.readlink(absolutePath));
        } else if (stats.isFile()) {
          const handle = await fs.open(absolutePath, 'r');
          const buffer = Buffer.allocUnsafe(64 * 1024);
          try {
            for (let position = 0; ;) {
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
              if (bytesRead === 0) break;
              hash.update(buffer.subarray(0, bytesRead));
              position += bytesRead;
            }
          } finally {
            await handle.close();
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        hash.update(`${relativePath}\0deleted\0`);
      }
    }
  }
  return { clean: false, fingerprint: hash.digest('hex') };
}
export async function acquireSingleInstanceLock(repoRoot) {
  const commonDirectory = await resolveGitCommonDirectory(repoRoot);
  const lockKey = hashBuffer(Buffer.from(commonDirectory)).slice(0, 24);
  const lockDirectory = path.join(os.tmpdir(), `auto-commit-${lockKey}.lock`);
  const ownerPath = path.join(lockDirectory, 'owner.json');

  const tryAcquire = async () => {
    await fs.mkdir(lockDirectory, { mode: 0o700 });
    await fs.writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, commonDirectory, startedAt: new Date().toISOString() })}\n`, {
      mode: 0o600,
    });
  };
  try {
    await tryAcquire();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let owner = null;
    try {
      owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    } catch {
      throw new AutomaticCommitError('LOCK_HELD', `Automatic-commit lock exists without readable ownership: ${lockDirectory}`);
    }
    let ownerAlive = false;
    try {
      process.kill(owner.pid, 0);
      ownerAlive = true;
    } catch (processError) {
      ownerAlive = processError?.code === 'EPERM';
    }
    if (ownerAlive || owner.commonDirectory !== commonDirectory) {
      throw new AutomaticCommitError('LOCK_HELD', `Automatic commit is already running as PID ${owner.pid}.`);
    }
    await fs.rm(lockDirectory, { recursive: true, force: true });
    await tryAcquire();
  }
  return async () => {
    let owner = null;
    try {
      owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    } catch {
      return;
    }
    if (owner.pid === process.pid && owner.commonDirectory === commonDirectory) {
      await fs.rm(lockDirectory, { recursive: true, force: true });
    }
  };
}
