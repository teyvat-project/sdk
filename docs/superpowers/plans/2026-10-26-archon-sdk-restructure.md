# archon による SDK 再構成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 4 言語の SDK を archon で生成し、6 時間ごとの spec 監視から OIDC Publishing と Immutable Release までを自動化する。

**Architecture:** ルートの `archon.config.ts` が `openapi/openapi.json` から各 `packages/<lang>` の生成ディレクトリに出力する。各パッケージは手書きの manifest と薄い手書き層（Catalyst クライアントの組み立てと PKCE）を持つ。`monitor.yml` が再生成して main に push し、`workflow_dispatch` で `release.yml` を起動する。

**Tech Stack:** `@natsuneko-laboratory/archon@0.1.1`、pnpm 11.28.8、Node 24、tsdown、vitest、Swift 6（SwiftPM, XCTest）、.NET 10（xUnit）、Kotlin 2.4.21 / Gradle 8.12 / ktor 3.6.0、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-26-archon-sdk-restructure-design.md`

## Global Constraints

- archon は `0.1.1` を exact 指定する。パッケージマネージャは `packageManager: "pnpm@11.28.8"`。
- 生成物には手を入れない。生成ディレクトリは次の 4 つ。
  - `packages/nodejs/src/generated`
  - `packages/swift/Generated`
  - `packages/dotnet/CatalystSharp/Generated`
  - `packages/kotlin/src/generated/kotlin`
- 生成モジュール名: TS は（モジュール名なし）、Swift は `CatalystAPI`、C# は `CatalystSharp.Api`、Kotlin は `com.natsuneko.catalyst.api`。
- 手書き層の公開名: TS / Swift / C# / Kotlin のいずれも `Catalyst` クラスと `OAuth`（C# は `OAuthClient`、Kotlin は `OAuthClient`）、`Pkce`（TS は `PKCE`）、`Token`。
- エンドポイント: token は `<baseUrl>/token`（既定 `https://api.natsuneko.com/token`）、authorize は `https://accounts.natsuneko.com/authorize`。
- User-Agent: `CatalystTS` / `CatalystSwift` / `CatalystSharp` / `CatalystKotlin`。
- リポジトリ内の manifest の version は `0.0.0-dev` とする。実際の version はリリース時に注入する（npm: `npm version --no-git-tag-version`、dotnet: `-p:Version=`、gradle: `-Pversion=`）。
- npm パッケージ名は `@natsuneko-laboratory/catalyst-sdk`（ESM のみ）。NuGet の PackageId は `CatalystSharp`（net10.0）。Kotlin の group は `com.natsuneko.catalyst`、artifact は `catalyst-kotlin`（JVM 11）。
- 版番号: base = `info.version` の各要素から先頭の 0 を除いたもの。beta は `<base>-beta.N`（N は全言語で共通、既存 `*/v<base>-beta.*` の最大値 + 1）。stable は `<base>`。タグは `<lang>/v<version>`（lang は `nodejs` / `swift` / `dotnet` / `kotlin`）。Swift のミラー側のタグは素の `<version>`。
- action はすべてコミット SHA で固定し、行末に `# vX.Y.Z` を書く。既存の固定値はそのまま使う。
  - `actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2`
  - `actions/setup-node@6044e13b5dc448c55e2357c09f80417699197238 # v6.2.0`
  - `pnpm/action-setup@41ff72655975bd51cab0327fa583b6e92b6d3061 # v4.2.0`
  - `actions/setup-dotnet@baa11fbfe1d6520db94683bd5c7a3818018e4309 # v5.1.0`
  - `NuGet/login@d22cc5f58ff5b88bf9bd452535b4335137e24544 # v1.1.0`
  - 新たに使う action は、`gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object.sha` で最新リリースの SHA を取得して固定する（annotated tag の場合は `git/tags/<sha>` をもう一段たどる）。
- 全 workflow の最上位は `permissions: {}`。
- **spec からの変更（Task 10 で spec にも反映）:** 手書きの PKCE は CryptoKit を使う。そのため Swift の CI は ubuntu コンテナではなく `macos-15` で実行する。

## Review Focus

1. **アクセストークン未設定での呼び出し** → bearer 必須の操作は、送信前に archon の `AuthError` で失敗する（`Authorization: Bearer ` のような空ヘッダを送らない）。各言語の Task の test 4 で固定する。
2. **401 が同時に複数返る** → refresh リクエストは 1 回だけ送り、全リクエストが新トークンで再送される。各言語の Task の test 3。
3. **refresh 自体が失敗する（400）** → 元の 401 がそのまま ApiError として返り、無限ループしない。トークンも変わらない。各言語の Task の test 5。
4. **spec の取得結果が JSON でない、または `info.version` がない** → `monitor.yml` は失敗し、スナップショットは変更しない。Task 2 の `normalizeSpec` のテスト。
5. **`info.version` が `2026.01.05` や 4 要素などの形式** → 前者は `2026.1.5` に正規化し、後者はエラーにする。Task 2 の `normalizeVersion` のテスト。

---

### Task 1: ルートの archon セットアップと旧コードの削除

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `archon.config.ts`, `openapi/openapi.json`, `.gitignore`
- Delete: `CatalystSDK.sln`
- Delete（nodejs）: `packages/nodejs/{openapi-ts.config.ts,pnpm-lock.yaml,pnpm-workspace.yaml}`、`packages/nodejs/src/{CatalystTS.ts,interceptors/,generated/}`
- Delete（swift）: `packages/swift/Sources/CatalystSwift/` 全体
- Delete（dotnet）: `packages/dotnet/CatalystSharp/{Clients,Exceptions,Http,Models}/`、`CatalystSharpClient.cs`、`CatalystConstants.cs`
- Delete（kotlin）: `packages/kotlin/src/main/kotlin/com/natsuneko/catalyst/` 配下の `auth/` 以外
- 残すもの（Task 3〜6 で書き換える）: nodejs の `src/oauth/`・`src/types/`、dotnet の `Auth/`、kotlin の `auth/`
- Generated: 上記 4 つの生成ディレクトリ

