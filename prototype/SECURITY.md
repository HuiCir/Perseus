# Execution Scope

Perseus 0.9.0 is an experimental persistent-evidence runtime, without speculative
sandboxes, a read-only supervisor, safety tiers or transactional merges.

SE and the Actor use the caller's registered native tool capabilities. Prompts
are not a security boundary. Use disposable task containers or explicitly
authorized acquisition environments. Do not expose irreversible production
operations, private host credentials or unrestricted sensitive services.

Task cancellation aborts outstanding model/tool requests; tools and remote
adapters must honor cancellation. This is lifecycle management, not protection
against hostile code. Observation timestamps describe historical evidence,
not an assertion of current mutable state.

Keep API keys in environment variables. Traces and session logs can include full
task/tool content and model reasoning metadata; protect them as sensitive data.
No credentials or benchmark data are distributed in this directory.
