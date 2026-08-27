import { spawn } from 'node:child_process';

/**
 * Run a command and capture everything about it.
 *
 * The command is passed as an argv array and spawned **without a shell**. That
 * costs a little convenience (`&&`, pipes and globs need an explicit shell) and
 * buys the thing a record is for: the exact argv is what was executed and what
 * gets stored, with no shell interpretation standing between the two.
 */
export function execute(argv, { cwd, timeout = null, env = process.env } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const [command, ...args] = argv;

    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let timer = null;

    if (timeout !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout * 1000);
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      chunks.push(chunk);
    });

    const finish = (exitCode, signal, spawnError) => {
      if (timer) clearTimeout(timer);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({
        exitCode,
        signal: signal ?? null,
        timedOut,
        durationMs,
        // stdout and stderr are interleaved on purpose: the order in which a
        // human read them on the terminal is part of what happened, and two
        // separate streams cannot reconstruct it.
        output: Buffer.concat(chunks).toString('utf8'),
        stdoutBytes,
        stderrBytes,
        spawnError: spawnError ? String(spawnError.message ?? spawnError) : null,
      });
    };

    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}