**Interfaces:**
- Produces: `pnpm generate`（= `archon generate`）。生成物の公開 API は以下のとおり（プローブで確認済み）。
  - TS: `createApiClient(config?: Partial<ClientConfig<ApiAuth>>): Client<ApiAuth>`、`ApiAuth = { bearerAuth?: TokenValue }`、`retry401Middleware({ onUnauthorized })`、`userAgentMiddleware(value)`、`AuthError`、`ApiError`、操作関数（例: `postToken`）
  - Swift: `ApiClient(baseUrl:auth:headers:timeout:middleware:transport:customAuth:)`、`client.options`（setter あり）、`ApiAuth(bearerAuth:)`、`Retry401Middleware(onUnauthorized:)`、`UserAgentMiddleware(_:)`、`HTTPTransport`、`AccessTokenResponse`
  - C#: `new ApiClient(ApiClientOptions)`、`options.Auth = new ApiAuth { BearerAuth = … }`、`Retry401Middleware(Func<CallContext, ApiResponse, CancellationToken, ValueTask<bool>>)`、`UserAgentMiddleware`、`AccessTokenResponse`
  - Kotlin: `ApiClient(ApiClientOptions)`、`options.auth = ApiAuth(bearerAuth = TokenValue(…))`、`Retry401Middleware(suspend (CallContext, ApiResponse) -> Boolean)`、`UserAgentMiddleware(value)`、`AccessTokenResponse`
  - サービスは全言語共通で `catalyst` / `media` / `egeria` / `epiclese` / `featureFlags` / `giftia` / `steambird` / `credentials`。

- [ ] **Step 1: ルートの `package.json` を作成する**
  - `private: true`、`type: module`
  - `packageManager: "pnpm@11.28.8"`
  - `engines.node: ">=22.19.0"`
  - `devDependencies`: `"@natsuneko-laboratory/archon": "0.1.1"`
  - `scripts`: `generate` = `archon generate`、`test:scripts` = `node --test scripts/`
- [ ] **Step 2: `pnpm-workspace.yaml` を作成する**
  - `packages: [packages/nodejs]`
  - `onlyBuiltDependencies: []`（lifecycle script を許可しない）
- [ ] **Step 3: `archon.config.ts` を作成する**
  - spec §1 の「archon 設定」をそのまま使う。各プラグインの `output` と `moduleName` / `namespace` / `packageName` は Global Constraints の値にする。
- [ ] **Step 4: `openapi/openapi.json` を作成する**
  - Task 2 の `normalizeSpec` と同じ形式にする（`JSON.stringify(JSON.parse(body), null, 2) + '\n'`）。
  - 取得: `curl -fsS https://api.natsuneko.com/openapi.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s),null,2)+"\n"))' > openapi/openapi.json`
- [ ] **Step 5: 旧コードを削除し、`.gitignore` を作成する**
  - 上の Files の Delete 項目を `git rm -r` で削除する。
  - `.gitignore` には `node_modules/` を書く。
- [ ] **Step 6: 生成を実行する**
  - Run: `corepack enable && pnpm install && pnpm generate`
  - Expected: 終了コード 0。4 つの生成ディレクトリができる（例: `packages/swift/Generated/Sources/CatalystAPI/ApiClient.swift`、`packages/nodejs/src/generated/client.gen.ts`）。
- [ ] **Step 7: 生成が冪等であることを確認する**
  - Run: `git add -A && pnpm generate && git diff --exit-code`
  - Expected: 終了コード 0（差分なし）
- [ ] **Step 8: Commit**
  - メッセージ: `chore: generate SDKs with archon and remove legacy handwritten clients`

### Task 2: spec 正規化と採番スクリプト

**Files:**
- Create: `scripts/spec.mjs`, `scripts/spec.test.mjs`, `scripts/next-version.mjs`, `scripts/next-version.test.mjs`

**Interfaces:**
- Produces:
  - `scripts/spec.mjs`
    - export `normalizeSpec(body: string): string`
    - CLI: `node scripts/spec.mjs <url> <path>`。`changed=true|false` を stdout に出力する。changed のときだけ `<path>` を上書きする。
  - `scripts/next-version.mjs`
    - export `normalizeVersion(v: string): string`
    - export `nextBeta(base: string, tags: string[]): string`
    - export `assertStableAvailable(base: string, tags: string[]): void`
    - export `latestBetaTag(base: string, tags: string[]): string | undefined`（`nodejs/v<base>-beta.N` のうち N が最大のもの）
    - CLI（タグは `git tag -l` から取得し、結果を stdout に 1 行で出す）:
      - `node scripts/next-version.mjs beta --spec <path>` → `2026.10.25-beta.3`
      - `node scripts/next-version.mjs stable --version <base>` → 検証して `<base>` を出す
      - `node scripts/next-version.mjs latest-beta --version <base>` → タグ名を出す

