# 実装計画: 会社の人と、社員エージェントが働く範囲

spec は [principals.md](principals.md) です。小さい縦の切れ目で進め、切れ目ごとにテストを通して commit します。各 Task で `bun run typecheck`、`bun run lint`、`bun test` を通し、package の振る舞いを変える Task は `docs/design/` のノートを同じ commit で更新します。

置き場です。`principals/` の読み込みと `role` の判定は `packages/core/src/authority/`。範囲の絞り込みは `packages/core`(入口の判定と述語)と `packages/tools`(一覧と検索)。`principal check` は `packages/cli`。新しい package は作りません。

#### Task B1: 人を読む

`principals/<id>.yaml` の schema と読み込み(判定のたびに読み直す、競合のファイル名は無視、id の重複とファイル名の不一致と壊れたファイルは起動を止める)。`match` に `role`。`status` を委任と承認に効かせる。委任と承認者に書いた id の実在検査。

- 受け入れ: 完了の条件 8、10 の id の部分、12。`principals/` が無いとき今までと同じであること
- 検証: `bun test packages/core packages/mcp`
- サイズ: L

#### Task B2: 名乗り

`--principal <id>` と `OPENSHAIN_PRINCIPAL`。`openshain.yaml` は書き換えない。`reads` を書いた人が 2 人以上いて指定が無ければ起動しない。起動時の 1 行。`.mcp.json` の `env` を `openshain init` の案内に書く。`--help`。

- 受け入れ: 完了の条件 11。指定した人として Work が記録されること
- 検証: `bun test packages/cli packages/mcp`
- サイズ: M

#### Task B3: 働く範囲

`reads` の絞り込み。path を持つ呼び出しは Runtime の入口で、ファイルに触る前に判定する。一覧と検索は `ToolContext` の述語で絞り、範囲に届かないフォルダには入らない。件数は返した分だけ。範囲の外は実在によらず同じ返事にし、記録には本当の理由を残す。承認済みの呼び出しにも効く。

- 受け入れ: 完了の条件 2、3、4、5
- 検証: `bun test packages/core packages/tools packages/mcp`
- サイズ: L

#### Task B4: 知識の担当

`scope: { roles: [...] }` の解決。`knowledge build` の role と id の実在検査。role の文字種を authority と knowledge で揃える。

- 受け入れ: 完了の条件 9、10
- 検証: `bun test packages/core packages/tools packages/cli`
- サイズ: M

#### Task B5: 検査と文書

`openshain principal check <id>`。`spec/authority.md` の `principals/` の形の書き換え、`docs/configuration.md`、README(両言語)、SECURITY.md、CHANGELOG、架空の会社に `reads` の例。実際のモデルでの確認(範囲の外を読めという指示が混ざった CSV を読ませても読まないこと)。3 観点のレビュー。

- 受け入れ: 完了の条件 1、13。文書に未実装の記述が残らないこと
- 検証: `OPENSHAIN_LIVE_TESTS=1 bun test packages/agent`、`bun test`
- サイズ: M

#### Task B6: 記録の読み取り

`work/` は予約パスで、社員エージェントにとって `work_list` と `work_get` が記録への唯一の経路です。`reads` を書いた人は、自分が principal の Work だけを読みます。`approval_list` は絞りません。`openshain work show` と `work list` は設定を読んでいないので、その配線から始めます。

- 受け入れ: 完了の条件 6、7。`reads` を書いていない人は今までどおり全部読めること
- 検証: `bun test packages/mcp packages/cli`
- サイズ: M
