# Chimeric

[English README](README.md)

Chimeric は、元のローカル研究ランタイムと研究ハーネスを保持しながら、プロバイダーに依存しないモデル層、ネイティブランチャー、ローカル認証情報管理、モデル検出、推論設定、画像入力、静的な DNA マーク、アニメーションする原子の製品表現を提供する研究ワークスペースです。正規の公開ソース場所は [sammanalili/chimeric](https://github.com/sammanalili/chimeric) です。

公開ソースには Chimeric の統合コード、ビルドツール、テスト、ドキュメントを含めます。互換性のあるランタイムは、元の来歴を保持するバージョン付き依存として別途用意します。ランタイムのバイナリ、非公開プロファイル、API キー、個人の研究データは、この公開物には含めません。

## 0.3.0-rc.9 でモデル検出と設定画面を更新しました

設定の「Connections」で長い接続一覧をスクロールできるようにしました。Claude Code のモデルは、ピン留めや既定モデルの選択でも正しい接続先を保持します。「General」には実際の Chimeric のバージョンを表示します。

チャットのモデル選択欄には、対話に対応する利用可能なテキストモデルを表示します。「Connections」の「モデル選択欄に表示」で、各モデルの表示を個別に切り替えられます。画像生成や音声のモデルは、それぞれの専用選択欄に残ります。

Anthropic サブスクリプションのモデル名と推論レベルは、インストール済みの公式クライアントから取得します。接続確認やサインインが成功すると一覧を読み込みます。「Refresh models」では Chimeric を再起動せずに最新のクライアント情報を取得できます。

Claude サブスクリプションでは、画像を画像データとして送り、ファイル添付は既存の変換処理を通して読み取ります。実際の Haiku 5.5 接続で、テスト用 PNG と PDF の読み取りを確認しました。確認対象の Claude モデル情報は、入力文脈100万トークン、出力上限12万8千トークンに対応します。文脈の使用量と課金用の累積使用量を分け、各推論リクエストには個別の出力上限を設定します。[入力形式と制限](docs/PROVIDERS.md#images-and-file-attachments-use-the-existing-research-transcript)を参照してください。

このソースのプレリリースには、0.3.0-rc.2 以降の修正を含めています。

- チャットの段落、太字、リストを通常どおり表示します。成果物の画像参照は保存済みのローカル画像として表示し、コード例や編集中の文章に含まれる参照記法は書き換えません。
- 対応する画像接続では、同じ研究チャット内の PNG、JPEG、WebP 画像を1〜4枚、生成時の参照画像として渡せます。RiVault 経由でも画像編集を確認しました。画像ツールは Files の固定バージョン ID を受け取り、選択した接続先の画像編集エンドポイントへ multipart 形式で送信します。参照画像に対応しない通信経路では、画像を黙って省略せずに処理を停止します。
- macOS ランチャーはローカルの制御ソケットを通じてデーモンの起動を待ちます。サンドボックスの初期化が遅い場合に、補助ランタイムを繰り返し起動したり、ポート競合と誤って表示したりする問題を修正しました。
- ネイティブアプリの更新時は、対応するデーモンを停止してからアプリを置き換え、元のアプリを復元用に残します。Connections の経路を Chimeric の設定画面につなぎ、アプリ側の案内文とヘルプリンクも修正しました。

統合コードには、コンパクトな使用状況・API 料金表示、公式クライアント経由の Claude サブスクリプション接続、Fable 5.2 対応、画像モデルの共通設定、任意の分類器、汎用的な科学コミュニケーション用スキル4種も含まれます。サービスが報告する残量、Chimeric が記録したトークン数、API 料金の推定額は区別します。

公開ダウンロードに含まれるのは、統合ソース、テスト、ビルドツール、ドキュメントです。元のランタイム、ネイティブアプリのバイナリ、非公開プロファイル、API キー、研究ファイルは含めません。新しい Chimeric ソースには Apache-2.0 を適用し、上流のコンポーネントは元のライセンスと来歴を保持します。

現在の検証結果とスキャン範囲は、[リリース監査](docs/RELEASE-AUDIT.md)、[ソース検証](docs/SOURCE-VERIFICATION.json)、[リリース条件](release-status.json)に記録します。Mac 候補は ad-hoc 署名済みですが、公証はしていません。完全なバックアップと復元、研究ツールから成果物までの往復確認、パッケージ内の認証情報分離、管理対象コンバーター、Linux の完全な研究ハーネス、WSL、音声依存関係の可搬性、ランタイムの再配布権は未完了です。Class 2 は、パッケージ全体の動作確認が通過するまで保護対象データには使用できません。[Class 2 の検証](docs/CLASS2-VALIDATION.md)と[リリース準備状況](docs/RELEASE-READINESS.md)に要件をまとめています。

## 以前の版 0.2.0-rc.1

このプレリリースの主な内容:

- プロバイダー中立のモデル検出と推論設定。Gemini 4 Argon と Gemini 4 Carbon のカタログファミリーを含みます。
- ChatGPT サブスクリプションの検出と画像生成、Gemini の画像生成、OpenAI GPT Image の画像生成。
- Antigravity は公式 `agy` クライアント経路を通常利用に推奨します。直接 HTTP 経路は実験的な機能です。
- 保存済みモデルを正確にルーティングするカタログと推論設定の修正、そして安全ゲートを維持するメモリー分類器のリクエスト調整。

AGY の機能回帰証拠は 15 ファイル、239 テスト、1,460 アサーションです。カタログ修正の証拠は 118 テスト、806 アサーションで、ブラウザー OAuth テスト 1 件はスキップされています。

以前のプレリリースの検証結果は、その時点で記録したソースと成果物に対するものです。現在のプラットフォーム対応と配布条件は [docs/RELEASE-READINESS.md](docs/RELEASE-READINESS.md) を参照してください。

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
