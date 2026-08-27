import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { outputDifferences } from '../src/record.js';
import { normalise } from '../src/normalise.js';
import { EXIT_DIFFERENT, run } from '../src/index.js';
import { listRecords } from '../src/store.js';

const NODE = process.execPath;

const made = [];
async function workspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proofrun-diff-'));
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

describe('locating the difference', () => {
  it('names the line, the old text and the new text', () => {
    const diff = outputDifferences('a\nb\nc', 'a\nB\nc');
    assert.deepEqual(diff.lines, [{ line: 2, was: 'b', now: 'B' }]);
    assert.equal(diff.differing, 1);
    assert.equal(diff.total, 3);
  });

  it('counts every differing line but only shows the first few', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 40 }, (_, i) => `LINE ${i}`).join('\n');
    const diff = outputDifferences(before, after, { limit: 3 });

    assert.equal(diff.lines.length, 3);
    assert.equal(diff.differing, 40);
  });

  it('handles output that simply got longer', () => {
    const diff = outputDifferences('a', 'a\nb');
    assert.deepEqual(diff.lines, [{ line: 2, was: '(end of output)', now: 'b' }]);
  });

  it('finds nothing when the outputs agree', () => {
    assert.deepEqual(outputDifferences('same\nsame', 'same\nsame').lines, []);
  });
});

describe("node's own test summary", () => {
  it('is normalised — the line that broke this tool once', () => {
    // `# duration_ms 3396.3587`, space-separated, no colon. The first version
    // of the pattern required a colon, and this one line made an ordinary
    // `node --test` run impossible to verify.
    const { text, applied } = normalise('# duration_ms 3396.3587');
    assert.equal(text, '# duration_ms=<duration>');
    assert.ok(applied.includes('labelled-durations'));
  });

  it('normalises the colon form as well', () => {
    assert.equal(normalise('duration_ms: 57.77').text, 'duration_ms=<duration>');
  });

  it('does not eat a number that is not a timing', () => {
    const { text } = normalise('tests 41\npass 41\nfail 0');
    assert.match(text, /tests 41/);
    assert.match(text, /pass 41/);
  });
});

describe('verify shows the difference', () => {
  it('points at the exact line instead of only saying DIFFERENT', async () => {
    const cwd = await workspace();
    const script = (value) =>
      [
        'console.log("setting up");',
        `console.log("RESULT: ${value}");`,
        'console.log("done");',
      ].join('\n');

    await fs.writeFile(path.join(cwd, 'a.js'), script('42'));
    const quiet = capture();
    await run(['run', '--cwd', cwd, '--quiet', '--no-color', '--', NODE, 'a.js'], {
      out: quiet.sink,
    });
    const id = (await listRecords(cwd))[0].id;

    await fs.writeFile(path.join(cwd, 'a.js'), script('43'));
    const out = capture();
    const code = await run(['verify', id, '--cwd', cwd, '--no-color'], { out: out.sink });

    assert.equal(code, EXIT_DIFFERENT);
    const text = out.text();
    assert.match(text, /where the output parts company/);
    assert.match(text, /line 2/);
    assert.match(text, /- RESULT: 42/);
    assert.match(text, /\+ RESULT: 43/);
    assert.match(text, /1 of 4 lines differ/);
  });

  it('says nothing about a diff when the run reproduced', async () => {
    const cwd = await workspace();
    await fs.writeFile(path.join(cwd, 'a.js'), 'console.log("stable");');
    const quiet = capture();
    await run(['run', '--cwd', cwd, '--quiet', '--no-color', '--', NODE, 'a.js'], {
      out: quiet.sink,
    });
    const id = (await listRecords(cwd))[0].id;

    const out = capture();
    await run(['verify', id, '--cwd', cwd, '--no-color'], { out: out.sink });
    assert.match(out.text(), /REPRODUCED/);
    assert.ok(!out.text().includes('parts company'));
  });
});
