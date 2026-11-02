# Development dependency security baseline

## Scope and decision

The development host is pinned to Pi/TUI **1.5.0**. The extension's supported peer floor remains **0.84.3**, and CI continues to test 0.84.3, 0.87.1, 0.99.1, 1.1.0, 1.2.0, and 1.5.0. Updating the development host does not update a user's installed extension tag or Pi settings.

GitHub reported six alerts in the old development lock: four high and one moderate for Undici 8.10.2, and one moderate for minimatch 10.2.6. These packages were transitive development dependencies of Pi, not dependencies shipped by this extension. Development-only scope does not make them harmless: running the development host can use networking and glob matching.

Pi 1.5 declares **Undici 8.12.3** and **minimatch 11.0.3**, which include the applicable fixes. Using the host's own supported versions avoids forcing a major minimatch upgrade underneath the older Pi 1.1 host. No root package-version overrides are required. The lockfile and metadata test record these reviewed versions, including nested copies.

| Package | GitHub advisory | Issue | First patched version |
| --- | --- | --- | --- |
| Undici | [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) | Excessive content encodings can cause an unhandled error | 8.12.2 |
| Undici | [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm) | TLS certificate-changing renegotiation denial of service | 8.12.2 |
| Undici | [GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) | Dropped TLS verification options in Agent | 8.12.2 |
| Undici | [GHSA-4w7w-5xrc-9h26](https://github.com/advisories/GHSA-4w7w-5xrc-9h26) | Cross-origin redirect cache poisoning/disclosure | 8.12.2 |
| Undici | [GHSA-9fm3-97px-rjf6](https://github.com/advisories/GHSA-9fm3-97px-rjf6) | Unbounded automatic WebSocket PONG buffering | 8.12.2 |
| minimatch | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | Globparts amplification denial of service | 11.0.1 |

The [Undici 8.12.2 release notes](https://github.com/nodejs/undici/releases/tag/v8.12.2) also describe fixes for EventSource retention, SRI token normalization, and decompression errors found by the local audit. The [minimatch 10-to-11 comparison](https://github.com/isaacs/minimatch/compare/v10.2.6...v11.0.0) shows a matcher rewrite, removed debug/internal subclass API surface, and corrected Windows UNC and glob matching. This extension does not import either package directly; Pi 1.5 consumes the public `minimatch()` API. Keep the major globbing change with this explicit development-host migration rather than silently overriding older compatibility hosts.

## Installation policy

The operator authorized a **one-time, command-scoped** `npm install --ignore-scripts --min-release-age=0` for this security baseline upgrade. Pi 1.5 and the fixed minimatch release were younger than the saved minimum age at the time of installation. The persistent npm `min-release-age` remains **7**; do not save an exception in project/user npm configuration or assume future bypass permission. Lifecycle scripts remain disabled.

Normal dependency installation and the host-check harness retain the saved age policy. Subsequent `npm ci --ignore-scripts` replays the reviewed lockfile without a release-age override; that command was also verified during this upgrade. A clean lockfile does not imply a live registry audit will always remain clean; rerun it when maintaining dependencies.

## Verification

Run:

```powershell
npm run check
npm audit
npm ls undici minimatch --all
npm config get min-release-age
```

`check` includes typechecking, unit tests, and real-process/codemode integration tests. The codemode suite uses a faux provider and does not call a paid model. Test the peer floor and older hosts through `npm run test:host -- --version <version>`; historical compatibility fixtures deliberately preserve their host's dependency versions and are not certified as vulnerability-free. Do not reuse old fixtures as a security-updated general-purpose Pi installation.

The installed-host smoke option is distinct from a clean pinned fixture, and neither substitutes for the six-job GitHub compatibility matrix. Report the actual hosted run result before claiming CI success.

## Visual verification status

Regular/fullscreen interactive visual smoke checks are **deferred by the operator**, not passed. Native desktop automation was unavailable (`orca` was not recognized as an executable). Existing component tests cover configured hints, cache invalidation, timing, padding, focus, and resizing, but are not visual certification. The manual checklist remains in the README. No installed extension tag was changed to perform these checks.
