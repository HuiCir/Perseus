# Protocol and adapter mapping

The manuscript defines a continuing authoritative Actor and a separate observation frontier. Speculators receive constrained native tool variants and propose one acquisition frontier per generation. Acquisitions run in independent work copies. Ready evidence enters later decisions; no pending-work join is required.

## Protocol invariants

- Only genuine user input or new authoritative observations advance the progress revision.
- A domain launches at most once at a revision; evidence admission alone does not renew it.
- Complete arguments are checked against the launch-time variant and native schema before execution. Current partition ownership can reassign a valid old native/complement action without changing its arguments.
- A canonical tool/argument identity shares in-flight work. Finished work may be refreshed after new authoritative progress.
- Evidence remains non-authoritative and includes result, errors and copy provenance. The Actor's own calls still execute natively.
- Cancellation and lifecycle changes invalidate old epochs, settle execution and prevent late publication.

## What the repository implements

| Surface | Prototype | Codex plugin | DSH Host plugin |
| --- | --- | --- | --- |
| Progress boundary | Research runtime request loop | Native hooks/tool events | Native agent request/assistant stream events |
| Tool domains | Native contracts and successful observations | Explicit isolated registry plus typed command MCP; enum/const and observed heads | Visible native schemas and observed action heads |
| Evidence | Persistent source-aware ledger | Complete result/receipt admission and full-result duplicate suppression | Source-aware ledger and native persistent session append |
| Execution | Host-provided independent execution environments | Per-acquisition copies, native command/exec, macOS Seatbelt | Per-acquisition copies, official tools host, macOS Seatbelt |
| Actor configuration | Operator-selected provider/model | Unchanged session model and effort | Unchanged native route |
| Speculator configuration | Operator-selected | Luna/high preferred; native capability resolution | Native route inheritance or explicit plugin override |

The prototype and DSH ledger have structured-unit provenance logic; the Codex adapter does not claim the full structured-unit supersession semantics of the paper. Opaque outputs remain complete observations.

## Codex-specific constraints

The public hook surface does not provide a complete built-in tool registry or a hook before every internal model request. The adapter therefore uses hook/tool progress and exposes one stable `command_exec(command: string[], cwd?: string)` MCP tool. It does not infer argv from opaque shell text. Legacy read/grep/glob domains retain their existing prefixes.

Before any worker starts, `model/list` resolves the exact configured Speculator and supported reasoning effort. The actual values drive thread config, turn parameters and prompt identity. Positive-domain instructions remain stable; a changed complement gets a fresh thread. Unsupported or unverified capability metadata stops exploration rather than altering Actor settings or silently selecting another model.

Private workers disable inherited tools, plugins, hooks and MCP. Unexpected tool activity, rerouting or multiple observed usage increments stops parameter generation. This checks the native transport but does not prove that an opaque native turn contains exactly one internal request. The bridge retires after five minutes without hook activity.

General commands cannot access the original tree, user files, network or external mutable services. `posix_spawn` and session/process-group detachment are denied. Node tests need `--test-isolation=none`; unsupported commands fail with their native result rather than weakening isolation.

## DSH-specific constraints

The Host preserves the native AgentLoop and frozen request config. Completed observations are appended through the public Session API. Speculative private call IDs pass through the parent tool permissions/guards and are redirected only to an independent provider.

The built-in provider requires compatible official rc.2 tool schemas/output ABI and a separately loaded official tools host. It supports read/write/edit/grep/glob/bash, preserving native read-before-edit policy within each fresh copy. External APIs, MCP, browsers and databases need isolated provider registration and explicit routing.

The native shell uses the official managed-process-group contract. Deliberately detached daemons need a stronger provider such as a container or VM. The settings UI uses the official client interface; the debug panel is an optional profile-specific experiment.
