# 0.9 context-management candidate

Based on the frozen context-triggered 0.8 runtime. Model prompts, speculative
action domains, Actor authority and scheduling strategy are unchanged. This is
not yet a task-quality-validated release.

## Disclosure

Small observations follow the existing path. Large SE deltas are prepared
asynchronously and become eligible at a later request boundary only when their
archive/index is complete. The Actor never waits for pending SE summarization.
This stage is deterministic structural summarization, not an additional LLM call.
The complete original observation and the delta view are both archived.

Directory entries and strictly recognized path:line:text command records use
source-addressed ledger units. Unrecognized formats remain opaque; malformed
records are not silently dropped. Independent work-copy provenance remains
distinct from authoritative state. Granularity is improved, but this is not
arbitrary semantic equivalence detection.

The normal presentation budget defaults to 16 KiB per observation. This is not
a storage cutoff: large originals are fully preserved. Structured evidence has
complete-record pages. Unstructured or individually huge records additionally
have explicitly typed UTF-8/code-point-safe JSON fragments, exactly reconstructable
by ordered concatenation and JSON parsing. Those fragments are not presented as
complete JSON documents or final findings.

Archive indexes are resolved internally through the existing read_file tool;
no new tool is exposed. Raw archives live in PERSEUS_STATE_DIR/context-archive.
The HTTP tool adapter currently requires a usable read_file tool for this path;
other tool adapters have not yet been validated for archive retrieval.
Native image blocks retain their modality and are not replaced by text indexes.

## Mainline view

At 50% of the configured model context window, measured using visible UTF-8
serialized bytes as a conservative proxy, async archival prepares a smaller
view of tool results and SE evidence. It preserves user instructions, assistant
messages, tool-call IDs, result IDs and all new messages appended after the
snapshot. The complete session history remains intact; the model-facing view
is replaced only between requests. This is not a model-written conversation
summary and does not claim a precise token count.

On view commit, the runtime increments its context epoch, cancels all prior
speculative generation/execution, clears old futures and staged disclosures,
restores admitted ledger history and reevaluates opportunities. Late old-epoch
results cannot publish. Archival errors leave the original view unchanged and
are recorded, not replaced with invented summaries.

Configuration: PERSEUS_DISCLOSURE_BYTES (default 16384),
PERSEUS_CONTEXT_COMPACT_RATIO (default 0.5). No new task time, turn or token
cutoff is added. These thresholds govern representation and background work.

## Verification status

- Root TypeScript check and targeted regression tests run locally.
- Historical Terminal SE outputs replayed offline; no task scores inferred.
- Live sanitize-git-repo attempt stopped after all SE calls returned HTTP 402
  Insufficient Balance. It is not a valid SE experiment and must not be counted
  as a speedup or an Actor-only substitute.
- Pending: successful live three-case task grading and archive-read behavior.

The release contains no installed dependencies. The launcher and offline check
prepare a source-fingerprinted runtime cache outside the package. The transport
regression now uses a synthetic fixture; private historical logs are not required
or distributed. No historical test result is presented as a current benchmark.
