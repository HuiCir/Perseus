/**
 * Perseus settings card, node half.
 *
 * The empty `apply` exists so the package holds a Loader row: the client scan in
 * `@deepseek-ai/dsh-client-modules` only builds a client row for a package whose
 * host entry is active (`fiber !== undefined && !entry.disabled`). The browser
 * half owns the card through `exports["./client"]`, discovered from the
 * `dsh.client` declaration in `package.json`.
 */
export const name = 'perseus-ui'
/** Host plugin body — this package contributes a browser surface only. */
export function apply() {}
