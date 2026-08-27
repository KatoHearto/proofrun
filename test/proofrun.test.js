import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { compare, recordRun, strength } from '../src/record.js';
import { NORMALISER_NAMES, normalise } from '../src/normalise.js';
import { EXIT_DIFFERENT, EXIT_MISUSE, EXIT_OK, parseArguments, run } from '../src/index.js';
import { listRecords, recordId, resolveId, saveRecord } from '../src/store.js';

const PY = process.execPath; // node itself: always present, always scriptable

const made = [];
async function workspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proofrun-'));
  made.push(dir);
  return dir;
}
after(async () => {
  for (const dir of made) await fs.rm(dir, { recursive: true, force: true });
});

function capture() {
  const lines = [];
  return { sink: (text = '') => lines.push(String(text)), text: () => lines.join('\n') };
}

// A script whose output is deliberately full of the noise normalisers exist for.
const NOISY = [
  'console.log("started at " + new Date().toISOString());',
  'console.log("pid=" + process.pid);',
  'console.log("took " + (Math.random() * 10).toFixed(2) + "s");',
  'console.log("RESULT: 42");',
].join('\n');

describe('normalising', () => {
  it('removes the noise a rerun would always change', () => {
    const { text, applied } = normalise(
      'at 2026-08-27T05:00:00Z pid=91 took 1.2s on port localhost:53412'
    );
    assert.match(text, /<timestamp>/);
    assert.match(text, /pid=<pid>/);
    assert.match(text, /<duration>/);
    assert.match(text, /localhost:<port>/);
    assert.ok(applied.length >= 4);
  });

  it('reports which normalisers it used, and only those', () => {
    const { applied } = normalise('nothing interesting here');
    assert.deepEqual(applied, []);
    for (const name of normalise('at 2026-08-27T05:00:00Z').applied) {
      assert.ok(NORMALISER_NAMES.includes(name));
    }
  });

  it('replaces the working directory, which also removes who ran it', () => {
    // portlint-ignore: this path is the fixture, not a dependency
    const cwd = '/home/someone/projects/thing';
    const { text } = normalise(`error in ${cwd}/src/a.js`, { cwd });
    assert.equal(text, 'error in <cwd>/src/a.js');
    assert.ok(!text.includes('someone'));
  });

  it('handles a Windows cwd in both slash conventions', () => {
    const cwd = 'C:\\work\\thing';
    const { text } = normalise('failed at C:\\work\\thing\\a.js and C:/work/thing/b.js', { cwd });
    assert.equal(text, 'failed at <cwd>\\a.js and <cwd>/b.js');
  });

  it('normalises a labelled duration, the form most test runners print', () => {
    // Without this, an ordinary `node --test` or pytest run could never verify:
    // every line carrying a timing would differ on every single execution.
    const { text, applied } = normalise('duration_ms: 57.7713\n  elapsed = 3.4');
    assert.match(text, /duration_ms=<duration>/);
    assert.match(text, /elapsed=<duration>/);
    assert.ok(applied.includes('labelled-durations'));
  });

  it('leaves real content alone', () => {
    const { text } = normalise('RESULT: 42\n7 tests passed');
    assert.match(text, /RESULT: 42/);
    assert.match(text, /7 tests passed/);
  });
});

describe('recording a run', () => {
  it('captures the exit code, the output and a digest of both forms', async () => {
    const cwd = await workspace();
    const record = await recordRun([PY, '-e', 'console.log("hello"); process.exit(3)'], { cwd });

    assert.equal(record.exitCode, 3);
    assert.match(record.rawOutput, /hello/);
    assert.equal(record.output.rawSha256.length, 64);
    assert.notEqual(record.output.rawSha256, record.output.normalisedSha256.slice(0, 0));
    assert.ok(record.durationMs >= 0);
  });

  it('digests the files it was told to watch', async () => {
    const cwd = await workspace();
    await fs.writeFile(path.join(cwd, 'out.txt'), 'the artefact');

    const record = await recordRun([PY, '-e', 'process.exit(0)'], {
      cwd,
      files: ['out.txt', 'not-there.txt'],
    });

    const [present, absent] = record.files;
    assert.equal(present.bytes, 12);
    assert.equal(present.sha256.length, 64);
    assert.equal(absent.missing, true);
  });

  it('says so when there is no repository to bind to', async () => {
    const cwd = await workspace();
    const record = await recordRun([PY, '-e', '0'], { cwd });
    assert.equal(record.git.available, false);
  });

  it('carries no hostname or username', async () => {
    const cwd = await workspace();
    const record = await recordRun([PY, '-e', '0'], { cwd });
    const asText = JSON.stringify(record.machine);

    assert.ok(!asText.includes(os.hostname()));
    assert.ok(!Object.keys(record.machine).some((key) => /user|host|home/i.test(key)));
  });

  it('kills a command that overruns its timeout', async () => {
    const cwd = await workspace();
    const record = await recordRun([PY, '-e', 'setTimeout(() => {}, 30000)'], {
      cwd,
      timeout: 1,
    });
    assert.equal(record.timedOut, true);
  });

  it('records a command that could not start instead of crashing', async () => {
    const cwd = await workspace();
    const record = await recordRun(['definitely-not-a-real-binary-xyz'], { cwd });

    assert.equal(record.exitCode, null);
    assert.ok(record.spawnError);
  });
});

