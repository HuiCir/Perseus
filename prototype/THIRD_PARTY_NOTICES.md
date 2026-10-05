# Third-Party Notices

## Pi agent runtime

The vendored TypeScript harness is derived from the Pi monorepo by Mario
Zechner and is distributed under the MIT License included in `LICENSE`.

Source: <https://github.com/badlogic/pi-mono>

Source revision: `5903e3ed1d0cb79d165eccbd858dc449594bb436`

## Speculative execution method

The PERSEUS controller is informed by the Speculative Actions paper and public
reference repository. That repository is licensed under the Apache License 2.0.
No benchmark data or generated experiment artifacts are included in this
package.

Paper: <https://arxiv.org/abs/2510.04371>

Source: <https://github.com/naimengye/speculative-action>

## Vendored HTML export libraries

- Highlight.js 11.9.0: BSD-3-Clause. The bundled source is
  `harness/packages/coding-agent/src/core/export-html/vendor/highlight.min.js`.
  Its version-pinned [license](docs/third-party/highlight.js-11.9.0-LICENSE) is
  reproduced from [the upstream tag](https://github.com/highlightjs/highlight.js/tree/11.9.0).
- Marked 15.0.4: MIT, with upstream Markdown attribution. The bundled source is
  `harness/packages/coding-agent/src/core/export-html/vendor/marked.min.js`.
  The complete upstream [license and attribution](docs/third-party/marked-15.0.4-LICENSE.md)
  are reproduced from [the upstream tag](https://github.com/markedjs/marked/tree/v15.0.4).

Dependencies installed by npm are not bundled in this source archive. Their
license notices remain part of the corresponding installed packages. The
prototype's MIT license does not replace the notices of vendored libraries.
