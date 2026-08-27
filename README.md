# proofrun

[![CI](https://github.com/KatoHearto/proofrun/actions/workflows/ci.yml/badge.svg)](https://github.com/KatoHearto/proofrun/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

**"It passed when I ran it" is a memory. This makes it a record.**

`proofrun` runs your command, captures what happened — exit code, output,
commit, machine, file digests — and stores it. Later, anyone can ask it to run
the same thing again and say whether the result still holds.

```bash
npx proofrun run -- pytest -q          # record it
npx proofrun verify 9f2a --times 5     # was that real?
```

---

## The one it is really for

A test suite is green. You commit. Later it is red, and nobody can say when it
changed or whether it was ever reliably green in the first place.

```console
$ proofrun run -- node examples/flaky-suite.js
ok    reads a value it just wrote
ok    computes a total
FAIL  sees the config before the refresh lands
ok    cleans up after itself

3 passed, 1 failed

proofrun c09e668be1d6  2026-08-27 04:13:55 UTC
  $ node examples/flaky-suite.js

  exit 1   0.09s   7 lines of output
  output  ea9fc60d7ae19d02 (normalised)
  machine win32/x64 · node v22.14.0

  strength: exact — no noise had to be ignored, so the raw bytes are what is hashed
```

Then ask whether that result was real:

```console
$ proofrun verify c09e668be1d6 --times 6

verify c09e668be1d6  node examples/flaky-suite.js

  REPRODUCED — exit 1, output identical after normalisation

  2 of 6 runs reproduced the record
  FLAKY — the same command in the same tree gave two different answers.
  That is a stronger finding than either a pass or a fail: a result that is not
  repeatable was never evidence, whichever way it landed.
```

Six runs, same tree, same command, two different answers. The single run —
green or red — was never worth anything, and now you know.

## When something really did change

```console
$ proofrun verify b761

verify b761ae86abea  node report.js

  DIFFERENT
    • output differs beyond the 1 normaliser(s) that were applied
      12703b6f0455  →  d8f9cc493527

  where the output parts company (1 of 4 lines differ)
    line 2
      - RESULT: 42
      + RESULT: 43

  what was ignored when comparing the output:
    iso-timestamps — a timestamp is different every run by definition
```

Two things are being said at once, and both matter: *here is the line that
changed*, and *here is what I deliberately stopped looking at on your behalf*.

## Commands

| Command | What it does |
|---|---|
| `proofrun run -- <cmd>` | run it, record it, store it under `.proofrun/` |
| `proofrun verify <id>` | run the same command again and compare |
| `proofrun list` | every record in this directory |
| `proofrun show <id> [--output]` | one record in full |

| Option | |
|---|---|
| `--file <path>` | digest this file as part of the record; repeatable |
| `--timeout <secs>` | kill the command after this long |
| `--times <n>` | repeat a verify *n* times — disagreement is flakiness |
| `--verbose` | list what was ignored even on a successful verify |
| `--cwd <dir>` | where to run, and where `.proofrun/` lives |
| `--json` | machine-readable output |
| `--quiet` | do not stream the command's output |

Exit code is `0` when recorded or reproduced, `1` when the command failed or
the result did not reproduce, `2` for misuse.

## What a record contains

```json
{
  "command": ["pytest", "-q"],
  "startedAt": "2026-08-27T04:13:55Z",
  "durationMs": 3471,
  "exitCode": 0,
  "output": {
    "lines": 213,
    "rawSha256": "…",
    "normalisedSha256": "…",
    "normalisersApplied": ["ansi-colour", "labelled-durations"]
  },
  "git": { "commit": "…", "branch": "main", "dirty": false, "diffSha256": null },
  "machine": { "platform": "linux", "arch": "x64", "node": "v22.14.0" },
  "files": [{ "path": "dist/app.js", "bytes": 48213, "sha256": "…" }]
}
```

It is a plain JSON file. Attach it to a ticket, paste it into a pull request,
commit it next to a release.

## Design notes

**Normalisation is honest, not hidden.** Almost no real command produces
identical bytes twice: timestamps, durations, pids, temp paths and colour codes
all move. Hashing raw output would mean nothing ever verifies. So output is
normalised first — but every normaliser is a decision to *stop looking* at
something, and that is exactly how a proof quietly becomes a ritual. Each one
has a name, is listed in the record it produced, and is printed back on every
failed verify. Both digests are stored, so "identical to the byte" remains a
checkable claim.

**A dirty tree is called out.** A record taken with uncommitted changes does
not bind the commit id in it — what ran is not what is committed. The report
says so in as many words, and the uncommitted diff is hashed as well so that at
least *the same uncommitted state* is checkable.

**No shell.** The command is an argv array, spawned directly. Pipes and `&&`
need an explicit `sh -c`, and in exchange the argv in the record is exactly what
executed, with nothing standing between the two.

**No hostname, no username.** A record is meant to be shared. It describes the
machine — platform, architecture, core count, runtime version — and not the
person sitting at it.

**A different machine is a note, not a failure.** Reproducing a result on
another OS is a *stronger* claim, not a weaker one. Folding it into the verdict
would make every cross-platform check red for the wrong reason.

**An ambiguous id is refused.** `verify a4` matching two records is an error,
never a silent pick of the first. Verifying the wrong record and reporting
success is the worst thing this tool could possibly do.

### A bug found by using it on itself

The first time `proofrun` was asked to verify its own test suite, it said
`DIFFERENT` — and it was right. Node's TAP summary ends with

```
# duration_ms 3396.3587
```

space-separated, no colon. The duration normaliser required a colon, so that
one line made an entirely ordinary `node --test` run impossible to verify.

The pattern now accepts either separator, and the CI job
[`dogfood`](.github/workflows/ci.yml) records a run and verifies it on every
push — plus a second step that appends a line to the suite and asserts that the
verify then **fails**. A check that cannot go red is not a check.

## Honest limits

- **It cannot make a nondeterministic command deterministic.** It can only tell
  you, loudly, that it is one. That is usually the more useful answer.
- **Normalisation can hide a real change.** If your output's only difference is
  a duration and the duration *was* the point — a benchmark, a timeout test —
  compare `rawSha256`, which is stored for exactly that case.
- **`verify` re-runs in the tree as it is now.** It does not check out the
  recorded commit. It reports the commit difference as a note, and comparing
  across versions is often what you want; if you need the old tree, check it
  out first.
- **The environment is described, not captured.** Installed packages, env vars
  and services are not recorded. For byte-level reproducibility across machines
  you want [Nix](https://nixos.org/) or a container; this is the lightweight
  answer for the ninety percent of cases where "did this really happen, and
  does it still?" is the whole question.

## License

MIT — see [LICENSE](LICENSE).
