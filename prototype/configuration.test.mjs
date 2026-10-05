import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const configure = fileURLToPath(new URL("./scripts/configure-agent.mjs", import.meta.url));
const baseEnvironment = {
  PATH: process.env.PATH,
  PERSEUS_ACTOR_MODEL: "offline-actor",
  PERSEUS_ACTOR_BASE_URL: "https://provider.example.invalid/v1",
  PERSEUS_ACTOR_API_KEY: "offline-test-placeholder",
  PERSEUS_ACTOR_THINKING: "high",
  PERSEUS_SPECULATOR_MODEL: "offline-speculator",
  PERSEUS_SPECULATOR_THINKING: "low",
};

function withConfiguration(extra, verify) {
  const directory = mkdtempSync(join(tmpdir(), "perseus-configuration-test-"));
  try {
    execFileSync(process.execPath, [configure, directory], {
      env: { ...baseEnvironment, ...extra }, stdio: "pipe",
    });
    verify(JSON.parse(readFileSync(join(directory, "models.json"))),
      JSON.parse(readFileSync(join(directory, "settings.json"))), directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("offline configuration stores credential references and release metadata", () => {
  withConfiguration({}, (models, settings, directory) => {
    const provider = models.providers["openai-compatible"];
    assert.equal(provider.api, "openai-responses");
    assert.equal(provider.apiKey, "$PERSEUS_ACTOR_API_KEY");
    assert.equal(provider.headers["User-Agent"], "Perseus/0.9.0");
    assert.deepEqual(provider.models.map(model => model.id), ["offline-actor", "offline-speculator"]);
    assert(!JSON.stringify(models).includes(baseEnvironment.PERSEUS_ACTOR_API_KEY));
    assert.equal(settings.compaction.enabled, false);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, "models.json")).mode & 0o777, 0o600);
  });
});

test("offline configuration separates provider credentials and preserves explicit native capabilities", () => {
  withConfiguration({
    PERSEUS_API_PROTOCOL: "anthropic",
    PERSEUS_ACTOR_NATIVE_CACHE: "on",
    PERSEUS_ACTOR_ADAPTIVE_THINKING: "on",
    PERSEUS_SPECULATOR_PROVIDER: "deepseek",
    PERSEUS_SPECULATOR_API_TYPE: "openai-completions",
    PERSEUS_SPECULATOR_BASE_URL: "https://api.deepseek.com",
    PERSEUS_SPECULATOR_API_KEY: "offline-speculator-placeholder",
  }, models => {
    assert.equal(models.providers["openai-compatible"].api, "anthropic-messages");
    const actor = models.providers["openai-compatible"].models[0];
    assert.equal(actor.compat.forceAdaptiveThinking, true);
    assert.equal(actor.compat.supportsPromptCachingScope, true);
    assert.equal(models.providers.deepseek.apiKey, "$PERSEUS_SPECULATOR_API_KEY");
    assert.equal(models.providers.deepseek.models[0].compat.thinkingFormat, "deepseek");
  });
});

test("offline configuration rejects unsupported protocols before generating state", () => {
  assert.throws(() => withConfiguration({ PERSEUS_API_PROTOCOL: "unknown" }, () => {}),
    error => error.status !== 0 && error.stderr.toString().includes("Invalid PERSEUS_API_PROTOCOL"));
});
