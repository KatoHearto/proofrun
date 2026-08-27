/**
 * Making output comparable, and being explicit about the cost.
 *
 * Almost no real command produces byte-identical output twice: timestamps,
 * durations, process ids, temporary paths and colour codes all change on every
 * run. Hashing raw output would mean nothing ever verifies, and the tool would
 * be useless.
 *
 * So output is normalised first. But every normaliser is a decision to **stop
 * looking** at something, and a decision to stop looking is exactly the kind of
 * thing that quietly turns a proof into a ritual. Each one therefore has a
 * name, is listed in the record it produced, and is reported back on every
 * verify -- so the reader can always see what was ignored on their behalf.
 */

export const NORMALISERS = [
  {
    name: 'ansi-colour',
    why: 'colour codes depend on whether a terminal is attached',
    // eslint-disable-next-line no-control-regex
    pattern: /\u001b\[[0-9;]*m/g,
    replacement: '',
  },
  {
    name: 'carriage-returns',
    why: 'line endings differ between platforms and shells',
    pattern: /\r\n?/g,
    replacement: '\n',
  },
  {
    name: 'iso-timestamps',
    why: 'a timestamp is different every run by definition',
    pattern: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    replacement: '<timestamp>',
  },
  {
    name: 'clock-times',
    why: 'bare wall-clock times move too',
    pattern: /\b\d{2}:\d{2}:\d{2}\b/g,
    replacement: '<time>',
  },
  {
    name: 'labelled-durations',
    why:
      'timings reported as a labelled field (duration_ms: 57.77) change every run — ' +
      'this is how most test runners print them, so without it a perfectly ordinary ' +
      'test suite could never be verified at all',
    // The separator is optional on purpose: node's own TAP summary prints
    // `# duration_ms 3396.35` with nothing but a space, and requiring a colon
    // was enough to make an ordinary `node --test` run unverifiable. Measured,
    // not guessed -- it is the line that broke this tool's own first verify.
    pattern:
      /\b(duration|elapsed|runtime|took|time)(_ms|_s|_seconds|_sec)?(?:\s*[=:]\s*|\s+)\d+(?:[.,]\d+)?/gi,
    replacement: '$1$2=<duration>',
  },
  {
    name: 'durations',
    why: 'a machine under load reports different durations for identical work',
    pattern: /\b\d+(?:[.,]\d+)?\s?(?:ms|s|sec|secs|seconds|m|min|mins)\b/gi,
    replacement: '<duration>',
  },
  {
    name: 'process-ids',
    why: 'pids are assigned by the operating system',
    pattern: /\b(pid|PID)[=: ]\s*\d+/g,
    replacement: '$1=<pid>',
  },
  {
    name: 'ports',
    why: 'an ephemeral port is chosen at random',
    pattern: /\b(localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b/g,
    replacement: '$1:<port>',
  },
  {
    name: 'temp-paths',
    why: 'temporary directories carry a random component',
    pattern: /(?:\/tmp\/|\/var\/folders\/|[A-Za-z]:\\+(?:Users\\+[^\\\s]+\\+)?AppData\\+Local\\+Temp\\+)[^\s"']*/g,
    replacement: '<tmp>',
  },
  {
    name: 'hex-ids',
    why: 'run ids, container ids and object hashes change every time',
    pattern: /\b[0-9a-f]{12,64}\b/g,
    replacement: '<hex>',
  },
  {
    name: 'trailing-space',
    why: 'invisible and not evidence of anything',
    pattern: /[ \t]+$/gm,
    replacement: '',
  },
];

export const NORMALISER_NAMES = NORMALISERS.map((normaliser) => normaliser.name);

/**
 * Apply normalisers to text.
 *
 * `cwd`, when given, is replaced first: an absolute path is the single most
 * common reason two identical runs disagree, and it is also the one piece of
 * noise that identifies the person who ran it.
 */
export function normalise(text, { cwd = null, only = null } = {}) {
  let output = String(text);

  if (cwd) {
    for (const variant of pathVariants(cwd)) {
      output = output.split(variant).join('<cwd>');
    }
  }

  const applied = [];
  for (const normaliser of NORMALISERS) {
    if (only && !only.includes(normaliser.name)) continue;
    const before = output;
    output = output.replace(normaliser.pattern, normaliser.replacement);
    if (output !== before) applied.push(normaliser.name);
  }

  return { text: output, applied };
}

/** The same directory as it may appear in output: native, POSIX, and escaped. */
function pathVariants(cwd) {
  const native = String(cwd);
  const posix = native.replace(/\\/g, '/');
  const doubled = native.replace(/\\/g, '\\\\');
  return [...new Set([native, posix, doubled])].sort((a, b) => b.length - a.length);
}

export function describeNormalisers(names) {
  return NORMALISERS.filter((normaliser) => names.includes(normaliser.name)).map(
    (normaliser) => `${normaliser.name} — ${normaliser.why}`
  );
}