- [ ] **Step 1: 失敗するテストを書く（`node:test` + `node:assert/strict`）**
  - `normalizeSpec`
    - `normalizeSpec('{"openapi":"3.1.0","info":{"version":"1"}}')` は、2 スペースでインデントし末尾に `\n` を付けた文字列を返す。キー順は入力のまま。
    - `normalizeSpec('<html>')` は throw する。
    - `normalizeSpec('{"openapi":"3.1.0","info":{}}')` は throw し、メッセージに `info.version` を含む。
  - `normalizeVersion`
    - `'2026.10.25'` → `'2026.10.25'`、`'2026.01.05'` → `'2026.1.5'`、`'2026.0.0'` → `'2026.0.0'`
    - `'2026.10'`・`'2026.10.25.1'`・`'v2026.10.25'`・`'2026.10.x'` はいずれも throw する。
  - `nextBeta`
    - `('2026.10.25', [])` → `'2026.10.25-beta.1'`
    - `('2026.10.25', ['nodejs/v2026.10.25-beta.1', 'swift/v2026.10.25-beta.2', 'nodejs/v2026.10.24-beta.9', 'nodejs/v2026.10.25'])` → `'2026.10.25-beta.3'`
    - `('2026.10.25', ['nodejs/v2026.10.25-beta.10', 'nodejs/v2026.10.25-beta.9'])` → `'2026.10.25-beta.11'`（数値で比較する）
  - `assertStableAvailable`
    - `('2026.10.25', ['dotnet/v2026.10.25'])` は throw する。
    - `('2026.10.25', ['dotnet/v2026.10.25-beta.1'])` は throw しない。
  - `latestBetaTag`
    - `('2026.10.25', ['nodejs/v2026.10.25-beta.2', 'nodejs/v2026.10.25-beta.10', 'swift/v2026.10.25-beta.11'])` → `'nodejs/v2026.10.25-beta.10'`
    - `('2026.10.25', [])` → `undefined`
- [ ] **Step 2: テストが失敗することを確認する**
  - Run: `node --test scripts/`
  - Expected: FAIL（module not found）
- [ ] **Step 3: 実装する**
  - 上の Interfaces の signature で `scripts/spec.mjs` と `scripts/next-version.mjs` を実装する。CLI 部分は `import.meta.url === pathToFileURL(process.argv[1]).href` のときだけ動かす。
  - `spec.mjs` の CLI は `fetch(url)` を使い、`!res.ok` なら throw する。
- [ ] **Step 4: テストが通ることを確認する**
  - Run: `node --test scripts/`
  - Expected: PASS
  - あわせて `node scripts/next-version.mjs beta --spec openapi/openapi.json` を実行し、`2026.10.25-beta.1` が出ることを確認する（ローカルに 2026.10.25 のタグがないこと前提）。
- [ ] **Step 5: Commit**
  - メッセージ: `feat(scripts): add spec normalization and release versioning`

### 手書き層の共通仕様（Task 3〜6）

全言語で同じ振る舞いにする。テストは各言語の HTTP モック（TS: `fetch` の差し替え、Swift: `HTTPTransport` 実装、C#: `HttpMessageHandler`、Kotlin: `ktor-client-mock`）で書く。

- **`Catalyst` のコンストラクタ引数:** `clientId`、`clientSecret`、`accessToken?`、`refreshToken?`、`baseUrl?`（既定 `https://api.natsuneko.com`）、`middleware?`、`onTokenRefreshed?(Token)`、HTTP の差し替え口（TS: `fetch`、Swift: `transport`、C#: `HttpClient`、Kotlin: `HttpClient`）
- **公開メンバー:**
  - `api` / `client`（生成クライアント。TS は `client: Client<ApiAuth>`、他言語は `api: ApiClient`）
  - `oauth`
  - `accessToken` / `refreshToken`（読み取り）
  - `setCredential(accessToken, refreshToken?)`
  - `clearCredential()`
  - `refresh()`（非同期で `Token` を返す）
- **認証の接続:**
  - トークンがあるときは、生成クライアントの auth を `{ bearerAuth: <accessToken> }` にする。トークンがないときは auth を未設定にする（Review Focus 1）。
  - 更新時は生成クライアントの設定を差し替える（TS: `client.setConfig({ auth })`、Swift: `api.options.auth`、C#: `api.Options.Auth`、Kotlin: `api.options.auth`）。
- **middleware の順序:** 利用者の middleware → `UserAgentMiddleware(<UA>)` → `Retry401Middleware`。
  - `Retry401Middleware` の `onUnauthorized` は、refreshToken がなければ `false` を返す。
  - refreshToken があれば single-flight の `refresh()` を await して `true` を返す。refresh が失敗したら `false` を返す（Review Focus 3）。
- **`refresh()`:**
  - `<baseUrl>/token` に `application/x-www-form-urlencoded` で `grant_type=refresh_token`、`refresh_token`、`client_id`、`client_secret` を POST する。
  - 成功したら `setCredential` 相当の更新を行い、`onTokenRefreshed` を呼ぶ。
  - 同時に呼ばれたときは 1 回だけ POST する。
  - レスポンスは生成型 `AccessTokenResponse` にデコードし、`Token`（`accessToken`、`refreshToken`、`tokenType`、`scope?`、`expiresAt?`、`expiresIn?`）に写す。
  - archon が生成した `credentials.postToken` は使わない。spec の requestBody が `grant_type` しか定義していないため。
- **`OAuth`:** 既存の TS 実装（`packages/nodejs/src/oauth/oauth.ts`）と同じメソッドを各言語の命名規則で持つ。
  - `getAuthorizeURL(redirectUri, pkce, state)`
  - `getAuthorizationCode(callbackUrl, expectedState, expectedRedirectUri)`
  - `getAccessTokenByCode(code, redirectUri, pkce)`（form: `grant_type=authorization_code`、`code`、`redirect_uri`、`client_id`、`code_verifier`）
  - `getAccessTokenByRefreshToken(refreshToken)`
  - エラー種別は `authorizationRequestFailed` / `invalidAuthorizationResponse` / `invalidTokenResponse`。
- **`Pkce`:** `create()` は 32 バイトの乱数を base64url（パディングなし）にした verifier を作り、challenge は SHA-256 の base64url、`method = "S256"`。テスト用に verifier を指定して作る入口（TS: `PKCE.fromVerifier(v)`、他言語も同名）を持つ。