describe('comparing', () => {
  it('reproduces a run whose only differences are noise', async () => {
    const cwd = await workspace();
    await fs.writeFile(path.join(cwd, 'noisy.js'), NOISY);

    const first = await recordRun([PY, 'noisy.js'], { cwd });
    const second = await recordRun([PY, 'noisy.js'], { cwd });

    assert.notEqual(
      first.output.rawSha256,
      second.output.rawSha256,
      'the raw bytes really do differ — otherwise this test proves nothing'
    );
    assert.equal(compare(first, second).matches, true);
  });

  it('refuses to call it reproduced when the real content changed', async () => {
    const cwd = await workspace();
    await fs.writeFile(path.join(cwd, 'a.js'), 'console.log("RESULT: 42");');
    const first = await recordRun([PY, 'a.js'], { cwd });

    await fs.writeFile(path.join(cwd, 'a.js'), 'console.log("RESULT: 43");');
    const second = await recordRun([PY, 'a.js'], { cwd });

    const comparison = compare(first, second);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.differences.some((d) => d.kind === 'output'));
  });

  it('fails on a changed exit code', async () => {
    const cwd = await workspace();
    const first = await recordRun([PY, '-e', 'process.exit(0)'], { cwd });
    const second = await recordRun([PY, '-e', 'process.exit(1)'], { cwd });

    const comparison = compare(first, second);
    assert.equal(comparison.matches, false);
    assert.equal(comparison.differences[0].kind, 'exit-code');
  });

  it('fails when a watched file came out different', async () => {
    const cwd = await workspace();
    const script = 'require("fs").writeFileSync("out.txt", process.argv[2]);';

    await fs.writeFile(path.join(cwd, 'w.js'), script);
    const first = await recordRun([PY, 'w.js', 'one'], { cwd, files: ['out.txt'] });
    const second = await recordRun([PY, 'w.js', 'two'], { cwd, files: ['out.txt'] });

    const comparison = compare(first, second);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.differences.some((d) => d.kind === 'files'));
  });

  it('treats a different machine as a note, not a failure', async () => {
    const cwd = await workspace();
    const first = await recordRun([PY, '-e', 'console.log("same")'], { cwd });
    const second = await recordRun([PY, '-e', 'console.log("same")'], { cwd });
    second.machine = { ...second.machine, platform: 'aix', arch: 's390x' };

    const comparison = compare(first, second);
    assert.equal(
      comparison.matches,
      true,
      'reproducing on another machine is a stronger result, not a failed one'
    );
    assert.equal(comparison.differences[0].severity, 'note');
  });
});

describe('how much a match is worth', () => {
  const record = (applied) => ({ output: { normalisersApplied: applied } });

  it('calls a byte-for-byte match exact', () => {
    assert.equal(strength(record([])).level, 'exact');
  });

  it('calls a heavily rewritten match loose, and says why', () => {
    const measure = strength(record(NORMALISER_NAMES));
    assert.equal(measure.level, 'loose');
    assert.match(measure.detail, /says less than it looks like/);
  });
});

describe('the store', () => {
  it('derives an id from what the record is', () => {
    const base = { command: ['a'], cwd: '/x', startedAt: '2026-01-01T00:00:00Z' };
    assert.equal(recordId(base), recordId({ ...base }));
    assert.notEqual(recordId(base), recordId({ ...base, startedAt: '2026-01-02T00:00:00Z' }));
  });

  it('refuses an ambiguous id prefix instead of picking one', async () => {
    const cwd = await workspace();
    const shared = { command: ['x'], cwd, exitCode: 0, durationMs: 1, files: [], output: {} };
    await saveRecord(cwd, { ...shared, id: 'abc111', startedAt: '2026-01-01T00:00:00Z' });
    await saveRecord(cwd, { ...shared, id: 'abc222', startedAt: '2026-01-02T00:00:00Z' });

    const resolved = await resolveId(cwd, 'abc');
    assert.match(resolved.error, /matches 2 records/);
    assert.equal(resolved.record, undefined);
  });

  it('resolves an unambiguous prefix', async () => {
    const cwd = await workspace();
    await saveRecord(cwd, {
      id: 'deadbeef',
      command: ['x'],
      cwd,
      startedAt: '2026-01-01T00:00:00Z',
      exitCode: 0,
      durationMs: 1,
      files: [],
      output: {},
    });
    assert.equal((await resolveId(cwd, 'dead')).record.id, 'deadbeef');
  });

  it('lists newest first', async () => {
    const cwd = await workspace();
    const base = { command: ['x'], cwd, exitCode: 0, durationMs: 1, files: [], output: {} };
    await saveRecord(cwd, { ...base, id: 'old', startedAt: '2026-01-01T00:00:00Z' });
    await saveRecord(cwd, { ...base, id: 'new', startedAt: '2026-06-01T00:00:00Z' });

    assert.deepEqual((await listRecords(cwd)).map((r) => r.id), ['new', 'old']);
  });
});

