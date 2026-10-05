# Perseus 0.9.0 Algorithm Prototype

Persistent semantic-evidence (SE) acquisition around one authoritative Actor.
This is the algorithm demonstration, with internal action-domain derivation,
lifecycle ablation controls, independent native execution environments for SE,
and experimental lossless context management. It is a research prototype rather
than a production harness plugin. The Codex and DSH integrations are distributed
separately in the parent repository.

Offline regression checks establish selected implementation properties; they do
not establish task quality, benchmark reproduction, lower cost, or acceleration.
See [Context management](CONTEXT-0.9.md) for the 0.9 disclosure and archival path
and its remaining validation limits.

SE workers start alongside normal Actor requests. Each worker uses one registered
tool's full native interface to acquire a local information contribution.
Independent calls start as their arguments arrive in the model stream. Each
worker proposes one acquisition frontier; native tool programs can resolve local
dependencies and later frontiers follow new mainline observations. Workers are
prompted to acquire evidence, not author the final deliverable; this role
instruction is not used as a write boundary. Each executable acquisition instead
runs in an independent environment supplied by its tool host. It cannot commit
its writes to the authoritative environment. The Actor never constructs or selects speculation.

At natural request boundaries, the runtime accepts complete, source-identified
observations that are not already known. Accepted evidence becomes ordinary
persistent conversation history, with each admitted observation appended once.
Changes and reversions can legitimately contribute new observations. Pending work is not
awaited. The Actor continues its original tool loop and decides when the task ends.

This version deliberately does not use EX head matching, tool-result replacement,
SA adoption/merges, a shadow Actor, an LLM evidence verifier, or a summary API.
It is a new experimental SE runtime, not a promise of improvement on every task.

## Run

Requires Node.js 22.19+ and npm on macOS or Linux. Dependencies are prepared in
a source-fingerprinted user cache outside this directory.

```bash
export PERSEUS_API_PROTOCOL=openai
export PERSEUS_ACTOR_MODEL=your-actor-model
export PERSEUS_ACTOR_BASE_URL=https://your-provider.example/v1
export PERSEUS_ACTOR_API_KEY=your-key
export PERSEUS_ACTOR_THINKING=high
export PERSEUS_SPECULATOR_MODEL=your-acquisition-model
export PERSEUS_SPECULATOR_THINKING=high

export PERSEUS_TOOL_MANIFEST=/path/tools.json
export PERSEUS_TOOL_ENDPOINT=http://127.0.0.1:8765
./perseus --no-builtin-tools --extension ./extensions/http-tools.ts \
  --mode json --print -p 'Your original task'
```

Use `--protocol anthropic` (or `PERSEUS_API_PROTOCOL=anthropic`) for native
Anthropic Messages. OpenAI uses native Responses, retaining its opaque output
items and provider cache affinity. Neither protocol fabricates reasoning.
Anthropic adaptive thinking and native cache support can be explicitly enabled
with `PERSEUS_ACTOR_ADAPTIVE_THINKING=on` and
`PERSEUS_ACTOR_NATIVE_CACHE=on` when the gateway supports them.

A distinct acquisition provider can use a different protocol and credential:

```bash
export PERSEUS_SPECULATOR_PROVIDER=deepseek
export PERSEUS_SPECULATOR_MODEL=your-deepseek-model
export PERSEUS_SPECULATOR_BASE_URL=https://api.deepseek.com
export PERSEUS_SPECULATOR_API_TYPE=openai-completions
export PERSEUS_SPECULATOR_API_KEY=your-deepseek-key
```

Use distinct provider names when credentials or endpoints differ. The model
registry stores environment-variable references, not API keys. Actor and worker
models keep independent conversation/cache identities.

## Controls

- `PERSEUS_TOOL_DERIVATION=on|off`: derive internal action domains, default `on`.
- `PERSEUS_SWARM_ENABLED=on|off`: default `on`. With `off`, never dispatch
  speculative workers or lower-frontier work. Execute native Actor calls in order
  as ReAct, retaining derived metadata and cache/ledger facilities (idle without
  acquisition). No independent execution environment is required.
- `PERSEUS_DUAL_FRONTIER=off`: alias for disabling the swarm. This corrects the
  old ablation label; it no longer means initial-only acquisition.
- `PERSEUS_SE_REFRESH=continuous|initial|steps|context`: default `continuous`.
  `initial` launches only on a new user request. `steps` refreshes after completed
  mainline turns; `context` refreshes on new unique authoritative information.
- `PERSEUS_SE_STEP_WIDTH=4`: completed-turn interval. API retries and pending
  tool batches do not count. Used only with `steps`.
- `PERSEUS_SE_CONTEXT_GROWTH_RATIO=1`: new native information bytes divided by
  task, tool-schema and unique native-information bytes at the previous wave.
  A ratio of 1 waits for another baseline's worth of information. This is an
  information-volume heuristic, not a semantic entropy or model-window estimate.
  At refresh, worker observations use an exact record dictionary with chronology;
  no facts, programs or images are cut and no summary model is called.
  Actor history is unchanged. Used only with `context`.
- Suppressed waves never cancel pending Futures or delay evidence delivery.
  SE evidence cannot trigger more SE through its own context growth.
- `PERSEUS_CROSS_REQUEST_FUTURES=on|off`: retain pending acquisition across Actor
  requests, default `on`. With `off`, the next request admits already-ready
  evidence, then cancels pending work and drops the request-local cache. Admitted
  history and source-aware deduplication remain intact in both modes.