**各言語で書くテスト（同名・同じアサーション）:**
1. `sendsBearerToken`: `accessToken: "at1"` で任意の bearer 必須操作（`catalyst` サービスの GET 操作を 1 つ選ぶ）を呼ぶと、リクエストの `Authorization` が `Bearer at1`、`User-Agent` が UA 定数になる。
2. `refreshesOn401AndRetries`: 1 回目のレスポンスが 401、`/token` が `{"access_token":"at2","refresh_token":"rt2","token_type":"Bearer","scope":"read write","expires_at":"2026-10-26T00:00:00Z","expires_in":3600}`、2 回目が 200 を返すとする。このとき、token のフォームが `grant_type=refresh_token&refresh_token=rt1&client_id=cid&client_secret=cs` を含み、再送の `Authorization` が `Bearer at2` になり、`onTokenRefreshed` が `accessToken == "at2"` で 1 回呼ばれ、`catalyst.refreshToken == "rt2"` になる。
3. `concurrent401sRefreshOnce`: 2 つの呼び出しを同時に投げ、両方が 401 を受けたとき、`/token` へのリクエストは 1 回で、両方とも成功する。
4. `missingTokenThrowsAuthError`: トークンなしで bearer 必須操作を呼ぶと、archon の AuthError 型で失敗し、HTTP リクエストは 0 回。
5. `failedRefreshReturnsOriginal401`: `/token` が 400 のとき、呼び出しは 401 の ApiError で失敗し、`accessToken` は `"at1"` のまま、`/token` は 1 回。
6. `pkceMatchesRfc7636Vector`: `fromVerifier("dBjftJeZ4CVP-mJ92kHnVlpgs1HbUg3KvLrrFZy0_bM").challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"`
7. `authorizeUrlHasParams`: `getAuthorizeURL("app://cb", pkce, "st")` のクエリが `response_type=code`、`client_id=cid`、`redirect_uri=app://cb`、`state=st`、`code_challenge=<challenge>`、`code_challenge_method=S256`。
8. `authorizationCodeRejectsStateMismatch`: `app://cb?code=c&state=other` を `expectedState="st"` で検証すると、`invalidAuthorizationResponse` で失敗する。`app://cb?code=c&state=st` なら `"c"` を返す。

### Task 3: Node.js パッケージ

**Files:**
- Modify: `packages/nodejs/package.json`、`packages/nodejs/tsconfig.json`、`packages/nodejs/README.md`、`packages/nodejs/src/index.ts`
- Create: `packages/nodejs/src/catalyst.ts`、`packages/nodejs/tsdown.config.ts`、`packages/nodejs/test/catalyst.test.ts`、`packages/nodejs/test/oauth.test.ts`
- Modify: `packages/nodejs/src/oauth/oauth.ts`（`fetch` と endpoint を注入可能にする）、`packages/nodejs/src/oauth/pkce.ts`（`fromVerifier` を追加）、`packages/nodejs/src/types/{token.ts,constants.ts}`（GraphQL 定数は削除）

**Interfaces:**
- Consumes: Task 1 の TS 生成物（`./generated/index.js`）
- Produces:
  - `export class Catalyst { constructor(opts: CatalystOptions); readonly client: Client<ApiAuth>; readonly oauth: OAuth; get accessToken(): string | undefined; get refreshToken(): string | undefined; setCredential(accessToken: string, refreshToken?: string): void; clearCredential(): void; refresh(): Promise<Token> }`
  - `export interface CatalystOptions { clientId: string; clientSecret: string; accessToken?: string; refreshToken?: string; baseUrl?: string; middleware?: Middleware[]; fetch?: FetchLike; onTokenRefreshed?: (token: Token) => void | Promise<void> }`
  - `src/index.ts` は `export * from './generated/index.js'` に加えて、`Catalyst`、`CatalystOptions`、`OAuth`、`OAuthError`、`PKCE`、`Token` を export する。

- [ ] **Step 1: `package.json` を書き換える**
  - `version: "0.0.0-dev"`、`type: "module"`
  - `exports: { ".": { "types": "./dist/index.d.mts", "import": "./dist/index.mjs" } }`
  - `files: ["dist"]`
  - scripts: `build` = `tsdown`、`test` = `vitest run`、`typecheck` = `tsc --noEmit`
  - devDependencies: `tsdown`、`typescript`、`vitest`、`@types/node`（いずれも `pnpm add -D` で入れた時点の最新）
  - `publishConfig: { access: "public" }`、`repository.directory: "packages/nodejs"`
  - `tsconfig.json` は archon が前提とする `strict` / `ES2022` / `lib [ES2022, DOM]` / `NodeNext` にする。
- [ ] **Step 2: 失敗するテストを書く**
  - 「手書き層の共通仕様」の 8 テストを `test/catalyst.test.ts`（1〜5）と `test/oauth.test.ts`（6〜8）に書く。fetch は `CatalystOptions.fetch` で差し替える。
- [ ] **Step 3: テストが失敗することを確認する**
  - Run: `pnpm --filter @natsuneko-laboratory/catalyst-sdk test`
  - Expected: FAIL（`Catalyst` が未定義）
- [ ] **Step 4: 実装する**
  - `src/catalyst.ts` に `Catalyst` を実装し、`src/oauth/*` を修正する。
  - `tsdown.config.ts` は `entry: ['src/index.ts']`、`format: ['esm']`、`dts: true`。
- [ ] **Step 5: テスト・型チェック・ビルドが通ることを確認する**
  - Run: `pnpm --filter @natsuneko-laboratory/catalyst-sdk run typecheck && pnpm --filter @natsuneko-laboratory/catalyst-sdk test && pnpm --filter @natsuneko-laboratory/catalyst-sdk build && (cd packages/nodejs && npm pack --dry-run)`
  - Expected: 全部 PASS。pack の一覧に `dist/index.mjs` と `dist/index.d.mts` が含まれる。
- [ ] **Step 6: README を書き換える**
  - インストール方法、`Catalyst` の使い方、生成関数を `client: catalyst.client` で呼ぶ例、PKCE フローを書く。
