import { describeNormalisers } from './normalise.js';
import { strength } from './record.js';

export class Style {
  constructor(enabled) {
    this.enabled =
      enabled ??
      (process.stdout.isTTY === true &&
        !process.env.NO_COLOR &&
        process.env.TERM !== 'dumb');
  }
  wrap(code, text) {
    return this.enabled ? `[${code}m${text}[0m` : text;
  }
  bold(t) { return this.wrap('1', t); }
  dim(t) { return this.wrap('2', t); }
  red(t) { return this.wrap('31', t); }
  green(t) { return this.wrap('32', t); }
  yellow(t) { return this.wrap('33', t); }
  cyan(t) { return this.wrap('36', t); }
}

const seconds = (ms) => `${(ms / 1000).toFixed(2)}s`;

export function renderRecord(record, style) {
  const lines = [];
  const ok = record.exitCode === 0;

  lines.push('');
  lines.push(
    `${style.bold('proofrun')} ${style.cyan(record.id)}  ` +
      style.dim(record.startedAt.replace('T', ' ').replace(/\..*/, ' UTC'))
  );
  lines.push(`  ${style.dim('$')} ${record.command.join(' ')}`);
  lines.push('');
  lines.push(
    `  exit ${ok ? style.green(String(record.exitCode)) : style.red(String(record.exitCode))}` +
      `   ${seconds(record.durationMs)}   ` +
      style.dim(`${record.output.lines} lines of output`)
  );

  if (record.timedOut) {
    lines.push(`  ${style.red('killed by the timeout')}`);
  }
  if (record.spawnError) {
    lines.push(`  ${style.red(`could not start: ${record.spawnError}`)}`);
  }

  lines.push(
    `  output  ${style.dim(record.output.normalisedSha256.slice(0, 16))} ` +
      style.dim(`(normalised)`)
  );

  if (record.git?.available) {
    const dirt = record.git.dirty
      ? style.yellow(`dirty, ${record.git.changedFiles} file(s) uncommitted`)
      : style.green('clean');
    lines.push(`  git     ${record.git.commit.slice(0, 8)} on ${record.git.branch} — ${dirt}`);
    if (record.git.dirty) {
      lines.push(
        style.yellow(
          '          this record does not bind that commit: what ran is not what is committed'
        )
      );
    }
  } else {
    lines.push(`  git     ${style.dim('not a repository — nothing binds this to a version')}`);
  }

  lines.push(
    `  machine ${record.machine.platform}/${record.machine.arch} · node ${record.machine.node}`
  );

  if (record.files.length > 0) {
    lines.push('');
    lines.push(`  ${style.bold('files')}`);
    for (const file of record.files) {
      lines.push(
        file.missing
          ? `    ${style.red('missing')}  ${file.path}`
          : `    ${style.dim(file.sha256.slice(0, 12))}  ${file.path} ${style.dim(`(${file.bytes} B)`)}`
      );
    }
  }

  const measure = strength(record);
  lines.push('');
  lines.push(`  ${style.dim(`strength: ${measure.level} — ${measure.detail}`)}`);
  lines.push('');
  return lines.join('\n');
}

const truncate = (text, width = 88) =>
  text.length > width ? `${text.slice(0, width)}…` : text;

export function renderComparison(
  original,
  fresh,
  comparison,
  style,
  { verbose = false, outputDiff = null } = {}
) {
  const lines = [];
  lines.push('');
  lines.push(
    `${style.bold('verify')} ${style.cyan(original.id)}  ${style.dim(original.command.join(' '))}`
  );
  lines.push('');

  const failures = comparison.differences.filter((d) => d.severity === 'fail');
  const notes = comparison.differences.filter((d) => d.severity === 'note');

  for (const note of notes) {
    lines.push(`  ${style.yellow('note')}  ${note.detail}`);
    lines.push(`        ${style.dim(`${note.was}  →  ${note.now}`)}`);
  }
  if (notes.length > 0) lines.push('');

  if (comparison.matches) {
    lines.push(
      `  ${style.green(style.bold('REPRODUCED'))} — exit ${fresh.exitCode}, ` +
        `output identical after normalisation`
    );
    const measure = strength(fresh);
    lines.push(`  ${style.dim(`strength: ${measure.level} — ${measure.detail}`)}`);
  } else {
    lines.push(`  ${style.red(style.bold('DIFFERENT'))}`);
    for (const failure of failures) {
      lines.push(`    ${style.red('•')} ${failure.detail}`);
      lines.push(`      ${style.dim(`${failure.was}  →  ${failure.now}`)}`);
    }

    if (outputDiff && outputDiff.lines.length > 0) {
      lines.push('');
      lines.push(
        `  ${style.bold('where the output parts company')} ` +
          style.dim(`(${outputDiff.differing} of ${outputDiff.total} lines differ)`)
      );
      for (const entry of outputDiff.lines) {
        lines.push(`    ${style.dim(`line ${entry.line}`)}`);
        lines.push(`      ${style.red('-')} ${truncate(entry.was)}`);
        lines.push(`      ${style.green('+')} ${truncate(entry.now)}`);
      }
      if (outputDiff.differing > outputDiff.lines.length) {
        lines.push(
          style.dim(`    ... and ${outputDiff.differing - outputDiff.lines.length} more lines`)
        );
      }
    }
  }

  if (verbose || !comparison.matches) {
    lines.push('');
    lines.push(`  ${style.dim('what was ignored when comparing the output:')}`);
    const applied = describeNormalisers(fresh.output.normalisersApplied);
    if (applied.length === 0) {
      lines.push(`    ${style.dim('nothing — the bytes were compared as they came out')}`);
    } else {
      for (const description of applied) lines.push(`    ${style.dim(description)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

export function renderRepeats(results, style) {
  const lines = [];
  const reproduced = results.filter((result) => result.matches).length;
  const total = results.length;

  lines.push('');
  lines.push(`  ${reproduced} of ${total} runs reproduced the record`);

  if (reproduced === total) {
    lines.push(`  ${style.green(style.bold('STABLE'))} — every repeat agreed`);
  } else if (reproduced === 0) {
    lines.push(
      `  ${style.red(style.bold('CHANGED'))} — no repeat matched. Something really is different.`
    );
  } else {
    lines.push(
      `  ${style.yellow(style.bold('FLAKY'))} — the same command in the same tree ` +
        `gave two different answers.`
    );
    lines.push(
      style.dim(
        '  That is a stronger finding than either a pass or a fail: a result that is not\n' +
          '  repeatable was never evidence, whichever way it landed.'
      )
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function renderList(records, style) {
  if (records.length === 0) {
    return `\n  ${style.dim('no records yet — run: proofrun run -- <your command>')}\n`;
  }
  const lines = [''];
  for (const record of records) {
    const ok = record.exitCode === 0;
    const mark = ok ? style.green('✓') : style.red('✗');
    const dirt = record.git?.dirty ? style.yellow(' dirty') : '';
    lines.push(
      `  ${mark} ${style.cyan(record.id)}  ` +
        `${style.dim(record.startedAt.slice(0, 16).replace('T', ' '))}  ` +
        `${seconds(record.durationMs).padStart(7)}  ` +
        `${record.command.join(' ').slice(0, 48)}${dirt}`
    );
  }
  lines.push('');
  return lines.join('\n');
}
