import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || result.error) return null;
  return result.stdout.trim();
}

/**
 * What the repository looked like when the command ran.
 *
 * `dirty` is the field that matters. A record taken on a dirty tree does not
 * bind a commit -- the commit id in it names code that is *not* what ran. So
 * the uncommitted diff is hashed as well, which at least makes "the same
 * uncommitted state" checkable, and every report says plainly which of the two
 * situations it is in.
 */
export function gitContext(cwd) {
  const commit = git(['rev-parse', 'HEAD'], cwd);
  if (commit === null) return { available: false };

  const status = git(['status', '--porcelain'], cwd) ?? '';
  const diff = git(['diff', 'HEAD'], cwd) ?? '';

  return {
    available: true,
    commit,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) ?? 'unknown',
    dirty: status.length > 0,
    changedFiles: status ? status.split('\n').length : 0,
    // Hashing the diff makes an uncommitted state comparable without ever
    // storing the code itself -- a record is meant to be shareable.
    diffSha256: status.length > 0 ? sha256(diff) : null,
  };
}

/**
 * The machine, described without identifying its owner.
 *
 * Hostname and username are deliberately absent. A record is something you
 * attach to a ticket or paste into a pull request; it should not carry who was
 * sitting at the keyboard.
 */
export function machineContext() {
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    cpus: os.cpus().length,
    node: process.version,
  };
}

/** Digest a list of files, so a record can name its inputs and outputs. */
export async function digestFiles(cwd, relpaths) {
  const results = [];
  for (const relpath of relpaths) {
    const absolute = path.resolve(cwd, relpath);
    try {
      const bytes = await fs.readFile(absolute);
      results.push({ path: relpath, bytes: bytes.length, sha256: sha256(bytes) });
    } catch (error) {
      results.push({ path: relpath, missing: true, error: error.code ?? String(error) });
    }
  }
  return results;
}