- `PERSEUS_ENABLED=0`: ordinary Actor-only control.
- `PERSEUS_SEMANTIC_ENABLED=off`: no SE workers.
- `PERSEUS_SE_TOOLS=*`: all registered tools, the default.
- `PERSEUS_SE_TOOLS=read,grep,bash`: explicitly selected registered tools.
- `PERSEUS_TRACE_FILE=/path/events.jsonl`: lifecycle, native acquisition,
  deduplication decisions, model usage and evidence delivery.
- `PERSEUS_STATE_DIR`: optional independent session/configuration directory.
- `PERSEUS_EXACT_ENABLED=1` or enabled SA is rejected, not silently emulated.

There is no task-specific timeout, turn budget, evidence-count limit, prompt
slicing or automatic evidence expiry. Native output defaults are complete;
explicit tool range/limit arguments remain meaningful user/model requests.
Automatic context compaction is disabled in the CLI configuration so it cannot
silently replace the promised persistent evidence. Provider context limits,
required provider output bounds, transport errors and caller-configured
timeouts remain real constraints and must be reported.

## External Tools

```bash
export PERSEUS_TOOL_MANIFEST=/path/tools.json
export PERSEUS_TOOL_ENDPOINT=http://127.0.0.1:8765
./perseus --no-builtin-tools --extension ./extensions/http-tools.ts \
  --mode json --print -p 'Your original task'
```

The manifest contains `tools: [{name, description, parameters, parallel?}]`
and `metadata.acquisition_protocol: "independent-work-copy-v1"`, with optional
`metadata.workspace_root`. It exposes the original tool names
and JSON schemas, with no speculative tools added to the Actor.

The tool server implements:
- `POST /acquisition/open`: `{scope_id}`. Returns an independent native environment receipt.
- `POST /execute`: `{tool, arguments, request_id, speculative, acquisition_scope?}`.
- `POST /acquisition/close`: `{scope_id}`. Idempotently settles and releases a copy.
- `POST /cancel`: `{request_id}`.

Responses use `{ok, result}` or an error envelope. An optional manifest
`result_field` chooses an existing native response field. No content is cut.
Actor calls the authoritative native executor. SE calls the same native functions
on its independent work copy, with no restricted tool schema or permission tiers.
The two acquisition endpoints are internal transport operations, not model tools.
See [Independent Execution](docs/INDEPENDENT_EXECUTION.md) for the provider contract.

## Scope and Responsibility

This version uses independent execution state, without a safety classifier or SA
commit path. SE retains native programs, scratch writes and source inspection in
that state. Results identify the copy as non-authoritative. There is no automatic
merge and no claim that a copy's files already exist in the Actor's environment.

A host must implement independent execution for its actual tools. Built-in host
filesystem tools do not yet supply this provider; use a configured external
environment for SE, or `PERSEUS_ENABLED=0` for ordinary native Actor-only use.
Copying a local directory cannot isolate a remote API's side effects. Unsupported
external providers are explicit configuration errors, never shared-write fallbacks.

The ledger understands source-identified search/catalog records and standard
tabular ranges; unknown schemas, images and text remain complete native
observations. It does not pretend that two arbitrary shell commands or
paraphrased outputs are semantically equivalent.

Native CLI session history stores admitted observations with their provenance.
Resuming restores that knowledge; it cannot resume an already terminated OS
process or model stream. User cancellation/task completion cleans up background
work without requiring another Actor turn.

The native session's existing retry policy retains in-flight SE across a
retryable Actor transport error and its backoff. A retry does not launch another
copy of the same acquisition frontier. Pending work is still never awaited by
the Actor. Retry exhaustion, cancellation (including during backoff), and normal
completion end the acquisition run; completed admitted evidence stays in history.

See [Architecture](docs/ARCHITECTURE.md). The package includes deterministic
regression tests; private benchmark logs and generated experiment artifacts are
excluded.

## Offline checks and packaging

```bash
./perseus --version
bash scripts/check-offline.sh
bash scripts/package-release.sh ../dist/Perseus-prototype-0.9.0.zip
```

The offline check prepares dependencies in the same source-fingerprinted cache
as the launcher, then runs configuration and context regressions without sending
model requests. An empty cache may require npm package downloads. The JPEG
transport regression uses a synthetic fixture and needs no private trace logs.
The archive contains the harness source, external-tool extension, independent
execution adapters, tests, documentation, and license notices; it excludes
installed dependencies, user configuration, credentials, and runtime artifacts.

## Internal Action Domains

The Actor retains the original tool names, schemas, execution and prompts.
SE workers use the same tool with a narrower schema, not a new tool exposed to
the Actor. Action discriminators declared as schema enums/constants can split
before the first Actor request. Successful mainline observations can add method,
operation and endpoint domains or executable-head domains for structured `argv`.
Each domain has a distinct worker/cache identity and executes the original native
invocation. Runtime validation enforces its domain before native execution.

Domains are disjoint at each frontier. A complement preserves undeclared/new
actions unless the declared schema itself is provably exhausted. Old workers
retain their original snapshot and are not retargeted by later derivation.
There is no safety classifier, LLM router, takeover or benchmark-specific plan.
Opaque shell strings are not guessed or split with regex; unchanged native domains
remain available when structured action heads cannot be inferred.

Derivation changes acquisition width, so it may increase model requests and cost.
Its availability is not proof of useful acceleration. Turn off one control at a
time for an ablation; keep Actor and SE model settings otherwise unchanged.
