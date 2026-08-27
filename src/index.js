import path from 'node:path';

import { normalise } from './normalise.js';
import { compare, outputDifferences, recordRun } from './record.js';
import {
  Style,
  renderComparison,
  renderList,
  renderRecord,
  renderRepeats,
} from './report.js';
import {
  listRecords,
  loadOutput,
  resolveId,
  saveRecord,
} from './store.js';

export const EXIT_OK = 0;
export const EXIT_COMMAND_FAILED = 1;
export const EXIT_DIFFERENT = 1;
export const EXIT_MISUSE = 2;

const USAGE = `proofrun — turn a command run into a record you can check later

Usage:
  proofrun run [options] -- <command> [args...]   run it and record what happened
  proofrun verify <id> [options]                  run it again and compare
  proofrun list                                   the records in this directory
  proofrun show <id> [--output]                   one record in full

Options for run:
  --file <path>      digest this file as part of the record, repeatable
  --timeout <secs>   kill the command after this long
  --quiet            do not stream the command's output

Options for verify:
  --times <n>        repeat n times; disagreement between repeats is flakiness
  --verbose          list what was ignored when comparing

Common:
  --cwd <dir>        where to run and where .proofrun/ lives (default: .)
  --json             machine-readable output
  --no-color         plain output
  --help, --version

Exit codes:
  0  recorded, or reproduced
  1  the command failed, or the result did not reproduce
  2  misuse
`;

export function parseArguments(argv) {
  const options = {
    command: null,
    id: null,
    argv: [],
    files: [],
    timeout: null,
    times: 1,
    cwd: '.',
    json: false,
    quiet: false,
    verbose: false,
    color: null,
    showOutput: false,
    help: false,
    version: false,
  };

  const separator = argv.indexOf('--');
  const head = separator === -1 ? argv : argv.slice(0, separator);
  options.argv = separator === -1 ? [] : argv.slice(separator + 1);

  for (let index = 0; index < head.length; index += 1) {
    const argument = head[index];
    const next = () => {
      const value = head[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} needs a value`);
      }
      index += 1;
      return value;
    };

    switch (argument) {
      case '--file': options.files.push(next()); break;
      case '--timeout': {
        const value = Number(next());
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error('--timeout needs a positive number of seconds');
        }
        options.timeout = value;
        break;
      }
      case '--times': {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 1) {
          throw new Error('--times needs a positive integer');
        }
        options.times = value;
        break;
      }
      case '--cwd': options.cwd = next(); break;
      case '--json': options.json = true; break;
      case '--quiet': options.quiet = true; break;
      case '--verbose': options.verbose = true; break;
      case '--output': options.showOutput = true; break;
      case '--no-color': options.color = false; break;
      case '--help': case '-h': options.help = true; break;
      case '--version': case '-v': options.version = true; break;
      default:
        if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}`);
        if (options.command === null) options.command = argument;
        else if (options.id === null) options.id = argument;
        else throw new Error(`unexpected argument: ${argument}`);
    }
  }

  return options;
}

export async function run(argv, { out = console.log, err = console.error, write } = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    err(`error: ${error.message}`);
    err('');
    err(USAGE);
    return EXIT_MISUSE;
  }

  if (options.help || (!options.command && !options.version)) {
    out(USAGE);
    return options.command ? EXIT_OK : options.help ? EXIT_OK : EXIT_MISUSE;
  }
  if (options.version) {
    out('proofrun 0.1.0');
    return EXIT_OK;
  }

  const style = new Style(options.color === false ? false : undefined);
  const cwd = path.resolve(options.cwd);

  switch (options.command) {
    case 'run': return commandRun(options, { cwd, style, out, err, write });
    case 'verify': return commandVerify(options, { cwd, style, out, err });
    case 'list': return commandList(options, { cwd, style, out });
    case 'show': return commandShow(options, { cwd, style, out, err });
    default:
      err(`error: unknown command "${options.command}"`);
      err('');
      err(USAGE);
      return EXIT_MISUSE;
  }
}