- [ ] **Step 7: Commit**
  - メッセージ: `feat(nodejs): rebuild CatalystTS on archon-generated client`

### Task 4: Swift パッケージ

**Files:**
- Create: `packages/swift/Package.swift`（上書き）、`packages/swift/Sources/CatalystSwift/{Exports.swift,Catalyst.swift,OAuth.swift,PKCE.swift,Token.swift,Constants.swift}`
- Create: `packages/swift/Tests/CatalystSwiftTests/{CatalystTests.swift,OAuthTests.swift,MockTransport.swift}`（既存の `CatalystSwiftTests.swift` は削除）
- Modify: `packages/swift/README.md`

**Interfaces:**
- Consumes: Task 1 の Swift 生成物（`Generated/Sources/CatalystAPI`、`Generated/Sources/CatalystAPICore`）
- Produces:
  - `Package.swift`
    - targets: `CatalystAPICore`（path `Generated/Sources/CatalystAPICore`）、`CatalystAPI`（path `Generated/Sources/CatalystAPI`、deps `CatalystAPICore`）、`CatalystSwift`（deps `CatalystAPI`）、`CatalystSwiftTests`
    - product: `.library(name: "CatalystSwift", targets: ["CatalystSwift"])`
    - platforms: archon の生成物と同じ `.macOS(.v12), .iOS(.v15), .tvOS(.v15), .watchOS(.v8), .visionOS(.v1)`
  - `Exports.swift`: `@_exported import CatalystAPI`
  - `public final class Catalyst: Sendable`
    - `init(clientId:clientSecret:accessToken:refreshToken:baseUrl:middleware:transport:onTokenRefreshed:)`
    - `let api: ApiClient`、`let oauth: OAuth`
    - `var accessToken: String? { get async }`、`var refreshToken: String? { get async }`
    - `func setCredential(accessToken: String, refreshToken: String?) async`、`func clearCredential() async`
    - `func refresh() async throws -> Token`
    - 可変状態は内部の `actor` に持たせ、single-flight は actor 内の `Task<Token, Error>?` で行う。
  - `public struct PKCE: Sendable { static func create() -> PKCE; static func fromVerifier(_:) -> PKCE; let verifier, challenge: String; let method = "S256" }`（CryptoKit）

- [ ] **Step 1: 失敗するテストを書く**
  - 共通仕様の 8 テストを XCTest で書く。`test` を接頭辞にし、`async` にする。`MockTransport` は生成物の `HTTPTransport` に準拠させ、受け取ったリクエストを記録し、URL のパスに応じて返すレスポンスを切り替える。
- [ ] **Step 2: テストが失敗することを確認する**
  - Run: `cd packages/swift && swift test`
  - Expected: コンパイルエラーで FAIL（`Catalyst` が未定義）
- [ ] **Step 3: Interfaces のとおり `Package.swift` と `Sources/CatalystSwift/*` を実装する**
- [ ] **Step 4: テストが通ることを確認する**
  - Run: `cd packages/swift && swift test`
  - Expected: PASS（8 tests）
- [ ] **Step 5: README を書き換える**
  - `.package(url: "https://github.com/mika-f/CatalystSwift.git", from: "2026.10.25")` と使い方を書く。
- [ ] **Step 6: Commit**
  - メッセージ: `feat(swift): rebuild CatalystSwift on archon-generated client`

### Task 5: .NET パッケージ

**Files:**
- Modify: `packages/dotnet/CatalystSharp/CatalystSharp.csproj`、`packages/dotnet/CatalystSharp.slnx`、`packages/dotnet/README.md`
- Create: `packages/dotnet/CatalystSharp/{Catalyst.cs,CatalystOptions.cs,Token.cs}`
- Modify: `packages/dotnet/CatalystSharp/Auth/{OAuthClient.cs,Pkce.cs}`（共通仕様に合わせる）
- Create: `packages/dotnet/CatalystSharp.Tests/{CatalystSharp.Tests.csproj,CatalystTests.cs,OAuthTests.cs,MockHandler.cs}`

**Interfaces:**
- Consumes: Task 1 の C# 生成物（namespace `CatalystSharp.Api`、`CatalystSharp.Api.Core`）
- Produces:
  - `public sealed class Catalyst`（namespace `CatalystSharp`）
    - `Catalyst(CatalystOptions options)`
    - `ApiClient Api { get; }`、`OAuthClient OAuth { get; }`
    - `string? AccessToken { get; }`、`string? RefreshToken { get; }`
    - `void SetCredential(string accessToken, string? refreshToken = null)`、`void ClearCredential()`
    - `Task<Token> RefreshAsync(CancellationToken ct = default)`
  - `public sealed class CatalystOptions { required string ClientId; required string ClientSecret; string? AccessToken; string? RefreshToken; string BaseUrl = "https://api.natsuneko.com"; IList<IApiMiddleware> Middleware; HttpClient? HttpClient; Func<Token, ValueTask>? OnTokenRefreshed }`
  - `public sealed record Token(string AccessToken, string RefreshToken, string TokenType, string? Scope, string? ExpiresAt, int? ExpiresIn)`

- [ ] **Step 1: csproj を書き換える**
  - `TargetFramework` を `net10.0`、`Version` を `0.0.0-dev` にする。
  - `PackageId` / `Title` を `CatalystSharp` にする。RepositoryUrl と PackageProjectUrl を `https://github.com/mika-f/CatalystSDK` にする。
  - `System.Text.Json` の PackageReference は削除する（BCL に含まれる）。
  - `IncludeSymbols` を true、`SymbolPackageFormat` を `snupkg` にする。
  - 生成物の `Generated/**/*.cs` は SDK の既定 glob に含まれるので、追加の設定は不要。
