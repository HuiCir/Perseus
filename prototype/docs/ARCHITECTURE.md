# Persistent SE Runtime

## Authoritative Plane

The native Actor loop is retained: request, prepare/validate tool arguments,
execute, commit results in source order, repeat or finish. Existing registered
parallel tools overlap; sequential tools form the original batch barriers.
SE never participates in an Actor demand race and never substitutes a native
tool result. Actor prompts and tool schemas do not acquire branch-management
instructions or tools.

## Acquisition Plane

The derived variant partitions a native tool into internal action domains using
schema-declared categorical actions and successful mainline invocation heads.
It does not parse the task into a hand-authored plan or start a model router.
Narrowed schemas preserve every original constraint; ordered exclusion makes
domains disjoint, and a complement retains unrecognized actions. Domain identity
is canonical and provider cache identities are independent. Actor tools and
prompts are unchanged. See the README for supported structured heads and controls.

At a request boundary the controller observes the current mainline snapshot.
Tool-scoped workers run asynchronously, with high effort by default. A completed
streamed tool call immediately enters the native executor. Independent calls
overlap. Each worker proposes one executable acquisition frontier, not an
autonomous task-solving conversation. Native tool programs may resolve local
dependencies. Later frontiers use fresh mainline progress and retained evidence;
a worker's join of its already-running calls never becomes a mainline join.

Authoritative new observations or genuine user input advance a progress
revision. A newer revision may launch a fresh tool-scoped frontier while an
older one continues. Identical in-flight invocations share work; completed
invocations may refresh after progress. Neither a timer nor an Actor round
alone invalidates evidence. SE delivery itself is not treated as a new user
instruction or an authoritative progress event.

## Evidence Plane

Native observations include the tool, prepared arguments, unchanged content,
error status and execution interval. Intervals stay in runtime metadata and logs,
not model-visible evidence. A deterministic source-aware ledger tracks
complete records/rows/extents, not generated interpretations. It compares:
- native Actor observations;
- prior admitted evidence;
- other ready observations in the same boundary.

Known complete units are omitted. Causally older results cannot displace newer
known facts. Concurrent conflicting observations remain distinguishable.
Mutation/reversion and error recurrence after recovery are retained. Unknown
formats fall back to the complete native observation, including images. JSON
with ambiguous keys or non-lossless numeric parsing remains native text.

All ready novel evidence is appended once to the ordinary conversation and
session log before the next model request. No pending Future is awaited, and
there is no one-message-per-turn restriction. The same message stays at its
original position in later context. No tool call is fabricated to impersonate
the Actor. Observations explicitly retain their historical provenance.

## Lifecycle

The Agent owns one runtime per session. Tool-scope replacement and explicit reset
cancel old work and clear its admission state. Task completion/cancellation
stops unfinished acquisitions. Epoch checks prevent a late completion from
publishing into a new task. A completed observation that was admitted remains in
persisted history; a resumed process reconstructs the ledger from those messages.
Source revisions are not wall-clock expiry thresholds.

An Actor request failure is not itself an episode boundary. The host that owns
automatic retries explicitly retains pending acquisition only while its existing
retry policy accepts that error. The native session preserves the same Futures
through backoff and retry, without a new worker wave for an unchanged revision.
Both prompt and continuation entry points use the same retry lifecycle. Completed
observations can be delivered once at any later request; a retry never waits for
them. Retry exhaustion or cancellation releases the retained work. Direct Agent
users without a retry owner keep the default cleanup behavior. A retry owner using
`shouldRetainSpeculationForRetry` must call `endSpeculativeRun` when done retrying.
Dispatch marks are cleared when a run actually ends, so a later explicit retry
can relaunch previously cancelled work. Late callbacks cannot publish after an
episode reset.

No SA, head matching, whole-turn takeover, speculative model summarizer, or
evidence verifier is involved. Output completeness and no-wait scheduling are
separate from the quality of model-selected acquisition scopes.

## Ablation Semantics

The full variant uses derivation, progress-triggered renewal and session Futures.
Disabling derivation restores one unmodified-schema worker per native tool.
Disabling the dual frontier removes progress-triggered renewal, not the initial
asynchronous wave or its late delivery. Disabling cross-request Futures keeps
ready observations at the next boundary and cancels unfinished acquisition there;
already admitted evidence is never removed. This is not a no-memory control.
These components interact: domains learned from later mainline calls cannot
launch when renewal is disabled. Do not sum the three ablation deltas as if the
components were independent or describe this variant as a restored takeover loop.

## Limits

Workers retain native tool permissions inside independent work copies. They do
not share authoritative mutable state. There is no SA selection/commit mechanism.
The host must provide genuine independent execution; copying a filesystem alone
cannot isolate external services. See [Independent Execution](INDEPENDENT_EXECUTION.md).

A fast manual acquisition plan does not prove that a model can generate that
plan cheaply. Autonomous validation must count all worker requests, failures,
tool executions and token use. In-flight cancelled streams may not expose final
provider usage; reported usage is then a lower bound, not zero cost.

Invocation equality is not semantic equality. Different shell programs can
produce overlapping evidence that this conservative ledger cannot safely remove.
Repeated fresh scopes may also spend additional inference without new useful
content. These must be observed in native end-to-end logs rather than hidden by
time/length cutoffs or forced Actor behavior.
