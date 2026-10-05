# Validation and evidence scope

## Release-source checks · 2026-10-05

This release is a source/package refresh, not a new benchmark run. No paid Actor or Speculator inference was used for these checks. Temporary installation uses isolated homes/profiles; active harness settings and original source directories are unchanged.

| Component | Check | Result |
| --- | --- | --- |
| Algorithm prototype | Offline regressions, type checks, unpacked entry point | [Prototype summary](prototype-release-checks.json) |
| Codex 0.2.1 | Native smoke plus full deterministic suite | **80 passed, zero failures/skips** |
| DSH Host 0.1.3 | Typecheck/build and core suite | **24 passed, 1 Desktop-only skip** in ordinary Node |
| DSH Host 0.1.3 | Installed rc.2 deterministic native suite | **12/13** without instrumentation; first bash acquisition is timing-sensitive |
| DSH settings UI | Stub smoke | Passed; not a full live Desktop UI test |
| DSH debug panel | Stub smoke | 19 checks passed; optional experiment |

The DSH failure repeated in default and serial runs. Read-only result logging and a diagnostic test copy each produced 13/13, but neither establishes the cause or makes the normal test green. Implementation and assertions were not relaxed. [DSH checks](dsh-release-checks.json) retain this limitation.

Codex cleanup fixtures prevent unrelated remote Git marketplace synchronization while retaining the original deadline and all-owned-processes-exited assertion. Production MCP lifecycle is unchanged.

## Historical implementation checks · 2026-10-03

These local engineering runs are separate from manuscript experiments. Only summaries are distributed; raw prompts, model responses, account paths, session histories and copies are excluded.

### Codex

- Installed 0.2.0, real Sol/high Actor and Luna/high Speculators: first structured MCP call produced an executable-head domain and complement, **4 → 5** domains.
- **11 waves, 45 workers, 32 independent acquisitions, 13 admitted observations**; zero worker/acquisition failures; **4/4 task tests**; no pending work or owned hosts after cleanup.
- One complete speculative command receipt was captured in public hook context. The Actor echoed an unpredictable probe while its complete native/MCP trace excluded reading it. The alpha did not expose the specific asynchronous payload carrying the probe; admission counts are not all direct per-packet proofs.
- Separate two-turn Luna validation retained positive-domain identity after a sibling was added. Second-turn cached input was **6,912 / 8,020 tokens**; changed complement had a distinct identity. This is a measured request, not a universal hit or speed claim.
- 0.2.1 metadata-only checks retained the Actor's session settings while S resolved Luna/high. The high positive-domain identity matched 0.2.0; global defaults and accounts were unchanged.

### DSH

- Previous rc.2 Host native suite: **13/13**. This does not override the current bash limitation.
- A real `deepseek-flash` run had 6 Actor requests, 12 Speculator requests and 44 acquisitions. Native missing-file results remained evidence. **33 observations** reached three persistent evidence messages; all Speculator streams overlapped Actor work.
- Actor-native read/edit/bash fixed the fixture from **1/5 to 5/5 tests**, with other source and tests unchanged. Pending work and cleanup errors were zero after termination.
- The optional debug panel is not covered by that real-model validation.

## Manuscript experiments

The anonymous ICLR 2027 submission reports 183 selected tasks with three attempts each under GPT-5.6 Terra/Luna high/high. Current plugin checks do not reproduce those populations or models.

The prototype is an algorithm demonstration and host integration reference. Adapters do not establish support for every tool. Mutable external resources need true isolated providers; copy evidence requires current-state verification by the Actor.
