# Perseus main comparison suite · 183 cases

This directory is the frozen four-benchmark selection used by the Perseus main
study. It replaces the previously uploaded `test-suites/perseus-0923/` folder,
which was the 41/49-case diagnostic subset and not the main comparison suite.

| Benchmark | Cases | Source selection |
|---|---:|---|
| AutomationBench | 36 | HarnessEval light `automationbench`, six formal SaaS domains × six cases |
| tau2-Bench | 60 | HarnessEval light `tau2`, base split: 20 airline / 20 retail / 20 telecom |
| Terminal-Bench 2 | 31 | Frozen Perseus main-study subset of the HarnessEval light 34-case set |
| GAIA 2023 | 56 | HarnessEval light `gaia`, public validation split: L1 10 / L2 20 / L3 26 |
| **Total** | **183** | 36 + 60 + 31 + 56 |

The 60-case main comparison is **tau2-Bench**, not BFCL. BFCL is a separate
supplementary study in the manuscript (156 cases across thirteen single-turn
categories) and is not part of this 183-case suite. Do not relabel tau2 cases
as BFCL or substitute a BFCL subset here.

## Files

- `manifests/main-183.json` — the runner-facing manifest, in benchmark order:
  AutomationBench, tau2, Terminal-Bench 2, GAIA. Each case carries only
  `benchmark` and `case_id`; GAIA also keeps its public split, level and
  scoreability metadata.
- `benchmarks/automationbench/cases.txt` — 36 exact case IDs, one per line.
- `benchmarks/tau2/cases.txt` — 60 exact case IDs, one per line. Keep the long
  telecom case IDs intact; they encode scenario attributes.
- `benchmarks/terminal-bench-2/cases.txt` — 31 exact case IDs, one per line.
- `benchmarks/gaia/cases.txt` — 56 exact case IDs, one per line.

The JSON manifest uses only `benchmark`, `case_id`, and public GAIA partition
metadata. It excludes prompts, targets, answers, historical scores, logs,
result paths and evidence. Use the manifest only to select cases, then load
task text, tools, environments and graders from each benchmark's native source.

## Selection provenance

- AutomationBench: the frozen 36-case formal comparison set from the current
  HarnessEval light suite. The source revision is AutomationBench
  `4a8e1061254004d9dac807054eed33fad7d1ff14`.
- tau2: the frozen 60-case HarnessEval light suite, using the native `base`
  split. This is the same 60-case set used by the Perseus tau2 runs.
- Terminal-Bench 2: the main-study 31-case subset frozen in the local Perseus
  run inventory. HarnessEval's light set currently contains 34 cases; the main
  subset omits `qemu-alpine-ssh`, `qemu-startup` and `train-fasttext`. Do not
  compare the 31-case denominator with a 34-case aggregate without restricting
  both methods to the same case IDs.
- GAIA: all 56 selected cases have a public validation answer and participate
  in the local score denominator. The set contains 10 L1, 20 L2 and 26 L3
  cases and retains every locally scoreable validation L3 case.

`manifests/main-183.json` records the SHA-256 of each frozen source manifest
under `sources`. The generated case lists and manifest are checked for exact
counts, uniqueness and the 183-case union.

## Integrity and execution

- This is a case bundle, not a unified runner. Use the existing
  benchmark-specific runner and environment for each directory.
- Some cases have mixed repeat outcomes in historical runs. Keep each new
  attempt as an individual record; do not replace repeats with a best score.
- The 183-case set is a selected long-horizon comparison set, not an unbiased
  benchmark holdout. Report the per-benchmark denominators and the 183-case
  total explicitly.
- Do not pass historical result files, audit ledgers, or answer-bearing
  artifacts into an Actor or Speculator prompt.
