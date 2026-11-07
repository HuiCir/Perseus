# Perseus 0.9 Test Suite

This folder contains the frozen case lists used in the current four-benchmark
Perseus 0.9 comparisons. It contains case identifiers only. Load task text,
tools, environments, and graders from each benchmark's native source.

## Suite variants

| Manifest | Cases | AutomationBench | GAIA | tau2 | Terminal-Bench 2 | Use |
|---|---:|---:|---:|---:|---:|---|
| `manifests/full-49.json` | 49 | 7 | 8 | 15 | 19 | Full comparison set; aligns with the three-run aggregate workbook. |
| `manifests/main-41.json` | 41 | 7 | 8 | 10 | 16 | Curated subset, excluding eight score-flat diagnostic failures. |

“Full” means the full 49-case comparison selection, not the complete source
benchmarks. Both selections were chosen from previously observed results and
are therefore not independent or unbiased evaluation sets. The 41-case set
is a subset of the 49-case set.

## Per-benchmark lists

Each benchmark folder has `full-cases.txt` and `main-cases.txt`, one exact case
ID per line, in manifest order. The `terminal-bench-2/` folder corresponds to
the `terminal` benchmark value in the JSON manifests. Keep tau2 case IDs intact;
the telecom IDs encode many scenario attributes.

## Integrity and execution

- The full manifest uses only `benchmark`, `case_id`, and the GAIA integrity
  partition. It excludes prompts, targets, answers, historical scores, logs,
  and result paths.
- GAIA's eight selected cases retain the `provisional_gaia` partition. This is
  not a certification that their source data is clean; keep this limitation in
  any results report.
- AutomationBench historical timing contains a logged 20-second Actor request
  gap in the prior comparison. Treat timing comparisons as approximate unless
  execution pacing is matched.
- Some selected cases have mixed repeat outcomes. Keep each new attempt as an
  individual record; do not replace repeats with a best score.
- Do not pass historical result files, audit ledgers, or answer-bearing
  benchmark artifacts into an Actor or Speculator prompt. Use a manifest only
  to select case IDs, then load the case from the benchmark's native source.

This is a case bundle, not a unified runner. Use the existing benchmark-specific
runner and environment for each directory.

## Source

Selection: `perseus-0923-broad` and its curated `perseus-0923` subset, frozen in
the local Perseus 0.9 suite inventory on 2026-09-23. Runtime fingerprint for
the observed local runs: `5717ff6e131b5d144db2ccabb5844a592f3f7ba96df2fbe8d05634d4a7b824dd`.
That configuration used Terra high Actor and DeepSeek V4 Flash Vision high SE,
with EX and SA disabled.
