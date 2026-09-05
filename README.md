# openshain

汎用のエージェントを、あなたの会社で働く専門社員にする対話型のエージェントハーネス。

[![CI](https://github.com/openshain/openshain/actions/workflows/ci.yml/badge.svg)](https://github.com/openshain/openshain/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/openshain)](https://www.npmjs.com/package/openshain)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

English: [README.en.md](README.en.md)

```
$ openshain
> 7月の領収書を category ごとに集計して、件数と合計を summary.md に書いて
  fs_list .
  fs_list receipt
  csv_read receipt/2026-07.csv
  csv_aggregate receipt/2026-07.csv
  fs_write summary.md
  完了。
    書き込み summary.md
  model 呼び出し 6 回、Tool 呼び出し 5 回、入力 22738 トークン(うちキャッシュ 4602)、出力 1077 トークン
  次に動く人はいません。
完了しました。

7月の領収書をcategoryごとに集計して、summary.mdに書きました。

集計結果は以下の通りです。

総件数：296件
総合計金額：3,258,930円

categoryごとの内訳：
- 会議費：18件、23,370円
- 広告宣伝費：31件、793,220円
- 支払手数料：31件、1,170,950円
- 新聞図書費：24件、104,580円
- 旅費交通費：66件、132,980円
- 水道光熱費：31件、585,690円
- 消耗品費：28件、99,300円
- 福利厚生費：18件、38,570円
- 荷造運賃：20件、137,900円
- 通信費：29件、172,370円

summary.mdファイルに作成されています。
> いちばん大きい category はどれ?
いちばん大きいcategoryは支払手数料です。

合計金額が1,170,950円で、全categoryの中で最も多いです。
```

担当が依頼を Work にして進め、子 Work が Tool でファイルを読み書きし、締めの行に書いたファイルと使用量が出て、担当が結果を伝える。会話も Work も `work/` に記録として残る。

Claude や Codex のようなエージェントは、そのままでは会社の社員として働けない。会社のルールと業務手順、SaaS や Office のファイルを扱う手、権限と承認、セッションをまたいで残る仕事の状態、証跡とコストが足りない。openshain はそれをエージェントハーネスとして足す。

## できること

- `openshain` と打つと担当と話せる。作業が出てきたら担当が Work にして進め、結果を返す
- 依頼を Work として進め、`work/<id>/events.jsonl` に全部残す。途中で止めても再開できる
- Model は設定で切り替える。Anthropic と OpenAI 互換 API。キーは自分のもの
- 標準 Tool はファイル、CSV、Markdown。workspace の外には出ない。結果は頼まれた範囲と集計で返し、ファイルを丸ごと model に渡さない
- Claude Code や Codex から MCP で同じ Runtime を使う。思考はエージェント、記録は Runtime
- 自作の Tool は設定に 1 行足すだけ。公式の Tool と同じインターフェース
- 成果物のハッシュと使用量を Work ごとに記録する

権限、承認、専門家へのエスカレーション、職種 Pack はこれから。いまの職種は `generic` だけで、最初の職種として経理を作っている。

## インストール

[GitHub Releases](https://github.com/openshain/openshain/releases) のバイナリを PATH の通った場所に `openshain` として置く。macOS のバイナリは未署名なので `xattr -d com.apple.quarantine openshain` が一度要る。

Bun があるなら:

```
bun install -g openshain
```

ソースから:

```
git clone https://github.com/openshain/openshain.git
cd openshain
bun install
bun run build   # dist/openshain
```

## 使い方

```
mkdir my-company && cd my-company
openshain init                       # openshain.yaml、.mcp.json、AGENTS.md、CLAUDE.md を書く
export ANTHROPIC_API_KEY=...         # openshain.yaml の api_key_env で名前を変えられる
openshain                            # 担当と話す。/help で画面の使い方
openshain run "今月の領収書を集計して"   # 1 件だけ頼むとき
openshain work list
openshain work show <id>
```

画面では、頼んだことを担当が Work にして進め、Tool の呼び出しが 1 行ずつ流れます。Work が質問すればその場で答えられます。Ctrl-C は動いている Work を止め、質問を待っている途中なら質問を取り下げます。止めた Work は `/resume <id>` で続きます。会話も Work として記録に残ります。

| コマンド | 動き |
|---|---|
| `openshain` | 担当と話す画面。作業は Work にして進める |
| `openshain init` | 会社フォルダの設定と、エージェント向けの指示ファイルを書く |
| `openshain run "<依頼>"` | Work を作って完了か停止まで進める |
| `openshain work list` / `work show <id>` | Work の一覧と詳細。使用量の合計と、次に動くのが誰か |
| `openshain work resume <id>` | 質問や中断で止まった Work を続ける |
| `openshain tools list` | 使える Tool と許可の有無 |
| `openshain mcp` | MCP server を stdio で起動する |

`--workspace <dir>` で会社フォルダを指定できる。省略時はカレントディレクトリから上に向かって `openshain.yaml` を探す。

### Claude Code から

会社フォルダで `claude` を起動し、フォルダを信頼する。`openshain init` が書いた `.mcp.json` で `openshain mcp` がつながり、`/mcp` に openshain が出る。あとは依頼を書くだけ。Claude Code が考え、ファイルの読み書きと記録は openshain がやる。`AGENTS.md` が、会社のファイルは openshain の Tool で扱うとエージェントに伝える。

Codex など他のエージェントも、`openshain mcp` を stdio の MCP server として登録すれば同じ。

## 設定

`openshain.yaml` の最小形:

```yaml
version: 1
company:
  name: サンプル株式会社
principal:
  id: alice
  name: Alice
profession:
  id: generic
  instructions: あなたはこの会社の事務担当です。
model:
  provider: anthropic          # anthropic | openai-compatible
  model: claude-opus-5
  api_key_env: ANTHROPIC_API_KEY
```

全項目は [docs/configuration.md](docs/configuration.md)。JSON Schema は [spec/schemas/](spec/schemas/)。

## 設計

- Work, not answers。業務の完了まで進める
- Existing SaaS remains the system of record。既存の SaaS をそのまま使う
- Official has no hidden privilege。公式実装と第三者実装は同じインターフェースを使う
- Paid means easiest。有償版が引き受けるのは運用で、機能の解禁ではない

全文は [docs/principles.md](docs/principles.md)、各 package をなぜその形にしたかは [docs/design/](docs/design/README.md)、仕様は [spec/](spec/README.md)。

## 開発

```
bun install
bun run typecheck && bun run lint && bun test
```

構成と規約は [AGENTS.md](AGENTS.md)、貢献のしかたは [CONTRIBUTING.md](CONTRIBUTING.md)、脆弱性の報告は [SECURITY.md](SECURITY.md)。

## ライセンス

[Apache-2.0](LICENSE)