- [ ] **Step 2: テストプロジェクトを作り、失敗するテストを書く**
  - `CatalystSharp.Tests.csproj` は xUnit、net10.0、`CatalystSharp` を参照する。slnx に追加する。
  - 共通仕様の 8 テストを PascalCase 名（`SendsBearerToken` など）で書く。`MockHandler : HttpMessageHandler` を `CatalystOptions.HttpClient` 経由で渡す。生成物が `AllowAutoRedirect=false` を要求するので、`new HttpClient(handler)` をそのまま使う。
- [ ] **Step 3: テストが失敗することを確認する**
  - Run: `cd packages/dotnet && dotnet test`
  - Expected: コンパイルエラーで FAIL
- [ ] **Step 4: Interfaces のとおり実装する**
  - single-flight は `SemaphoreSlim` と、進行中の `Task<Token>?` で行う。
- [ ] **Step 5: テストとパックが通ることを確認する**
  - Run: `cd packages/dotnet && dotnet test && dotnet pack CatalystSharp/CatalystSharp.csproj -c Release -o ./bin -p:Version=2026.10.25-beta.1`
  - Expected: テストが PASS し、`bin/CatalystSharp.2026.10.25-beta.1.nupkg` と `.snupkg` ができる。
- [ ] **Step 6: README を書き換える**
- [ ] **Step 7: Commit**
  - メッセージ: `feat(dotnet): rebuild CatalystSharp on archon-generated client`

### Task 6: Kotlin パッケージ

**Files:**
- Modify: `packages/kotlin/build.gradle.kts`、`packages/kotlin/gradle.properties`、`packages/kotlin/README.md`
- Create: `packages/kotlin/settings.gradle.kts`（上書き。`pluginManagement` と `dependencyResolutionManagement` は archon が生成する形に合わせ、`rootProject.name = "catalyst-kotlin"`）
- Create: `packages/kotlin/src/main/kotlin/com/natsuneko/catalyst/{Catalyst.kt,CatalystOptions.kt,Token.kt}`
- Modify: `packages/kotlin/src/main/kotlin/com/natsuneko/catalyst/auth/{OAuthClient.kt,Pkce.kt}`
- Create: `packages/kotlin/src/test/kotlin/com/natsuneko/catalyst/{CatalystTest.kt,OAuthTest.kt}`

**Interfaces:**
- Consumes: Task 1 の Kotlin 生成物（package `com.natsuneko.catalyst.api`、`…api.core`）
- Produces:
  - `public class Catalyst(options: CatalystOptions) : AutoCloseable`
    - `val api: ApiClient`、`val oauth: OAuthClient`
    - `val accessToken: String?`、`val refreshToken: String?`
    - `fun setCredential(accessToken: String, refreshToken: String? = null)`、`fun clearCredential()`
    - `suspend fun refresh(): Token`
  - `public class CatalystOptions { lateinit var clientId: String; lateinit var clientSecret: String; var accessToken: String?; var refreshToken: String?; var baseUrl: String = "https://api.natsuneko.com"; val middleware: MutableList<Middleware>; var httpClient: HttpClient?; var onTokenRefreshed: (suspend (Token) -> Unit)? }`
  - `public data class Token(val accessToken: String, val refreshToken: String, val tokenType: String, val scope: String?, val expiresAt: String?, val expiresIn: Int?)`

- [ ] **Step 1: `build.gradle.kts` を書き換える**
  - plugins: `kotlin("jvm") version "2.4.21"`、`kotlin("plugin.serialization") version "2.4.21"`、`` `java-library` ``、`` `maven-publish` ``
  - `group = "com.natsuneko.catalyst"`、`version = (findProperty("version") as String?) ?: "0.0.0-dev"`
  - dependencies: `api("io.ktor:ktor-client-core:3.6.0")`、`api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")`。testImplementation に `kotlin("test")`、`io.ktor:ktor-client-mock:3.6.0`、`org.jetbrains.kotlinx:kotlinx-coroutines-test`
  - `sourceSets.main { kotlin.srcDir("src/generated/kotlin") }`
  - JVM 11 の設定は archon の生成物に合わせる。`explicitApi()` も有効にする。
  - `java { withSourcesJar() }`
  - `publishing.publications.create<MavenPublication>("maven") { from(components["java"]); artifactId = "catalyst-kotlin" }`
- [ ] **Step 2: 失敗するテストを書く**
  - 共通仕様の 8 テストを camelCase 名で書く。`runTest` を使い、`MockEngine` を `CatalystOptions.httpClient` に渡す。
- [ ] **Step 3: テストが失敗することを確認する**
  - Run: `cd packages/kotlin && ./gradlew test`
  - Expected: コンパイルエラーで FAIL
- [ ] **Step 4: Interfaces のとおり実装する**
  - single-flight は `Mutex` と、進行中の `Deferred<Token>?` で行う。
- [ ] **Step 5: テストと成果物の生成が通ることを確認する**
  - Run: `cd packages/kotlin && ./gradlew build generatePomFileForMavenPublication -Pversion=2026.10.25-beta.1`
  - Expected: BUILD SUCCESSFUL。`build/libs/catalyst-kotlin-2026.10.25-beta.1.jar`、`build/libs/catalyst-kotlin-2026.10.25-beta.1-sources.jar`、`build/publications/maven/pom-default.xml` ができる。
- [ ] **Step 6: README を書き換える**
- [ ] **Step 7: Commit**
  - メッセージ: `feat(kotlin): rebuild CatalystKotlin on archon-generated client`

### Task 7: composite actions と CI

**Files:**
- Create: `.github/actions/setup-pnpm/action.yml`、`.github/actions/build-nodejs/action.yml`、`.github/actions/build-swift/action.yml`、`.github/actions/build-dotnet/action.yml`、`.github/actions/build-kotlin/action.yml`、`.github/workflows/ci.yml`

