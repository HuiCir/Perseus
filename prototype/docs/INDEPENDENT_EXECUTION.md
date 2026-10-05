# Independent Native Execution

The SE runtime calls `AgentTool.openAcquisition(id, signal)` instead of executing
against authoritative state. The returned object supplies `execute`, `close`, and
`provenance` with `kind: independent_work_copy`, matching `scopeId`,
`authoritative: false`, and snapshot start/end times. Tool adapters preserve this
callback; the model still sees only the original tool name, schema and description.

A copy is per executable acquisition. Independent calls do not share mutable
copy state. Local dependencies can execute within a native command/program.
Subsequent frontiers use current mainline observations; late completed evidence
can still be consumed across request boundaries. There is no merge or takeover.

The HTTP adapter uses the three internal operations described in the README.
Opening must return `{ok: true, provenance}`. Opening a duplicate/closed ID is an
error; closing a missing/already-closed ID is successful. `/execute` must reject
unknown/closed scope IDs and must never redirect them to authoritative execution.
`/cancel` must target the correct native execution. Creation that finishes after
cancellation must still be settled and closed. Scope cleanup errors are surfaced.

The runtime never waits for copies at Actor request boundaries. At task termination,
pending work is cancelled and native cleanup is settled before returning. Hosts
must also close remaining allocations when their task transport shuts down, so a
disconnected client cannot leave background state active indefinitely.

`adapters/work_copies.py` provides reusable lifetime management, a native mutable
state callback provider, and an offline Docker filesystem provider. The latter:

- copies the full container filesystem without pausing the source;
- allows original native commands and writes inside the copy;
- rejects mounted volumes because Docker commit excludes their contents;
- uses no external network, which would otherwise share remote side effects;
- records a snapshot interval, not an atomic point-in-time consistency claim;
- disposes only the containers and images it created.

Remote-service tools require an independently provisioned service or simulator.
The runtime does not infer such isolation from a tool's name, HTTP method, or
prompt. Provider receipts describe a host contract, not cryptographic proof of
an arbitrary third party's implementation.

Copy observations and authoritative observations have separate source addresses.
Copy facts are structurally deduplicated across copies and restored history.
Complete original values remain available; this protocol introduces no truncation,
new model calls, Actor selection instructions, or fixed resource cutoff.