describe('the command line', () => {
  it('splits options from the command at --', () => {
    const options = parseArguments(['run', '--quiet', '--', 'pytest', '-q', '--tb=short']);
    assert.equal(options.command, 'run');
    assert.deepEqual(options.argv, ['pytest', '-q', '--tb=short']);
    assert.equal(options.quiet, true);
  });

  it('does not eat the command own flags', () => {
    const options = parseArguments(['run', '--', 'npm', 'test', '--json']);
    assert.deepEqual(options.argv, ['npm', 'test', '--json']);
    assert.equal(options.json, false, "--json after -- belongs to the command, not to us");
  });

  it('rejects nonsense values', () => {
    assert.throws(() => parseArguments(['run', '--times', 'lots']), /positive integer/);
    assert.throws(() => parseArguments(['run', '--timeout', '-3']), /positive number/);
  });

  it('records, lists, shows and verifies', async () => {
    const cwd = await workspace();
    await fs.writeFile(path.join(cwd, 'noisy.js'), NOISY);
    const out = capture();

    assert.equal(
      await run(['run', '--cwd', cwd, '--quiet', '--no-color', '--', PY, 'noisy.js'], {
        out: out.sink,
      }),
      EXIT_OK
    );
    const id = (await listRecords(cwd))[0].id;

    out.sink('');
    assert.equal(await run(['list', '--cwd', cwd, '--no-color'], { out: out.sink }), EXIT_OK);
    assert.match(out.text(), new RegExp(id));

    const verify = capture();
    assert.equal(
      await run(['verify', id, '--cwd', cwd, '--no-color'], { out: verify.sink }),
      EXIT_OK
    );
    assert.match(verify.text(), /REPRODUCED/);
  });

  it('exits 1 and says DIFFERENT when the result changed', async () => {
    const cwd = await workspace();
    await fs.writeFile(path.join(cwd, 'a.js'), 'console.log("RESULT: 42");');
    const quiet = capture();
    await run(['run', '--cwd', cwd, '--quiet', '--no-color', '--', PY, 'a.js'], {
      out: quiet.sink,
    });
    const id = (await listRecords(cwd))[0].id;

    await fs.writeFile(path.join(cwd, 'a.js'), 'console.log("RESULT: 43");');
    const out = capture();
    const code = await run(['verify', id, '--cwd', cwd, '--no-color'], { out: out.sink });

    assert.equal(code, EXIT_DIFFERENT);
    assert.match(out.text(), /DIFFERENT/);
    assert.match(out.text(), /what was ignored when comparing/);
  });

  it('names flakiness for what it is', async () => {
    const cwd = await workspace();
    // Deterministic on the first run, then alternating: a coin flip on disk.
    await fs.writeFile(
      path.join(cwd, 'flaky.js'),
      [
        'const fs = require("fs");',
        'const n = fs.existsSync("count") ? Number(fs.readFileSync("count", "utf8")) : 0;',
        'fs.writeFileSync("count", String(n + 1));',
        'console.log("RESULT: " + (n % 2 === 0 ? "A" : "B"));',
      ].join('\n')
    );

    const quiet = capture();
    await run(['run', '--cwd', cwd, '--quiet', '--no-color', '--', PY, 'flaky.js'], {
      out: quiet.sink,
    });
    const id = (await listRecords(cwd))[0].id;

    const out = capture();
    const code = await run(
      ['verify', id, '--cwd', cwd, '--no-color', '--times', '4'],
      { out: out.sink }
    );

    assert.equal(code, EXIT_DIFFERENT);
    assert.match(out.text(), /FLAKY/);
    assert.match(out.text(), /was never evidence/);
  });

  it('is a misuse to run nothing', async () => {
    const cwd = await workspace();
    const err = capture();
    assert.equal(await run(['run', '--cwd', cwd], { err: err.sink }), EXIT_MISUSE);
    assert.match(err.text(), /nothing to run/);
  });

  it('is a misuse to verify an id that does not exist', async () => {
    const cwd = await workspace();
    const err = capture();
    assert.equal(await run(['verify', 'nope', '--cwd', cwd], { err: err.sink }), EXIT_MISUSE);
    assert.match(err.text(), /no record starts with/);
  });

  it('emits JSON without repeating the captured output', async () => {
    const cwd = await workspace();
    const out = capture();
    await run(
      ['run', '--cwd', cwd, '--json', '--', PY, '-e', 'console.log("x".repeat(100))'],
      { out: out.sink }
    );

    const payload = JSON.parse(out.text());
    assert.equal(payload.rawOutput, undefined);
    assert.equal(payload.output.bytes, 101);
  });
});
