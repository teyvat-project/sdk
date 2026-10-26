# CatalystSDK

Official Catalyst SDKs for any programming languages.

Every SDK is generated from the Catalyst OpenAPI spec by [archon](https://www.npmjs.com/package/@natsuneko-laboratory/archon) and wrapped in a thin handwritten layer (`Catalyst` client, OAuth authorization code + PKCE, token refresh, `User-Agent`). GitHub Actions checks the spec every 6 hours and releases new SDKs automatically.

## Projects

| Name           | Programming Languages             | Location          | Distribution                                                      | Tag (this repo)   | README                                |
| -------------- | --------------------------------- | ----------------- | ----------------------------------------------------------------- | ----------------- | ------------------------------------- |
| CatalystSwift  | Swift                             | `packages/swift`  | Mirrored to [mika-f/CatalystSwift](https://github.com/mika-f/CatalystSwift) (SwiftPM) | `swift/v<version>` | [README](./packages/swift/README.md)  |
| CatalystSharp  | C# / .NET                         | `packages/dotnet` | NuGet (`CatalystSharp`)                                           | `dotnet/v<version>` | [README](./packages/dotnet/README.md) |
| CatalystKotlin | Kotlin / Java / JVM               | `packages/kotlin` | GitHub Release assets only (jar / sources jar / pom)              | `kotlin/v<version>` | [README](./packages/kotlin/README.md) |
| CatalystTS     | TypeScript / JavaScript / Node.js | `packages/nodejs` | npm (`@natsuneko-laboratory/catalyst-sdk`)                        | `nodejs/v<version>` | [README](./packages/nodejs/README.md) |

SwiftPM only resolves a `Package.swift` at the repository root and tags without a prefix, so the Swift package is mirrored to `mika-f/CatalystSwift`, where the tag is the bare version (for example `2026.10.25`). Kotlin is not published to a registry (Maven Central is not supported yet); download the jar from the GitHub Release.

## Breaking changes

This is a rewrite. The handwritten clients and models are gone, replaced by archon-generated clients plus a thin `Catalyst` layer.

- npm: `1.0.0-alpha.17` -> `2026.x`. The package is now ESM only; CommonJS `require()` is no longer supported.
- NuGet: `0.1.0` -> `2026.x` (target framework is now `net10.0`)
- Swift / Kotlin: the old APIs are replaced; see each package README for the new usage.

## Versioning

The version comes from `info.version` of the OpenAPI spec (`YYYY.MM.DD`) with leading zeros removed (`2026.01.05` -> `2026.1.5`). All four SDKs share the same version.

- Automatic releases are prereleases: `<base>-beta.N`. `N` is shared by all languages and is the highest existing `*/v<base>-beta.*` git tag plus one (1 for the first).
- Stable releases (`<base>`) are promoted by hand. They are published to the `latest` npm dist-tag; betas use `beta`. Until the first stable release, `latest` still points to the old `1.0.0-alpha.17`, so install betas with `npm install @natsuneko-laboratory/catalyst-sdk@beta`.
- Once a stable `<base>` is released, no more betas of it are made: if the spec changes but `info.version` stays the same, the monitor run fails until the API bumps `info.version`.

## How it works

- [`ci.yml`](./.github/workflows/ci.yml): on pull requests and pushes to `main`. Regenerates the clients and fails on any difference, including untracked generated files; runs the script tests and builds and tests every language (Swift on `macos-15`, because the handwritten PKCE uses CryptoKit).
- [`monitor.yml`](./.github/workflows/monitor.yml): every 6 hours (and manually), only from `main`. Fetches `https://api.natsuneko.com/openapi.json`, compares it with `openapi/openapi.json`, and on a difference computes the beta version, regenerates, builds and tests all languages, commits to `main` as `github-actions[bot]`, then dispatches `release.yml` with `channel=beta`. The regeneration patch may only touch `openapi/openapi.json` and the generated directories (`scripts/check-patch-paths.mjs` checks it before every `git apply`), and the job that pushes runs no code from it.
- [`release.yml`](./.github/workflows/release.yml): `workflow_dispatch` only, only from `main`, and the commit must be an ancestor of `origin/main`. It is the single OIDC trust target. Each of nodejs / dotnet / kotlin is split into a `build-<lang>` job (read-only, no environment, runs project code) and a `publish-<lang>` job (environment, `id-token` / `attestations` / `contents: write`, runs no project code). Swift is a single job that mirrors to `CatalystSwift`. Each language gets a draft GitHub Release with attested assets, then the registry publish, then the release is published, which creates the immutable `<lang>/v<version>` tag.

## Promote a beta to stable

```sh
gh workflow run release.yml -f channel=stable -f version=2026.10.25
```

`sha` can be omitted; the commit of the latest `nodejs/v2026.10.25-beta.*` tag is used, so exactly the tested code becomes stable. This fails if any `<lang>/v2026.10.25` tag already exists.

## Verifying a release

```sh
# Release and tag are immutable and match the recorded attestation
gh release verify nodejs/v2026.10.25 --repo mika-f/CatalystSDK

# Provenance of a release asset
gh release download nodejs/v2026.10.25 --repo mika-f/CatalystSDK --pattern '*.tgz'
gh attestation verify natsuneko-laboratory-catalyst-sdk-2026.10.25.tgz --repo mika-f/CatalystSDK

# npm provenance and registry signatures (run in a project that installed the package)
npm audit signatures
```

## Operations

- Beta numbering counts git tags only. A beta whose releases all stayed drafts has no tag, so the next monitor run would reuse the same number and fail; delete those drafts first.
- Partial failures: use "Re-run failed jobs" on the failed `release.yml` run. Build artifacts are kept for 7 days, and GitHub allows re-runs for 30 days. A language that is already published is skipped, an existing draft is reused, and a version already on a registry is skipped when its draft exists.
- If a registry (or the Swift mirror) already has the version but no matching draft exists, the job fails with "Resolve manually" instead of publishing. Mirror releases must reference `mika-f/CatalystSDK@<sha>`.
- A stable version cannot be dispatched again once any `<lang>/v<base>` tag exists, and `next-version.mjs beta` refuses a base that has a stable tag ("stable <base> already released; the API must bump info.version"), so the `detect` job of `monitor.yml` fails before anything is committed.
- If `monitor.yml` pushed the regeneration commit but the dispatch step failed, run `release.yml` manually with `channel=beta`, the version shown by the `detect` job (the "Beta version" notice in the run summary, also its `version` output), and the pushed commit SHA.
- A regeneration patch that touches anything other than `openapi/openapi.json` and the generated directories fails the build jobs ("regeneration patch rejected") and is never committed. Investigate the generator and its dependencies before re-running.

## Development

```sh
pnpm install --frozen-lockfile
pnpm generate          # archon generate (writes generated code under packages/*)
pnpm run test:scripts  # node --test "scripts/*.test.mjs"
pnpm -r test           # Node.js package tests
```

Generated directories are cleaned on every run; never edit them by hand. Language manifests (`package.json`, `Package.swift`, `.csproj`, `build.gradle.kts`) and the thin layer are handwritten.

## Manual GitHub setup

The workflows need the following one-time settings. No long-lived registry token is stored; the only secret is the GitHub App private key.

1. **npm**: on `@natsuneko-laboratory/catalyst-sdk`, set the Trusted Publisher to repository `mika-f/CatalystSDK`, workflow `release.yml`, environment `npm`. (Migrating from the old `publish-nodejs.yml` entry.)
2. **NuGet**: create a Trusted Publishing policy for repository `mika-f/CatalystSDK`, workflow `release.yml`, **bound to environment `nuget`**. The environment binding is mandatory.
3. **Immutable Releases**: enable on both `mika-f/CatalystSDK` and `mika-f/CatalystSwift`.
4. **Tag rulesets**: in `CatalystSDK` for `*/v*`, and in `CatalystSwift` for `*`, forbid update and deletion, and restrict creation to GitHub Actions / the GitHub App.
5. **Branch rulesets**: allow direct pushes to `main` only from GitHub Actions (`CatalystSDK`) and the GitHub App (`CatalystSwift`). The mirror commits are unsigned, so `CatalystSwift` must not require signed commits on `main`, or the App must be a bypass actor.
6. **Environments**: create `npm`, `nuget`, `swift-mirror` and `kotlin`, and restrict deployment to the `main` branch.
7. **GitHub App** for the mirror: install it only on `mika-f/CatalystSwift` with `contents: write`. Store the App ID as variable `SWIFT_MIRROR_APP_ID` and the private key as secret `SWIFT_MIRROR_APP_PRIVATE_KEY`, both in the `swift-mirror` environment.

## License

MIT by [@6jz](https://twitter.com/6jz)
