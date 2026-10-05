# Perseus for Codex

Native Codex plugin **0.2.1**: one session-owned Actor, asynchronous single-round Luna acquisition workers, dynamic tool domains, persistent Futures and complete independent-copy observations. This adapter uses public hooks and app-server APIs; it does not patch the Codex binary.

## Default configuration

- **Actor:** model and reasoning effort come from the current session. No fixed model gate or launcher override.
- **Speculator:** `gpt-6-luna`, preferred effort `high`, current native Codex account.
- **Capability resolution:** query `model/list`, require the exact model and advertised effort. If the requested effort is unsupported, use a supported native default no stronger than requested. Missing/invalid capability data stops that generation. Actual effort is applied to both private thread config and turn parameters, and included in cache identity.

The plugin never reads or copies credentials and never writes global model or service-tier settings. Actor and Speculator caches are separate. Existing positive-domain instructions and output schemas stay stable; changed complements get fresh threads. It does not invent cache headers or claim a hit without native counters.

## Install

The tested backend requires macOS, Node.js 24+, `rg`, `/usr/bin/sandbox-exec`, and a working native Codex binary. Default discovery includes the Desktop application's bundled CLI; use `PERSEUS_CODEX_BIN` for another installation.

Unpack the marketplace archive from the repository release, then:

```sh
codex plugin marketplace add /absolute/path/to/extracted-marketplace
codex plugin add perseus@perseus-local
codex
```

Review and trust all nine command hooks in the native trust flow. Load a new session after installation. To build the marketplace from source:

```sh
node scripts/pack.mjs
```

The package uses `.codex-plugin/plugin.json`. Its portable manifest remains source in `packaging/`, not at the package root: the tested alpha otherwise installs but misses hooks. Its legacy MCP configuration does not resolve plugin-root variables or relative commands, so a bootstrap queries public `hooks/list` metadata to validate the installed copy. It closes that query host before importing the installed MCP server, without starting a model or reading a private installation database.

## Domains and execution

Default acquisition contracts are read/grep/glob plus `command_exec(command: string[], cwd?: string)`. Successful typed Actor calls can derive executable-head domains plus a complement. Declared enum/const action heads and supported observed method/endpoint heads can also produce domains. Opaque shell strings are not parsed into categories.

Complete arguments are checked against the original JSON Schema, launch-time constraints and current unique owner. Unsupported schema features fail closed. Composite constraints are preserved; some branch-internal enum forms conservatively fall back to a native domain. Other MCP/API/database tools require explicit isolated execution adapters.

Each acquisition gets its own current-tree copy. Copies never merge into Actor state. Full stdout/stderr, exit status and isolation receipt remain evidence, including native errors. Symlinks, special files and outward hardlinks are rejected. Seatbelt denies network, user-file/original-tree access, external IPC, out-of-copy writes, `posix_spawn` and process-group detachment. Trusted runtime reads are narrowly scoped. Node tests inside acquisitions require:

```sh
node --test --test-isolation=none
```

Unsupported commands return errors; there is no unconfined fallback.

## Scheduling and compatibility

User input and complete authoritative receipts advance progress. Ready-only collection neither joins pending work nor renews the frontier from evidence alone. Futures share identical in-flight acquisitions and may refresh after new progress. Full-result duplicates are suppressed; this adapter does not claim the paper's entire structured-unit supersession ledger.

Private workers disable inherited tools, MCP, plugins and hooks. Unexpected tool activity, rerouting or multiple observed usage increments fails generation. Public turns do not expose every internal model request, so one turn is not asserted to equal one request. Hosted tool paths without native hooks are outside full coverage.

Stop/Interrupt/SessionEnd cancel work and settle cleanup. Compaction changes epoch. The bridge retires after five minutes without hook activity. The alpha does not expose all asynchronous hook-context notifications; direct receipts and end-to-end probes are distinguished in validation.

## Develop and verify

```sh
npm ci
PERSEUS_CODEX_NATIVE_SMOKE=1 node --test test/*.test.mjs
node scripts/pack.mjs
```

These tests use deterministic fixtures and native execution without paid inference. Explicit `live-*` scripts can issue real model turns; they are optional diagnostics, not installation steps. They write ignored local results. `live-installed-domains.mjs` leaves the Actor unspecified unless `PERSEUS_VALIDATION_ACTOR_MODEL/EFFORT` are explicitly set.

Release-source checks: **80/80 passed**. Previous real-model results and native capability checks are summarized in [repository validation](../../docs/validation.md); raw model outputs and account/session files are excluded.