**Interfaces:**
- Produces:
  - composite action `./.github/actions/setup-pnpm`: setup-node（`node-version: "24.18.0"`）→ pnpm/action-setup（`version: "11.28.8"`）→ `pnpm install --frozen-lockfile`
  - composite action `./.github/actions/build-<lang>`（inputs なし、リポジトリのルートを前提）。各 action は以下を実行する。
    - nodejs: setup-pnpm → typecheck / test / build
    - swift: `swift test`（`packages/swift`）
    - dotnet: setup-dotnet `10.0.x` → `dotnet test`
    - kotlin: setup-java（temurin 17）→ `./gradlew build`
- [ ] **Step 1: 新たに使う action の SHA を取得する**
  - 対象: `actions/setup-java`、`gradle/actions`（setup-gradle）、`actions/attest-build-provenance`、`actions/create-github-app-token`、`actions/upload-artifact`、`actions/download-artifact`
  - Global Constraints の手順で SHA を取得し、メモしておく（Task 8・9 でも使う）。
- [ ] **Step 2: 5 つの composite action と `dependabot.yml` を書く**
- [ ] **Step 3: `ci.yml` を書く**
  - トリガー: `pull_request` と `push: branches: [main]`
  - `permissions: {}`。各 job は `contents: read`。
  - jobs:
    - `generate-check`（ubuntu-latest）: setup-pnpm → `pnpm generate` → `git diff --exit-code`
    - `scripts`（ubuntu-latest）: `node --test scripts/`
    - `nodejs` / `dotnet` / `kotlin`（ubuntu-latest）、`swift`（macos-15）: それぞれ checkout の後に対応する build action を使う
- [ ] **Step 4: 静的検証を行う**
  - Run: `actionlint`（なければ `brew install actionlint` 後に実行）
  - Expected: 出力なしで終了コード 0
- [ ] **Step 5: Commit**
  - メッセージ: `ci: add CI with generated-code drift check and per-language builds`

### Task 8: `monitor.yml`

**Files:**
- Create: `.github/workflows/monitor.yml`

**Interfaces:**
- Consumes:
  - Task 2 の CLI: `node scripts/spec.mjs <url> <path>`、`node scripts/next-version.mjs beta --spec <path>`
  - Task 7 の composite actions
- Produces: `release.yml` を `gh workflow run release.yml --ref main -f channel=beta -f version=<v> -f sha=<sha>` で起動する（Task 9 の inputs と一致させる）。

- [ ] **Step 1: `monitor.yml` を書く**
  - トリガー: `schedule: - cron: '0 */6 * * *'`、`workflow_dispatch`
  - `concurrency: { group: monitor, cancel-in-progress: false }`、`permissions: {}`
  - jobs:
    1. `detect`（ubuntu-latest、`contents: read`）
       - checkout → setup-pnpm → `node scripts/spec.mjs https://api.natsuneko.com/openapi.json openapi/openapi.json >> "$GITHUB_OUTPUT"`
       - changed のときだけ `pnpm generate` → `git add -A && git diff --cached --binary > regen.patch` → upload-artifact `regen-patch`
       - outputs: `changed`
    2. `build-nodejs` / `build-dotnet` / `build-kotlin`（ubuntu-latest）と `build-swift`（macos-15）
       - `if: needs.detect.outputs.changed == 'true'`、`contents: read`
       - checkout → download-artifact → `git apply regen.patch` → 対応する build action
    3. `commit`（ubuntu-latest、`needs: [detect, build-*]`、`if: needs.detect.outputs.changed == 'true'`、`contents: write`、`actions: write`）
       - checkout（`fetch-depth: 0`）→ download-artifact → `git apply regen.patch && rm regen.patch && git add -A`
       - `git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit -m "chore: regenerate SDKs from openapi <info.version>"`（`info.version` は `node -p "require('./openapi/openapi.json').info.version"` で取得）
       - `git push origin HEAD:main`
       - `git fetch --tags` → `version=$(node scripts/next-version.mjs beta --spec openapi/openapi.json)`
       - `gh workflow run release.yml --ref main -f channel=beta -f version="$version" -f sha="$(git rev-parse HEAD)"`（`GH_TOKEN: ${{ github.token }}`）
  - `git apply` は新規ファイルにも対応できるよう、patch 作成前に `git add -A` しておく（Step 1 の detect で実施済み）。
- [ ] **Step 2: 静的検証を行う**
  - Run: `actionlint`
  - Expected: 終了コード 0
- [ ] **Step 3: patch の往復をローカルで確認する**
  - Run: `node -e 'const f="openapi/openapi.json";const j=require("./"+f);j.info.description="probe";require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")' && pnpm generate && git add -A && git diff --cached --binary > "$TMPDIR/regen.patch" && git reset -q --hard && git apply "$TMPDIR/regen.patch" && git status --short | head && git reset -q --hard`
  - Expected: `git apply` が成功し、`openapi/openapi.json` と生成物の差分が表示される。最後に元の状態へ戻る。
- [ ] **Step 4: Commit**
  - メッセージ: `ci: add 6-hourly OpenAPI monitor that regenerates SDKs`

### Task 9: `release.yml`

**Files:**
- Create: `.github/workflows/release.yml`
- Delete: `.github/workflows/publish-nodejs.yml`、`.github/workflows/publish-dotnet.yml`

**Interfaces:**
- Consumes:
  - Task 2 の CLI: `stable --version`、`latest-beta --version`
  - Task 3〜6 の成果物コマンド
  - Task 7 の composite actions
- Produces: タグ `<lang>/v<version>`、ミラー側のタグ `<version>`

