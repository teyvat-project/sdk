# CatalystSDK: archon による SDK 生成と自動リリースへの再構成

- 日付: 2026-10-26
- ステータス: 設計承認済み（spec レビュー待ち）

## 目的

- 全言語の SDK を [`@natsuneko-laboratory/archon`](https://www.npmjs.com/package/@natsuneko-laboratory/archon) で生成し、手作業での追従をなくす。
- GitHub Actions が 6 時間ごとに `https://api.natsuneko.com/openapi.json` を監視し、変更があれば SDK を再生成してリリースする。
- リリースは長寿命 secret に依存しない OIDC Publishing と GitHub Immutable Releases によって行い、利用者がタグと成果物の改ざんを心配せずに使えるようにする。

## 決定事項

| 項目 | 決定 |
| --- | --- |
| 対象言語 | TypeScript (npm) / Swift / C# (NuGet) / Kotlin の 4 言語 |
| 手書きコード | archon 生成物 + 薄い手書き層。旧来の手書き Client・モデルは削除する（破壊的変更） |
| 採番 | 自動リリースは `-beta.N`。正式版は手動で昇格する |
| Swift 配布 | 生成物を `mika-f/CatalystSwift` にミラーし、そちらで素の semver タグを打つ |
| Kotlin 配布 | GitHub Release の asset のみ（レジストリには publish しない） |
| C# | `net8.0` から `net10.0` に変更する（archon の前提） |
| main への反映 | 再生成コミットは bot が main に直接 push する |
| ワークフロー構成 | `monitor.yml`（監視・生成）と `release.yml`（公開。OIDC の信頼先はこれ 1 本）に分離する |

### 判断の背景

- **workflow を分離する理由**: npm の Trusted Publisher は 1 パッケージにつき workflow ファイルを 1 つしか登録できず、reusable workflow の場合は呼び出し元が検証される。beta（自動）と正式版昇格（手動）を同じ `release.yml` から公開すれば、信頼先を 1 本にできる。`GITHUB_TOKEN` で push したタグは他の workflow を起動しないが、`workflow_dispatch` は起動できる。そのため PAT や GitHub App なしで `monitor.yml` から `release.yml` を呼べる。
- **Swift をミラーする理由**: SwiftPM は、リポジトリ直下の `Package.swift` と、接頭辞のない semver タグ（`2026.10.25`）しか解決できない。`swift/v…` タグだけでは、利用者が `.package(url:from:)` で取得できない。
- **Kotlin を GitHub Release のみにする理由**: Maven Central（Sonatype Central Portal）が OIDC Trusted Publishing に対応していることを確認できず、token と GPG 鍵の保存が必要になるため。対応が確認できたら Maven Central に切り替える。

## 1. リポジトリ構成

```
archon.config.ts            # archon 設定（4 プラグイン）
package.json                # ルート。archon を exact version で devDependency 固定。scripts.generate
pnpm-lock.yaml              # 唯一の lockfile（packages/nodejs/pnpm-lock.yaml は統合して削除）
pnpm-workspace.yaml         # packages/nodejs をワークスペースに含める
openapi/openapi.json        # 監視対象 spec のスナップショット（生成の入力。差分をレビューできる）
scripts/
  next-version.mjs          # 採番ロジック（CLI + export 関数）
  next-version.test.mjs     # node:test による単体テスト
packages/
  nodejs/
    package.json            # 手書き（tsdown, ESM, publishConfig.provenance）
    src/generated/          # archon 出力（毎回 clean）
    src/index.ts            # 手書き: 生成物の再 export + 薄い層
    src/catalyst.ts         # 手書き: クライアント組み立て
    src/oauth/pkce.ts       # 手書き: PKCE 認可コードフロー
  swift/
    Package.swift           # 手書き。生成ターゲットを path: で参照
    Generated/              # archon 出力（package: false）
      Sources/CatalystAPI/
      Sources/CatalystAPICore/
    Sources/CatalystSwift/  # 手書き: @_exported import CatalystAPI + 薄い層
    Tests/CatalystSwiftTests/
  dotnet/
    CatalystSharp/
      CatalystSharp.csproj  # 手書き（net10.0）。Generated/**/*.cs を含める
      Generated/            # archon 出力（package: false）
      Catalyst*.cs          # 手書き: 薄い層
  kotlin/
    build.gradle.kts        # 手書き。sourceSets に src/generated/kotlin を追加
    src/generated/kotlin/   # archon 出力（package: false）
    src/main/kotlin/        # 手書き: 薄い層
.github/workflows/
  monitor.yml
  release.yml
  ci.yml
```

- archon の `output.clean` は、プラグインの出力先ディレクトリを丸ごと削除する。生成物と手書きコードは必ず別ディレクトリに置き、各言語の manifest（`package.json` / `Package.swift` / `.csproj` / `build.gradle.kts`）は手書きで管理する（各プラグインで `package: false`）。
- 既存の `CatalystSDK.sln` と `publish-nodejs.yml` / `publish-dotnet.yml` は削除する。
- 旧来の手書き Client・モデル（`packages/{swift,dotnet,kotlin}` の Clients / Models / Http、`packages/nodejs` の interceptors 等）は削除する。

### archon 設定（概要）

```ts
export default defineConfig({
  input: './openapi/openapi.json',
  output: { path: './packages', clean: true },
  plugins: [
    typescript({ output: 'nodejs/src/generated', package: false }),
    swift({ output: 'swift/Generated', moduleName: 'CatalystAPI', package: false }),
    csharp({ output: 'dotnet/CatalystSharp/Generated', namespace: 'CatalystSharp.Api', package: false }),
    kotlin({ output: 'kotlin/src/generated/kotlin', packageName: 'com.natsuneko.catalyst.api', package: false }),
  ],
});
```

細かいオプション（`clientName` / `naming` / `sdk.style` など）は、実装時に生成結果を見て決める。

### 手書き層の範囲

各言語で次の 2 つだけを持つ。

1. **Catalyst クライアントの組み立て**: `clientId` / `clientSecret` / `accessToken` / `refreshToken` を受け取り、archon runtime の bearer 認証または OAuth2 `refreshToken` 認証と `onRefreshed` コールバックに接続した生成クライアントを返す。User-Agent middleware も設定する。
2. **PKCE 認可コードフロー**: archon が持たない機能。code verifier / challenge の生成、認可 URL の組み立て、認可コードとトークンの交換。

それ以外（API 呼び出し、モデル、エラー型、middleware、retry）は archon の生成物をそのまま公開する。

## 2. 監視と再生成（`monitor.yml`）

- トリガー: `schedule: cron '0 */6 * * *'` と `workflow_dispatch`
- `concurrency: { group: monitor, cancel-in-progress: false }`
- permissions: 最上位は `permissions: {}`。書き込み権限（`contents: write`（push 用）, `actions: write`（`gh workflow run` 用））は `commit` job だけに付け、他の job は `contents: read` のみとする。
- 実装では job を分けている。`detect`（`contents: read`。取得・正規化し、beta の version を算出してから生成し、差分を patch artifact にする。version は job output にする）→ 言語ごとの `build-<lang>`（`contents: read`。patch を検査・適用して build / test。Swift は `macos-15`）→ `commit`（`contents: write`, `actions: write`。patch を検査・適用してコミットと push、beta の dispatch）。プロジェクトのコードを実行する job に書き込み権限を渡さないための分離で、`main` 以外の ref からは実行しない。
- patch の検査: `git apply` の前に毎回 `scripts/check-patch-paths.mjs <patch>` を実行する。patch を HEAD から作った一時 index に `git apply --cached` し、実際に変わるパス（rename / copy の元と先、削除、mode 変更を含む）が `openapi/openapi.json` か `packages/nodejs/src/generated/` / `packages/swift/Generated/` / `packages/dotnet/CatalystSharp/Generated/` / `packages/kotlin/src/generated/kotlin/` 配下だけであることを確かめる。symlink と submodule も拒否する。artifact は workspace の外（`$RUNNER_TEMP`）に展開する。
- `commit` job は patch 由来のコードを実行しない。検査スクリプトは patch 適用前の checkout から実行し、version は `detect` の output を使う。

手順:

1. main を（タグを含めて）checkout し、`https://api.natsuneko.com/openapi.json` を取得する。JSON として妥当でなければ失敗させる。
2. 取得した JSON を `JSON.stringify(JSON.parse(body), null, 2) + '\n'` で正規化し（キー順は維持）、`openapi/openapi.json` とバイト比較する。差分がなければ正常終了する。差分があれば正規化後の内容でスナップショットを上書きする。
3. `node scripts/next-version.mjs beta --spec openapi/openapi.json` で `<base>-beta.<N>` を算出し、`detect` の output にする（ログにも表示する）。算出できなければ（不正な `info.version`、stable 公開済みの base）ここで失敗する。
4. `pnpm install --frozen-lockfile` を実行し、`pnpm generate`（`archon generate`）を実行する。
5. 4 言語を build / test する（`ci.yml` と同じ手順を composite action などで共有する）。1 つでも失敗したら、コミットせずに workflow を失敗させる。
6. `chore: regenerate SDKs from openapi <base>` としてコミットし、main に push する。
7. `gh workflow run release.yml -f channel=beta -f version=<base>-beta.<N> -f sha=<push したコミット SHA>` を実行する（version は手順 3 の output）。

## 3. 採番（`scripts/next-version.mjs`）

- `base`: `info.version` の各ドット区切り要素から先頭の 0 を除き、semver にする（`2026.01.05` → `2026.1.5`、`2026.10.25` → `2026.10.25`）。3 要素の数値でなければエラーにする。
- beta: `git tag -l '*/v<base>-beta.*'` の最大の `N` に 1 を足す（全言語で共通の N）。初回は 1。いずれかの言語ですでに `<lang>/v<base>`（stable）が存在すればエラーにする（"stable <base> already released; the API must bump info.version"）。stable の後に同じ base の beta を出すと、stable より小さい version になるため。
- stable: `<base>`。いずれかの言語ですでに `<lang>/v<base>` が存在すればエラーにする。
- 単体テスト: 正規化、既存タグがない場合・ある場合の N、不正な version、stable の重複検出、stable 公開済みの base での beta の拒否。

## 4. リリース（`release.yml`）

- トリガー: `workflow_dispatch` のみ。inputs は以下のとおり。
  - `channel`: `beta` | `stable`
  - `version`: 例 `2026.10.25-beta.1` / `2026.10.25`
  - `sha`: 任意。stable で省略した場合は、`nodejs/v<version>-beta.*` のうち最大 N のタグのコミットを使う
- 最上位は `permissions: {}`。`main` 以外の ref からは実行しない（`resolve` job の `if: github.ref == 'refs/heads/main'`）。
- `resolve` job（`contents: read`）が `channel` / `version` / `sha` を検証し、後続 job は検証済みの output だけを使う。`sha` は完全な 40 桁の SHA で、`origin/main` の祖先でなければならない。
- nodejs / dotnet / kotlin は、**build と publish を別 job に分ける**（`build-<lang>` と `publish-<lang>`）。swift は 1 job。

| job | Environment | permissions | 役割 / 公開先 |
| --- | --- | --- | --- |
| `build-nodejs` / `build-dotnet` / `build-kotlin` | なし | `contents: read` のみ | プロジェクトのコード（依存パッケージ、テスト、ビルドツール）を実行し、成果物を artifact（保持 7 日）として渡す |
| `publish-nodejs` | `npm` | `contents: write`, `id-token: write`, `attestations: write` | npm（OIDC Trusted Publishing。dist-tag は beta なら `beta`、stable なら `latest`） |
| `publish-dotnet` | `nuget` | 同上 | NuGet（`NuGet/login` による OIDC） |
| `publish-kotlin` | `kotlin` | 同上 | なし（GitHub Release asset のみ） |
| `swift` | `swift-mirror` | 同上 | `mika-f/CatalystSwift`（GitHub App token） |

**build / publish を分ける理由**: OIDC トークン・Environment・書き込み権限を持つ job で、プロジェクトのコード（依存パッケージの postinstall、テスト、ビルドスクリプト）を実行させないため。build job は読み取り専用で OIDC を使えず、侵害されても公開できない。publish job は build を行わず、build job の artifact に対して検証（想定ファイルのみか）・attest・release・publish だけを行う。swift はミラー用のソースを `git archive` するだけでプロジェクトのコードを実行しないため、1 job にしている。

各言語の流れ:

1. （build job）`sha` を checkout し、build / test を実行する。
2. （build job）成果物を作る。
   - nodejs: `npm pack` の tgz
   - dotnet: nupkg / snupkg
   - kotlin: jar / sources jar / pom
   - swift: `packages/swift` のソース zip
3. （publish job）artifact を検証し、`actions/attest-build-provenance` で成果物に provenance を付ける。
4. `gh release create <lang>/v<version> --draft --target <sha>` で下書きを作り、成果物を添付する。下書きがすでにあれば再利用する。
5. レジストリに publish する。すでに同じ version が公開済みで、**対応する下書きリリースがある場合に限り**スキップする（再実行で続きから進められるようにするため）。レジストリ（Swift ミラーを含む）に version があるのに対応する下書きがない場合は、別のコミットから公開されたものかもしれないため、公開せずに失敗する（`Resolve manually`）。ミラーのリリースは `mika-f/CatalystSDK@<sha>` を参照する。
   - **nodejs**: `npm publish --tag <dist-tag>`（npm >= 11.5.1、provenance は自動）
   - **dotnet**: `dotnet nuget push`（`NuGet/login` で取得した短命 API key）
   - **swift**:
     1. `actions/create-github-app-token` で、ミラー先に限定した token を取得する。
     2. ミラーリポジトリを checkout し、`packages/swift` の内容（`Package.swift` / `Generated/` / `Sources/` / `Tests/` / README / LICENSE）で置き換えてコミットする。
     3. ミラー側で `<version>` の下書きリリースを作り、公開して immutable にする。
   - **kotlin**: なし
6. `gh release edit <lang>/v<version> --draft=false`（beta は `--prerelease`）で公開する。公開した時点でタグが作られ、同時に immutable になる。

### 正式版への昇格

`release.yml` を手動で `channel=stable, version=2026.10.25`（sha 省略）として実行する。最新の beta と同じコミットから、全言語の正式版が公開される。いずれかの言語で `<lang>/v<base>` タグがすでにあれば、再度 dispatch できない。部分的に失敗した場合は、同じ run の「Re-run failed jobs」で再開する（build の artifact は 7 日間保持。GitHub が再実行を許す期間は 30 日）。

## 5. セキュリティ

- action はすべてコミット SHA で固定する（コメントにバージョンを書く）。
- 全 workflow で最上位を `permissions: {}` とし、job 単位で最小限の権限を付ける。
- `pnpm install --frozen-lockfile`。依存パッケージの lifecycle script は許可しない（`pnpm-workspace.yaml` の `allowBuilds` / `onlyBuiltDependencies` を空にする）。
- archon は exact version で固定し、更新は Renovate / Dependabot の PR で行う。Dependabot の `github-actions` は `/` と `/.github/actions/*`（composite action）の両方を対象にする。
- 生成の入力はコミット済みのスナップショットとし、spec の変化はコミット差分として追えるようにする。
- `monitor.yml` と `release.yml` は `refs/heads/main` からのみ動作する。`release.yml` は `sha` が `origin/main` の祖先であることを要求する。
- 保存する secret は Swift ミラー用の GitHub App の private key（`swift-mirror` Environment）だけにする。

### GitHub 側の手動設定（README に手順を書く）

1. npm: `@natsuneko-laboratory/catalyst-sdk` の Trusted Publisher に `mika-f/CatalystSDK` / `release.yml` / Environment `npm` を登録する（旧 `publish-nodejs.yml` のエントリから移行する）。
2. NuGet: Trusted Publishing policy に `mika-f/CatalystSDK` / `release.yml` を登録し、**Environment `nuget` に紐付ける（必須）**。
3. `CatalystSDK` と `CatalystSwift` の両方で Immutable Releases を有効にする。
4. Tag ruleset: `*/v*`（CatalystSDK）と `*`（CatalystSwift）の更新・削除を禁止し、作成は GitHub Actions / App のみに限定する。
5. Branch ruleset: main への直接 push を GitHub Actions（CatalystSDK）と GitHub App（CatalystSwift）に限って許可する。ミラーのコミットは署名されないため、CatalystSwift の main では署名付きコミットを必須にしないか、App を bypass actor にする。
6. Environments `npm` / `nuget` / `swift-mirror` / `kotlin` を作成し、deployment を main ブランチに限定する。
7. GitHub App を作成する（`mika-f/CatalystSwift` のみにインストール、`contents: write`）。App ID は変数 `SWIFT_MIRROR_APP_ID`、private key は secret `SWIFT_MIRROR_APP_PRIVATE_KEY` として、どちらも `swift-mirror` Environment に置く。

## 6. CI（`ci.yml`）

- トリガー: `pull_request` と `push`（main）
- jobs:
  - `generate-check`: `pnpm generate` の後に `git diff --exit-code` と `git status --porcelain` の空確認（生成物がコミット済みのものと一致し、未追跡の生成ファイルもないことを確認）
  - `scripts`: `pnpm run test:scripts`（`node --test "scripts/*.test.mjs"`）
  - `nodejs`: typecheck / build / test（Node 24）
  - `swift`: `swift build && swift test`（`macos-15`。手書きの PKCE が CryptoKit を使うため、ubuntu の Swift コンテナでは build できない）
  - `dotnet`: `dotnet build && dotnet test`（.NET 10）
  - `kotlin`: `./gradlew build`（JDK 17）
- 各言語の build / test 手順は `.github/actions/build-<lang>/action.yml` の composite action にまとめ、`monitor.yml` / `release.yml` と共有する。

## 7. エラー処理

| 状況 | 挙動 |
| --- | --- |
| spec の取得失敗・JSON 不正 | `monitor.yml` が失敗する（通知）。スナップショットは変更しない |
| 生成・build・test の失敗 | コミットしない。`monitor.yml` が失敗する |
| main への push 失敗（競合） | 失敗する。次回の実行で再試行する |
| `release.yml` の一部の言語だけ失敗 | 他の言語は継続する。「Re-run failed jobs」で再実行でき、公開済みの言語・レジストリ publish はスキップする |
| レジストリ / ミラーに version があるが下書きがない | 公開せずに失敗する（`Resolve manually`） |
| `monitor.yml` が push した後に dispatch が失敗 | `release.yml` を `channel=beta`、`detect` job が表示した version（output `version`）、push 済みの sha で手動実行する |
| spec が変わったが `info.version` が stable 公開済みの base のまま | `detect` が version の算出で失敗し、何もコミットしない。API 側で `info.version` を上げる |
| regeneration patch が許可外のパスを含む | `build-<lang>` / `commit` が `git apply` の前に失敗し、何もコミットしない |
| beta の下書きだけが残っている | 採番はタグだけを数えるため、次回の `monitor.yml` が同じ番号を使って失敗する。下書きを削除する |
| stable のタグがすでに存在する | `next-version.mjs` / `release.yml` が開始前にエラーにする |

## 8. 移行と README

- ルートの README に、新しい構成、利用方法、採番ルール、上記の手動設定手順を書く。
- 各パッケージの README を archon 生成物ベースの使い方に書き換える。
- 運用上の注意（採番はタグのみを数える、再実行、手動 dispatch）も README に書く。
- 破壊的変更であることを明記する。npm は `1.0.0-alpha.17` から `2026.x` に、NuGet は `0.1.0` から `2026.x` に上がる。

## 対象外

- Rust / Go SDK
- Maven Central への publish
- 生成物の API 互換性チェック（breaking change の自動検出）
