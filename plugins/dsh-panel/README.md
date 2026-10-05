# dsh-plugin-perseus-panel

Host-only companion for `dsh-plugin-perseus`. Contributes a docked side panel to
the live Web UI **without** participating in the client module graph:

- routes come from the `webServer` carrier (`/perseus/state`, `/perseus/config`, `/perseus/events`)
- panel markup + script ride the `webserver/index-inject` table
- settings read/write through `configEditor.edit()`, which has no volatile-field restriction

Because no `dsh.client` declaration is involved, a defect here cannot fail the
client composition that blocks boot.
