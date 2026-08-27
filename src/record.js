import { digestFiles, gitContext, machineContext, sha256 } from './context.js';
import { normalise } from './normalise.js';
import { execute } from './runner.js';

/**
 * Run a command and build the record of it.
 *
 * Two digests are kept, and the difference between them is the whole design:
 *
 *   `rawSha256`         the bytes exactly as they came out
 *   `normalisedSha256`  the bytes after the noise was removed
 *
 * Verification compares the normalised digest, because nothing would ever
 * match otherwise. The raw digest is kept anyway so that "identical to the
 * byte" remains a statement anybody can check afterwards, rather than a claim
 * the tool quietly stopped making.
 */
export async function recordRun(argv, { cwd, timeout = null, files = [], now = null } = {}) {
  const startedAt = (now ?? new Date()).toISOString();
  const outcome = await execute(argv, { cwd, timeout });
  const finishedAt = new Date(
    new Date(startedAt).getTime() + Math.round(outcome.durationMs)
  ).toISOString();

  const normalised = normalise(outcome.output, { cwd });

  return {
    command: argv,
    cwd,
    startedAt,
    finishedAt,
    durationMs: Math.round(outcome.durationMs),
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    spawnError: outcome.spawnError,
    output: {
      bytes: Buffer.byteLength(outcome.output, 'utf8'),
      lines: outcome.output === '' ? 0 : outcome.output.split('\n').length,
      rawSha256: sha256(outcome.output),
      normalisedSha256: sha256(normalised.text),
      normalisersApplied: normalised.applied,
    },
    git: gitContext(cwd),
    machine: machineContext(),
    files: await digestFiles(cwd, files),
    rawOutput: outcome.output,
  };
}

/**
 * The first few lines where two normalised outputs part company.
 *
 * "The output is different" is a fact; it is not yet useful. A verdict that
 * cannot point at the line it is about sends the reader off to diff two files
 * by hand, which is precisely the work this tool was supposed to do for them.
 */
export function outputDifferences(before, after, { limit = 5 } = {}) {
  const left = before.split('\n');
  const right = after.split('\n');
  const found = [];

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue;
    found.push({
      line: index + 1,
      was: left[index] ?? '(end of output)',
      now: right[index] ?? '(end of output)',
    });
    if (found.length >= limit) break;
  }

  const total = Math.max(left.length, right.length);
  let differing = 0;
  for (let index = 0; index < total; index += 1) {
    if (left[index] !== right[index]) differing += 1;
  }

  return { lines: found, differing, total };
}

export const DIFFERENCE = {
  EXIT_CODE: 'exit-code',
  OUTPUT: 'output',
  FILES: 'files',
  COMMIT: 'commit',
  MACHINE: 'machine',
};

/**
 * Compare a fresh run against a stored record.
 *
 * `matches` is deliberately narrow: the exit code and the normalised output.
 * A different commit or a different machine is *reported* but does not on its
 * own make a verification fail -- reproducing a result on another machine is
 * usually the point, and folding it into the verdict would make every
 * cross-platform check red for the wrong reason.
 */
export function compare(original, fresh) {
  const differences = [];

  if (original.exitCode !== fresh.exitCode) {
    differences.push({
      kind: DIFFERENCE.EXIT_CODE,
      severity: 'fail',
      was: original.exitCode,
      now: fresh.exitCode,
      detail: `exit code ${original.exitCode} became ${fresh.exitCode}`,
    });
  }

  if (original.output.normalisedSha256 !== fresh.output.normalisedSha256) {
    differences.push({
      kind: DIFFERENCE.OUTPUT,
      severity: 'fail',
      was: original.output.normalisedSha256.slice(0, 12),
      now: fresh.output.normalisedSha256.slice(0, 12),
      detail:
        `output differs beyond the ${original.output.normalisersApplied.length} ` +
        'normaliser(s) that were applied',
    });
  }

  const originalFiles = new Map(original.files.map((file) => [file.path, file]));
  for (const file of fresh.files) {
    const before = originalFiles.get(file.path);
    if (!before) continue;
    if (before.sha256 !== file.sha256) {
      differences.push({
        kind: DIFFERENCE.FILES,
        severity: 'fail',
        was: before.missing ? 'missing' : before.sha256.slice(0, 12),
        now: file.missing ? 'missing' : file.sha256.slice(0, 12),
        detail: `${file.path} came out different`,
      });
    }
  }

  if (original.git?.available && fresh.git?.available) {
    if (original.git.commit !== fresh.git.commit) {
      differences.push({
        kind: DIFFERENCE.COMMIT,
        severity: 'note',
        was: original.git.commit.slice(0, 8),
        now: fresh.git.commit.slice(0, 8),
        detail: 'a different commit — this is a comparison across versions, not a repeat',
      });
    } else if (original.git.diffSha256 !== fresh.git.diffSha256) {
      differences.push({
        kind: DIFFERENCE.COMMIT,
        severity: 'note',
        was: original.git.diffSha256 ? 'dirty' : 'clean',
        now: fresh.git.diffSha256 ? 'dirty' : 'clean',
        detail: 'the same commit, but different uncommitted changes',
      });
    }
  }

  if (
    original.machine.platform !== fresh.machine.platform ||
    original.machine.arch !== fresh.machine.arch
  ) {
    differences.push({
      kind: DIFFERENCE.MACHINE,
      severity: 'note',
      was: `${original.machine.platform}/${original.machine.arch}`,
      now: `${fresh.machine.platform}/${fresh.machine.arch}`,
      detail: 'a different machine — reproducing here is a stronger result, not a weaker one',
    });
  }

  return {
    matches: differences.every((difference) => difference.severity !== 'fail'),
    differences,
  };
}

/**
 * How much of the verdict rests on ignored noise.
 *
 * A record whose output only matches because ten normalisers rewrote it is a
 * weaker claim than one that matches byte for byte, and the report says which
 * of the two it is holding.
 */
export function strength(record) {
  const applied = record.output.normalisersApplied.length;
  if (applied === 0) {
    return {
      level: 'exact',
      detail: 'no noise had to be ignored, so the raw bytes are what is hashed',
    };
  }
  if (applied <= 3) {
    return {
      level: 'strong',
      detail: `${applied} normaliser(s) removed noise before the output was hashed`,
    };
  }
  return {
    level: 'loose',
    detail:
      `${applied} normalisers rewrote this output before it was hashed — ` +
      'a match here says less than it looks like',
  };
}