async function commandRun(options, { cwd, style, out, err, write }) {
  if (options.argv.length === 0) {
    err('error: nothing to run — put the command after --');
    err('       proofrun run -- pytest -q');
    return EXIT_MISUSE;
  }

  const record = await recordRun(options.argv, {
    cwd,
    timeout: options.timeout,
    files: options.files,
  });

  if (!options.quiet && !options.json && record.rawOutput) {
    (write ?? ((text) => process.stdout.write(text)))(record.rawOutput);
  }

  const stored = await saveRecord(cwd, record);

  if (options.json) {
    out(JSON.stringify(stripOutput(stored), null, 2));
  } else {
    out(renderRecord(stored, style));
  }

  return stored.exitCode === 0 ? EXIT_OK : EXIT_COMMAND_FAILED;
}

async function commandVerify(options, { cwd, style, out, err }) {
  if (!options.id) {
    err('error: which record? — proofrun verify <id>');
    return EXIT_MISUSE;
  }

  const resolved = await resolveId(cwd, options.id);
  if (resolved.error) {
    err(`error: ${resolved.error}`);
    return EXIT_MISUSE;
  }
  const original = resolved.record;

  const results = [];
  for (let attempt = 0; attempt < options.times; attempt += 1) {
    const fresh = await recordRun(original.command, {
      cwd,
      timeout: options.timeout,
      files: original.files.map((file) => file.path),
    });
    results.push({ fresh, ...compare(original, fresh) });
  }

  const last = results[results.length - 1];

  if (options.json) {
    out(
      JSON.stringify(
        {
          id: original.id,
          command: original.command,
          times: options.times,
          reproduced: results.filter((result) => result.matches).length,
          stable: results.every((result) => result.matches === results[0].matches),
          results: results.map((result) => ({
            matches: result.matches,
            exitCode: result.fresh.exitCode,
            differences: result.differences,
          })),
        },
        null,
        2
      )
    );
  } else {
    let outputDiff = null;
    if (!last.matches) {
      const storedOutput = await loadOutput(cwd, original.id);
      if (storedOutput !== null) {
        outputDiff = outputDifferences(
          normalise(storedOutput, { cwd }).text,
          normalise(last.fresh.rawOutput, { cwd }).text
        );
      }
    }
    out(
      renderComparison(original, last.fresh, last, style, {
        verbose: options.verbose,
        outputDiff,
      })
    );
    if (options.times > 1) out(renderRepeats(results, style));
  }

  const allMatched = results.every((result) => result.matches);
  return allMatched ? EXIT_OK : EXIT_DIFFERENT;
}

async function commandList(options, { cwd, style, out }) {
  const records = await listRecords(cwd);
  if (options.json) {
    out(JSON.stringify(records.map(stripOutput), null, 2));
  } else {
    out(renderList(records, style));
  }
  return EXIT_OK;
}

async function commandShow(options, { cwd, style, out, err }) {
  if (!options.id) {
    err('error: which record? — proofrun show <id>');
    return EXIT_MISUSE;
  }
  const resolved = await resolveId(cwd, options.id);
  if (resolved.error) {
    err(`error: ${resolved.error}`);
    return EXIT_MISUSE;
  }

  if (options.json) {
    out(JSON.stringify(stripOutput(resolved.record), null, 2));
    return EXIT_OK;
  }

  out(renderRecord(resolved.record, style));
  if (options.showOutput) {
    const output = await loadOutput(cwd, resolved.record.id);
    out(output ?? style.dim('  (the captured output is no longer on disk)'));
  }
  return EXIT_OK;
}

/** The stored output lives in its own file; repeating it in JSON helps nobody. */
function stripOutput(record) {
  const { rawOutput, ...rest } = record;
  return rest;
}

export { USAGE };
