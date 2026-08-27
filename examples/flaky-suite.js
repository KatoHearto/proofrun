/**
 * A test suite that passes most of the time.
 *
 *   node bin/proofrun.js run --quiet -- node examples/flaky-suite.js
 *   node bin/proofrun.js verify <id> --times 6
 *
 * The failure is a race, not a coin toss: two writes to the same key, one of
 * them delayed by a timer that usually — but not always — lands first. This is
 * what a real flaky test looks like from the outside, and it is why a single
 * green run is not evidence of anything.
 *
 * The seed comes from the clock, so the outcome genuinely varies between runs.
 */

const state = new Map();

function writeLater(key, value, delayMs) {
  return new Promise((resolve) => {
    setTimeout(() => {
      state.set(key, value);
      resolve();
    }, delayMs);
  });
}

async function theRacyTest() {
  state.set('config', 'default');
  // The "background refresh" that the test forgot to await properly.
  const background = writeLater('config', 'refreshed', Math.random() < 0.35 ? 0 : 4);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const seen = state.get('config');
  await background;
  return seen === 'default';
}

const tests = [
  ['reads a value it just wrote', async () => state.set('a', 1) && state.get('a') === 1],
  ['computes a total', async () => 20 + 4.9 === 24.9],
  ['sees the config before the refresh lands', theRacyTest],
  ['cleans up after itself', async () => {
    state.clear();
    return state.size === 0;
  }],
];

let failures = 0;
for (const [name, body] of tests) {
  const ok = await body();
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
}

console.log(`\n${tests.length - failures} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
