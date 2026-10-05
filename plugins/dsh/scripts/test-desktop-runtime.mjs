#!/usr/bin/env node
/** Run native integration tests against the installed Desktop's unmodified DSH runtime. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resources = process.env.DSH_DESKTOP_RESOURCES
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources';
const nativeModules = process.env.DSH_NATIVE_NODE_MODULES
  ?? join(resources, 'app.asar', 'dsh', 'node_modules');

if (process.env.PERSEUS_DESKTOP_TEST_CHILD === '1') {
  const requireNative = createRequire(join(nativeModules, '@deepseek-ai', 'dsh', 'package.json'));
  let resolvingNative = false;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@deepseek-ai/') && !resolvingNative) {
        resolvingNative = true;
        try {
          return { url: pathToFileURL(requireNative.resolve(specifier)).href, shortCircuit: true };
        } finally { resolvingNative = false; }
      }
      return nextResolve(specifier, context);
    },
  });
} else {
  const executable = process.env.DSH_DESKTOP_EXECUTABLE
    ?? resolve(resources, '..', 'MacOS', 'DeepSeek Harness');
  if (!existsSync(executable)) {
    throw new Error(`DSH Desktop executable is missing: ${executable}`);
  }
  const forwarded = process.argv.slice(2);
  const tests = forwarded.some(argument => /\.(?:[cm]?js|ts)$/.test(argument)) ? [] : [
    join(project, 'test', 'native-integration.test.ts'),
    join(project, 'test', 'execution.test.ts'),
  ];
  const result = spawnSync(executable, [
    '--expose-internals',
    '--experimental-transform-types',
    '--import', fileURLToPath(import.meta.url),
    '--test',
    ...forwarded,
    ...tests,
  ], {
    cwd: project,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PERSEUS_DESKTOP_TEST_CHILD: '1',
      DSH_NATIVE_NODE_MODULES: nativeModules,
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
