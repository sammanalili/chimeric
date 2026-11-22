# Chimeric

[English README](README.md)

Chimeric は、元のローカル研究ランタイムと研究ハーネスを保持しながら、プロバイダーに依存しないモデル層、ネイティブランチャー、ローカル認証情報管理、モデル検出、推論設定、画像入力、静的な DNA マーク、アニメーションする原子の製品表現を提供する研究ワークスペースです。正規の公開ソース場所は [sammanalili/chimeric](https://github.com/sammanalili/chimeric) です。

公開ソースには Chimeric の統合コード、ビルドツール、テスト、ドキュメントを含めます。元のランタイムは固有の来歴を持つバージョン付き統合依存として扱い、復元済みランタイムバイナリ、パッケージ化ランタイムのプレビュー、非公開プロファイル、API キー、個人の研究データは別途扱います。

## 0.3.0-rc.2 を準備しています

開発中の版では、モデル選択欄の横に使用状況と料金を表示します。公式クライアント経由の Claude サブスクリプション接続、Fable 5.2 対応、画像モデルの共通設定、任意の分類器、汎用的な科学コミュニケーション用スキル4種も追加しました。サービスが報告する残量、Chimeric が記録したトークン数、API 料金の推定額は区別します。料金や残量が分からない場合は、分からないと表示します。

固定した開発ソースでは、96ファイルに対する Bun テスト964件と5,982アサーション、Python テスト61件が通過しました。294ファイルのクリーンなソース出力では、Bun テスト901件と5,254アサーションが通過しました。別途提供するネイティブの検証用ファイルが必要な63件は、想定どおりスキップされました。同じ出力で Python テスト61件を実行し、検証用ファイルが必要な4件をスキップしました。厳格なリリース確認も通過しました。

指定した Mac 候補は `work/release-goal-20261120/macos-rc-resource-wired17/Chimeric.app` です。新しいプロファイルを使う分離テストに合格し、プロバイダーへのリクエストと公式モデルクライアントの呼び出しは0件でした。直前の候補では、プロジェクト1件、フレーム9件、成果物21件、成果物バージョン21件を停止と再起動の後も保持しました。最終 arm64 バンドルはローカルの ad-hoc 署名で厳格な署名確認を通過しましたが、公証はしていません。

最終ソース、Mac アプリ、Mac ZIP、Linux ディレクトリ、Linux tarball のスキャンでは、未解決の Gitleaks 検出と ClamAV の検出は0件でした。公開ソースでは、Google のインストール型 OAuth クライアント ID とクライアントシークレットの形式も拒否します。これは検査したバイト列についての結果であり、脆弱性やマルウェアが存在しないことの証明ではありません。完全なバックアップと復元、研究ツールから成果物までの往復確認、パッケージ内の認証情報分離、公証、管理対象コンバーター、Linux の完全な研究ハーネス、WSL、音声依存関係の可搬性、ランタイムの再配布権は未完了です。Class 2 は現在実装と検証を続けており、保護対象データへの使用はまだ承認していません。失敗時に停止する確認だけでは、この条件を完了としません。[Class 2 の検証](docs/CLASS2-VALIDATION.md)、[最終監査](docs/RELEASE-AUDIT.md)、[リリース証拠](docs/RELEASE-READINESS.md)、[リリース条件](release-status.json)を参照してください。

## 以前の版 0.2.0-rc.1

このプレリリースの主な内容:

- プロバイダー中立のモデル検出と推論設定。Gemini 4 Argon と Gemini 4 Carbon のカタログファミリーを含みます。
- ChatGPT サブスクリプションの検出と画像生成、Gemini の画像生成、OpenAI GPT Image の画像生成。
- Antigravity は公式 `agy` クライアント経路を通常利用に推奨します。直接 HTTP 経路は実験的な機能です。
- 保存済みモデルを正確にルーティングするカタログと推論設定の修正、そして安全ゲートを維持するメモリー分類器のリクエスト調整。

AGY の機能回帰証拠は 15 ファイル、239 テスト、1,460 アサーションです。カタログ修正の証拠は 118 テスト、806 アサーションで、ブラウザー OAuth テスト 1 件はスキップされています。

ソース境界と新規ソースのライセンス確認は、レビュー済み出力で完了しています。新規インストールと復元、実行時サンドボックス分離、管理対象コンバーター、ネイティブ Linux と Docker の実行、Linux arm64 パッケージ、音声の移植性、ブランドとロケールの最終監査、保存されたランタイムと同梱コンポーネントの再配布審査は確認を継続しています。新しい Chimeric ソースには Apache License 2.0 を選択していますが、上流の素材には適用されません。このプレリリースは非公開の技術プレビューです。詳細は [docs/RELEASE-READINESS.md](docs/RELEASE-READINESS.md) を参照してください。

## プラットフォーム別インストール

科学コミュニケーション用の4つのスキルは、単独でも利用できます。
[バージョン別のダウンロードと導入手順](docs/SCIENTIFIC-SKILLS.md#download-version-100)を参照してください。

- [macOS インストール](docs/INSTALL-MAC.md)
- [Linux インストール](docs/INSTALL-LINUX.md)
- [WSL2 インストール](docs/INSTALL-WSL.md)

## ソースからのビルド

互換性のある Chimeric ランタイムバイナリを別途用意し、ソースツリーの外に置きます。

必要なツールは Bun 1.4.3、Python 3、Antigravity HTTP ブリッジ用の Go、Xcode Command Line Tools、ネイティブアプリ入口をビルドする Swift です。依存パッケージのライフサイクルスクリプトを実行せずにインストールします。

```sh
bun install --frozen-lockfile --ignore-scripts
```

```sh
export CHIMERIC_RUNTIME_BINARY=/path/to/chimeric-runtime-binary
python3 tools/recover_runtime.py "$CHIMERIC_RUNTIME_BINARY" build/original
bun tools/build-runtime.ts build/original build/runtime
python3 tools/build-macos-app.py --runtime build/runtime --binary "$CHIMERIC_RUNTIME_BINARY" --out dist/macos-arm64
open dist/macos-arm64/Chimeric.app
```

macOS ではネイティブアプリを主な起動経路にします。組み込み CLI は `open`、`serve`、`url`、`status`、`stop`、`version` と `--profile DIRECTORY`、`--port PORT` を受け付けます。Bun 実行ファイルは `launcher.mjs` 経由で呼び出す必要があるため、[INSTALL-MAC.md](docs/INSTALL-MAC.md) のヘルパーを使用してください。ネイティブウィンドウやシェルを閉じてもバックエンドは動作を続けます。停止するときは **Stop Workspace** またはネイティブの **Quit** を使います。`CHIMERIC_DATA_DIR` と `CHIMERIC_PORT` も利用できます。新規インストールでは OS ごとの中立なユーザーデータディレクトリを使います。

Linux x64 のポータブル出力については `tools/build-portable.py` と出力された `BUNDLE-BUILD.json` を確認してください。Linux の実行、Docker、Linux arm64 の公開ビルドは完了した手順として扱いません。

## 接続と言語設定

**Settings → General → Language** で System、English、日本語を選びます。System はブラウザーの優先言語に従い、未対応の言語では英語になります。変更時にページを再読み込みするため、下書きや接続編集を先に保存してください。

**Settings → Connections** で名前、API ベース URL、API 種類、任意の API キーを入力します。`openai-completions` は `POST /chat/completions` を使用し、旧式の `/completions` は対応しません。`openai-responses` は Responses リクエストを使用します。モデル検出は `/models` を読み取ります。検出できない場合は正確なモデル ID を手動登録します。接続の変更は SSE で反映され、通常は再起動を要しません。

ChatGPT サブスクリプションは通常の API 接続と別の認証欄から接続します。切断もその欄から行います。

Antigravity サブスクリプションはテキストモデルと画像モデルを分けて検出します。このプレリリースの画像経路はプロバイダーの 1K 解像度とアスペクト比を使うテキスト画像生成に対応し、JPEG、PNG、WebP の MIME と拡張子を保持します。画像編集、参照画像、透明背景、品質設定は公開していません。画像リクエストは選択したアカウントに結び付き、API 課金へ自動フォールバックしません。

## セキュリティと未完了の範囲

API キーはプロファイル内の非公開 `local-auth` に暗号化して保存し、設定 API から再表示しません。接続 URL の認証情報、クエリ、フラグメント、Anthropic 宛先は拒否します。詳細は [SECURITY.md](SECURITY.md) と [docs/OPERATIONS.md](docs/OPERATIONS.md) を参照してください。

テレメトリーとネットワーク境界は [docs/PRIVACY.md](docs/PRIVACY.md) に記載しています。

PDF のローカル変換と音声連携は存在します。Office、OCR、ポータブルコンバーターのプロビジョニングは未完了です。

ソーステスト全体には `pdftotext`、`pdfinfo`、`pdftoppm`、`pdfimages`、`pandoc`、`tesseract` が必要です。PATH にない場合は `CHIMERIC_CONVERTER_PATH` にコンバーターのディレクトリを OS の区切り文字で指定します。Unix 系では `:`、Windows では `;` を使います。アクティブな Conda 環境にあるツールは `CONDA_PREFIX` からも検出できます。コンバーターがない場合はインストール状態として表示し、安全でない代替には切り替えません。

使用するプロファイルは `SCIENCE_LOCAL_PROFILE` または `CHIMERIC_DATA_DIR` で指定できます。ソーステストには使い捨てのプロファイルを使い、認証情報、セッション URL、研究データをソースツリーの外に置いてください。

## 開発と来歴

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test
```

`bun run test:e2e` は `CHIMERIC_LIVE_E2E=1` を明示してライブプロファイル用テストを有効にします。通常のソース確認では実行されず、実行した場合だけランタイム証拠を記録してください。

[CONTRIBUTING.md](CONTRIBUTING.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) に開発情報を記載しています。新しい Chimeric ソースのライセンスは [LICENSE](LICENSE) の Apache License 2.0 です。元のランタイムと同梱コンポーネントのライセンス表示は維持され、ランタイムの再配布審査は別途未完了です。

`release.manifest.json` はソース公開範囲を定義します。`python3 tools/release_check.py` はソース、認証情報らしい文字列、ローカル Markdown リンクを確認します。`tools/prepare-release.py --out DESTINATION` はマニフェストからソースのみの出力を作成します。これらはランタイムの正しさや再配布権を証明しません。
