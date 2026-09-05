# openshain

汎用のエージェントを、あなたの会社で働く専門社員にする対話型のエージェントハーネスです。

[![CI](https://github.com/openshain/openshain/actions/workflows/ci.yml/badge.svg)](https://github.com/openshain/openshain/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/openshain)](https://www.npmjs.com/package/openshain)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

English: [README.en.md](README.en.md)

```
$ openshain
openshain · サンプル株式会社 · anthropic/claude-haiku-4-5-20251001
> 7月の領収書を category ごとに集計して、件数と合計を summary.md に書いて

  ⎿ fs_list .
  ⎿ fs_list receipt
  ⎿ csv_read receipt/2026-07.csv
  ⎿ csv_aggregate receipt/2026-07.csv
  ⎿ fs_write summary.md
  ⎿ 完了。
  ⎿ 書き込み summary.md
  ⎿ model 呼び出し 6 回、Tool 呼び出し 5 回、入力 22738 トークン(うちキャッシ
    ュ 4602)、出力 1077 トークン
  ⎿ 次に動く人はいません。

⏺ 完了しました。
  
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

⏺ いちばん大きいcategoryは支払手数料です。
  
  合計金額が1,170,950円で、全categoryの中で最も多いです。
╭────────────────────────────────────────────────────────────────────────────╮
│ > ▌                                                                       │
╰────────────────────────────────────────────────────────────────────────────╯
work_01a0720c… completed · model 3 回、入力 5350、出力 454 トークン · /help で使い方
```


画面で話す相手が社員エージェントです。依頼を Work にして進め、子 Work が Tool でファイルを読み書きし、締めの行に書いたファイルと使用量が出て、社員エージェントが結果を伝えます。会話も Work も `work/` に記録として残ります。

Claude や Codex のようなエージェントは、そのままでは会社の社員として働けません。会社のルールと業務手順、SaaS や Office のファイルを扱う手、権限と承認、セッションをまたいで残る仕事の状態、証跡とコストが足りないからです。openshain はそれをエージェントハーネスとして足します。

## できること

- `openshain` と打つと社員エージェントと話せます。作業が出てきたら社員エージェントが Work にして進め、結果を返します
- 依頼を Work として進め、`work/<id>/events.jsonl` に全部残します。途中で止めても再開できます
- Model は設定で切り替えます。Anthropic と OpenAI 互換 API に対応し、キーは自分のものを使います
- 標準 Tool はファイル、CSV、Markdown です。workspace の外には出ません。結果は頼まれた範囲と集計で返し、ファイルを丸ごと model に渡しません
- Claude Code や Codex から MCP で同じ Runtime を使えます。思考はエージェント、記録は Runtime です
- 自作の Tool は設定に 1 行足すだけです。公式の Tool と同じインターフェースを通ります
- 成果物のハッシュと使用量を Work ごとに記録します

権限、承認、専門家へのエスカレーション、職種 Pack はこれからです。いまの職種は `generic` だけで、最初の職種として経理を作っています。

## インストール

[GitHub Releases](https://github.com/openshain/openshain/releases) のバイナリを PATH の通った場所に `openshain` として置きます。macOS のバイナリは未署名なので、`xattr -d com.apple.quarantine openshain` が一度要ります。

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
openshain                            # 社員エージェントと話す。/help で画面の使い方
openshain run "今月の領収書を集計して"   # 1 件だけ頼むとき
openshain work list
openshain work show <id>
```

画面では、頼んだことを社員エージェントが Work にして進め、Tool の呼び出しが 1 行ずつ流れます。Work が質問すればその場で答えられます。履歴は PageUp と PageDown で遡れます。Ctrl-C は動いている Work を止め、質問を待っている途中なら質問を取り下げます。止めた Work は `/resume <id>` で続きます。会話も Work として記録に残ります。

| コマンド | 動き |
|---|---|
| `openshain` | 社員エージェントと話す画面です。作業は Work にして進めます |
| `openshain init` | 会社フォルダの設定と、エージェント向けの指示ファイルを書きます |
| `openshain run "<依頼>"` | Work を作って完了か停止まで進めます |
| `openshain work list` / `work show <id>` | Work の一覧と詳細です。使用量の合計と、次に動くのが誰かを出します |
| `openshain work resume <id>` | 質問や中断で止まった Work を続けます |
| `openshain tools list` | 使える Tool と許可の有無を出します |
| `openshain mcp` | MCP server を stdio で起動します |

`--workspace <dir>` で会社フォルダを指定できます。省略時はカレントディレクトリから上に向かって `openshain.yaml` を探します。

### Claude Code から

会社フォルダで `claude` を起動し、フォルダを信頼します。`openshain init` が書いた `.mcp.json` で `openshain mcp` がつながり、`/mcp` に openshain が出ます。あとは依頼を書くだけです。Claude Code が考え、ファイルの読み書きと記録は openshain がやります。`AGENTS.md` が、会社のファイルは openshain の Tool で扱うとエージェントに伝えます。

Codex など他のエージェントも、`openshain mcp` を stdio の MCP server として登録すれば同じです。

## 設定

`openshain.yaml` の最小形です。

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

全項目は [docs/configuration.md](docs/configuration.md) にあります。JSON Schema は [spec/schemas/](spec/schemas/) です。

## 設計

- Work, not answers。業務の完了まで進めます
- Existing SaaS remains the system of record。会社の記録の原本は、いま使っている会計ソフトや SaaS、台帳のままです。openshain はそれを読み書きする側で、自分で持つのは作業の記録だけです
- Official has no hidden privilege。openshain 自身が作る Tool や model provider も、第三者が作るものと同じインターフェースを通ります。裏口はありません
- Paid means easiest。OSS だけで主要な用途を完了できます。有償で提供するものがあるなら、それは openshain を会社に代わって動かし続ける運用の肩代わりで、機能の解禁ではありません

全文は [docs/principles.md](docs/principles.md)、各 package をなぜその形にしたかは [docs/design/](docs/design/README.md)、仕様は [spec/](spec/README.md) にあります。

## 開発

```
bun install
bun run typecheck && bun run lint && bun test
```

構成と規約は [AGENTS.md](AGENTS.md)、貢献のしかたは [CONTRIBUTING.md](CONTRIBUTING.md)、脆弱性の報告は [SECURITY.md](SECURITY.md) にあります。

## ライセンス

[Apache-2.0](LICENSE)
