# openshain

English: [README.en.md](README.en.md)

任意の Agent を、あなたの会社で働く専門社員に変える Open Company Profession Runtime。

Claude や Codex、Gemini のような汎用 Agent は、そのままでは会社の社員として働けません。openshain はそこに次のものを与えます。

- 日本固有の専門知識と、会社固有のルール
- 職務と業務手順
- SaaS や Office を扱う能力
- 権限、承認、専門家へのエスカレーション
- セッションをまたいで残る Work の状態
- 証跡と、Work ごとのコスト

その結果、Agent は経理や法務の社員として働けるようになります。

> まだ経理社員は雇わなくていい。経理は Agent に投げれば進めてくれる。

## はじめる

必要なものは Bun 1.3、git、Anthropic か OpenAI 互換 API のキー。職種はまだ generic だけで、最初の職種は Accounting Employee(経理)の予定です。

### 1. インストール

```
git clone https://github.com/openshain/openshain.git
cd openshain
bun install
bun run build                    # dist/openshain ができる
cp dist/openshain ~/.local/bin/  # PATH の通った場所に置く
openshain --help
```

`~/.local/bin` が無ければ作るか、PATH の通った別の場所に置いてください。build せずに [GitHub Releases](https://github.com/openshain/openshain/releases) のバイナリを取ることもできます(macOS のものは署名していないので、`xattr -d com.apple.quarantine` で隔離属性を外します)。Bun があるなら `bunx openshain --help` でも動きます。

### 2. 会社のフォルダを作る

```
mkdir my-company && cd my-company
openshain init
```

`openshain init` は 4 つのファイルを書きます。`openshain.yaml`(設定)、`.mcp.json`(Claude Code から使うとき)、`AGENTS.md`(外部 Agent への指示)、`CLAUDE.md`(AGENTS.md を読ませる 1 行)。既にあるファイルは触りません。`openshain.yaml` の company と principal を自分の会社に合わせてください。項目の説明は [docs/configuration.md](docs/configuration.md)。

### 3. API キー

`openshain.yaml` の `api_key_env` に書いた名前の環境変数にキーを入れます。設定ファイルにキーは書きません。

```
export ANTHROPIC_API_KEY=...
```

### 4. 依頼する

```
openshain run "receipt/2026-07.csv を category ごとに集計して summary.md に書いて"
```

`receipt/2026-07.csv` は自分のフォルダにある CSV の名前に置き換えてください。Tool の呼び出しが 1 行ずつ出て、最後に結果、使用量、次に動くのが誰かが出ます。記録は `work/<id>/` に残り、`openshain work list` と `openshain work show <id>` で読めます。途中で止まった Work は `openshain work resume <id>` で続けます。

### 5. Claude Code から使う

同じフォルダで `claude` を起動します。フォルダを信頼するかを聞かれたら Yes を選びます。Claude Code は信頼するまで `.mcp.json` を読みません。`/mcp` で openshain が connected になっていれば、依頼をそのまま書きます。Claude Code が考え、ファイルの読み書きと記録は openshain が引き受けます。`AGENTS.md` が、会社のファイルは openshain の Tool で扱うと Agent に伝えています。

Codex など他の Agent も、`openshain mcp` を stdio の MCP server として登録すれば同じように使えます。

## 入口

- `openshain` CLI。参照実装のクライアント。モデルは自分の API キーで使う(BYOK)
- MCP Server。`openshain mcp` で起動し、Claude Code や Codex から同じ Runtime を使う
- SDK。`@openshain/core` をプログラムから使う

## 設計原則

- Work, not answers。業務の完了まで進める
- Existing SaaS remains the system of record。既存の SaaS をそのまま使う
- Official has no hidden privilege。公式実装と第三者実装は同じ contract を使う
- Paid means easiest。有償版が引き受けるのは運用で、機能の解禁ではない

全文は [docs/principles.md](docs/principles.md)。各 package をなぜその形にしたかは [docs/design/](docs/design/README.md)。リポジトリの構成は [AGENTS.md](AGENTS.md)。

## 開発

```
bun install
bun run typecheck
bun run lint
bun test
```

## ライセンス

Apache-2.0
