# 実装計画: 会社に人が複数いるときの、見える範囲

spec は [principals.md](principals.md) です。小さい縦の切れ目で進め、切れ目ごとにテストを通して commit します。各 Task で `bun run typecheck`、`bun run lint`、`bun test` を通し、package の振る舞いを変える Task は `docs/design/` のノートを同じ commit で更新します。

置き場です。`principals/` の読み込みと `role` の判定は `packages/core/src/authority/`。見える範囲の絞り込みは `packages/core`(述語)と `packages/tools`(使う側)。記録の絞り込みは `packages/mcp` と `packages/cli`。`principal check` は `packages/cli`。新しい package は作りません。

#### Task B1: 人を読む

`principals/<id>.yaml` の schema と読み込み(判定のたびに読み直す、競合のファイル名は無視、id の重複とファイル名の不一致と壊れたファイルは起動を止める)。`match` に `role`。`status` を委任と承認に効かせる。委任と承認者に書いた id の実在検査。

- 受け入れ: 完了の条件 6、8 の id の部分、10。`principals/` が無いとき今までと同じであること
- 検証: `bun test packages/core packages/mcp`
- サイズ: L

#### Task B2: 誰として働くか

`--principal <id>` と `OPENSHAIN_PRINCIPAL`。`openshain.yaml` は書き換えない。`reads` を書いた人が 2 人以上いて指定が無ければ起動しない。起動時の 1 行。`.mcp.json` の `env` を `openshain init` の案内に書く。`--help`。

- 受け入れ: 完了の条件 9。指定した人として Work が記録されること
- 検証: `bun test packages/cli packages/mcp`
- サイズ: M

#### Task B3: 見える範囲

`reads` の絞り込み。`ToolContext` に述語を 1 つ足し、判定を持っている 1 か所で作る。一覧、検索(降りないこと)、読み取り、書き込み。件数の扱い。ファイルを開く前に判定する。範囲の外は実在によらず同じ返事にし、記録には本当の理由を残す。

- 受け入れ: 完了の条件 2、3、4
- 検証: `bun test packages/core packages/tools`
- サイズ: L

#### Task B4: 記録

`records`。`work_list`、`work_get`、`approval_list`、`openshain work show`、`work_select` の文言。承認者に名指しされた Work は見えること。見える Work の中身も、範囲の外は入力と結果ごと伏せること。`openshain work show` は今 config を読んでいないので、その配線から。

- 受け入れ: 完了の条件 5
- 検証: `bun test packages/mcp packages/cli`
- サイズ: L

#### Task B5: 知識の役割

`scope: { roles: [...] }` の解決。`knowledge build` の role と id の実在検査。role の文字種を authority と knowledge で揃える。

- 受け入れ: 完了の条件 7、8
- 検証: `bun test packages/core packages/tools packages/cli`
- サイズ: M

#### Task B6: 検査と文書

`openshain principal check <id>`。`spec/authority.md` の `principals/` の形の書き換え、`docs/configuration.md`、README(両言語)、SECURITY.md、CHANGELOG、架空の会社に 2 人目。実際のモデルでの確認。3 観点のレビュー。

- 受け入れ: 完了の条件 1、11。文書に未実装の記述が残らないこと
- 検証: `OPENSHAIN_LIVE_TESTS=1 bun test packages/agent`、`bun test`
- サイズ: M