- [ ] **Step 1: `release.yml` を書く**
  - トリガー: `workflow_dispatch`
    - inputs: `channel`（choice: `beta` / `stable`、required）、`version`（string、required）、`sha`（string、optional）
  - `permissions: {}`、`concurrency: { group: release-${{ inputs.version }}, cancel-in-progress: false }`
  - job `resolve`（ubuntu-latest、`contents: read`）
    - checkout（`fetch-depth: 0`）
    - version の形式を検証する。beta は `^[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$`、stable は `^[0-9]+\.[0-9]+\.[0-9]+$`。
    - stable のときは `node scripts/next-version.mjs stable --version …` を実行する。sha が空なら `git rev-list -n1 "$(node scripts/next-version.mjs latest-beta --version …)"` で求める。
    - outputs: `sha`、`version`、`prerelease`（beta なら `true`）、`npm-tag`（`beta` / `latest`）
  - 言語ごとの job。共通事項:
    - `needs: resolve`、`environment` を付ける
    - permissions は `contents: write`、`id-token: write`、`attestations: write`
    - `checkout ref: ${{ needs.resolve.outputs.sha }}`
    - 先頭で `gh release view <tag> --json isDraft -q .isDraft` が `false` なら、以降のステップをすべてスキップする（公開済み）
    - 下書きは `gh release create <tag> --draft --target <sha> --title <tag> --notes "Generated from openapi <version> (<sha>)" [--prerelease]`。既存の下書きがあれば `gh release upload <tag> <files> --clobber` で上書きする
    - 最後に `gh release edit <tag> --draft=false`
  - job ごとの手順:
    - `nodejs`（env `npm`）
      1. build-nodejs
      2. `npm version <v> --no-git-tag-version`（`packages/nodejs`）
      3. `npm pack` → attest-build-provenance（`subject-path` は tgz）→ 下書き作成
      4. `npm view @natsuneko-laboratory/catalyst-sdk@<v> version` が空なら `npm publish <tgz> --tag <npm-tag> --access public`（直前に `npm --version` が 11.5.1 以上か確認し、満たなければ `npm i -g npm@11` を実行）
      5. 下書きを公開
    - `dotnet`（env `nuget`）
      1. setup-dotnet → `dotnet pack -c Release -o bin -p:Version=<v>` → attest → 下書き作成
      2. `curl -fsS -o /dev/null https://api.nuget.org/v3-flatcontainer/catalystsharp/<v-lowercase>/catalystsharp.nuspec` が失敗したら、NuGet/login（`user: Mikazuki`）→ `dotnet nuget push bin/*.nupkg --api-key … --source https://api.nuget.org/v3/index.json`（snupkg は自動で push される）
      3. 下書きを公開
    - `kotlin`（env `kotlin`）
      1. setup-java → `./gradlew build generatePomFileForMavenPublication -Pversion=<v>`
      2. jar / sources jar / `pom-default.xml` を `catalyst-kotlin-<v>.pom` にリネームしたもの → attest → 下書き作成 → 公開
    - `swift`（env `swift-mirror`、ubuntu-latest。build は CI と `monitor.yml` で済んでいるので、ここではソースのパッケージングだけを行う）
      1. `git archive --format=zip --prefix=CatalystSwift/ -o CatalystSwift-<v>.zip HEAD:packages/swift` → attest → 下書き作成
      2. create-github-app-token（`app-id: ${{ vars.SWIFT_MIRROR_APP_ID }}`、`private-key: ${{ secrets.SWIFT_MIRROR_APP_PRIVATE_KEY }}`、`owner: mika-f`、`repositories: CatalystSwift`）
      3. `git ls-remote --tags https://x-access-token:<token>@github.com/mika-f/CatalystSwift.git refs/tags/<v>` が空なら次を行う。
         - ミラーを clone する
         - `rsync -a --delete --exclude .git packages/swift/ mirror/` で中身を置き換える
         - commit `Release <v> (mika-f/CatalystSDK@<sha>)` → push main
         - `gh release create <v> --repo mika-f/CatalystSwift --draft --target <mirror-sha> --notes …`（beta は `--prerelease`）→ `gh release edit <v> --repo mika-f/CatalystSwift --draft=false`（`GH_TOKEN` は App token）
      4. 本体側の下書きを公開
- [ ] **Step 2: 旧 publish workflow 2 本を `git rm` する**
- [ ] **Step 3: 静的検証を行う**
  - Run: `actionlint`
  - Expected: 終了コード 0
- [ ] **Step 4: resolve のロジックをローカルで確認する**
  - Run: `git tag nodejs/v2026.10.25-beta.1 HEAD && node scripts/next-version.mjs latest-beta --version 2026.10.25 && node scripts/next-version.mjs stable --version 2026.10.25; git tag -d nodejs/v2026.10.25-beta.1`
  - Expected: `nodejs/v2026.10.25-beta.1` と `2026.10.25` が出力される。
- [ ] **Step 5: Commit**
  - メッセージ: `ci: add OIDC release workflow with immutable releases; drop legacy publish workflows`

### Task 10: ドキュメント

**Files:**
- Modify: `README.md`、`docs/superpowers/specs/2026-10-26-archon-sdk-restructure-design.md`（§6 の Swift CI を `macos-15` に変更し、理由として CryptoKit を書く）

- [ ] **Step 1: ルートの README を書き換える**
  - 構成表（パッケージ、配布先、タグ形式）
  - 採番ルール
  - 正式版の昇格手順（`gh workflow run release.yml -f channel=stable -f version=2026.10.25`）
  - 検証方法（`gh release verify <tag>`、`gh attestation verify <file> --repo mika-f/CatalystSDK`、`npm audit signatures`）
  - spec §5 の「GitHub 側の手動設定」7 項目
  - 破壊的変更の告知
  - 既存の `## License1` の typo は `## License` に直す
- [ ] **Step 2: spec を修正する**
- [ ] **Step 3: 全体を確認する**
  - Run: `pnpm generate && git diff --exit-code && node --test scripts/ && pnpm -r test && (cd packages/swift && swift test) && (cd packages/dotnet && dotnet test) && (cd packages/kotlin && ./gradlew build) && actionlint`
  - Expected: すべて終了コード 0
- [ ] **Step 4: Commit**
  - メッセージ: `docs: document archon-based SDK pipeline and manual GitHub setup`
