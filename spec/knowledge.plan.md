# 実装計画: Knowledge(会社の決まりと根拠の資料)

spec は [knowledge.md](knowledge.md) です。小さい縦の切れ目で進め、切れ目ごとにテストを通して commit します。各 Task で `bun run typecheck`、`bun run lint`、`bun test` を通し、package の振る舞いを変える Task は `docs/design/` のノートを同じ commit で更新します。

置き場です。Rule と Source と索引の schema、build の検証、索引の作成と検索は `packages/core/src/knowledge/`。引くための 2 つの Tool は `packages/tools`。`knowledge build`、`check`、`add` は `packages/cli`。新しい package は作りません。

#### Task 1: 書式と検証

`knowledge/rules/*.yaml` と `knowledge/sources/*.md`(front matter)の zod schema、読み込み、8 段階の検証のうち書き込みを伴わない 1 から 6。誤りは 1 件目で止めず、すべて集めてから返します。`bun run schemas` が `spec/schemas/knowledge-*.v1.json` を生成します。`knowledge/` を予約パスに追加します。

- 受け入れ: 完了の条件 1、2 の build 側(scope の包含)、3 の予約パスの部分。誤りが複数あるとき 1 回の実行ですべて出ること
- 検証: `bun test packages/core`、`bun run schemas`
- サイズ: M

#### Task 2: 索引と検索

2 つ組と 3 つ組の転置索引、NFKC の正規化、長さの補正、同点の順序、`aliases`。`index.json` と `manifest.json` の書き出し(一時ファイルと rename、index が先、manifest が後)、入力のハッシュと索引のハッシュと形式の版。同じ入力から同じ byte になること。

- 受け入れ: 完了の条件 4、6、3 のハッシュの部分
- 検証: `bun test packages/core`
- サイズ: M

#### Task 3: `openshain knowledge build` と `check`

CLI のコマンド 2 つ。誤りの表示(ファイル名と行と理由)、終了コード 1、`--stale`。`docs/design/cli.md` に追記。

- 受け入れ: 一時 workspace で build が通り、`knowledge/build/` ができること。壊した入力で終了コード 1 になり、`build/` が変わらないこと
- 検証: `bun test packages/cli`
- サイズ: S

#### Task 4: 引くための Tool と Need-to-Know

`knowledge_search` と `knowledge_read`。`build/manifest.json` があるときだけ登録します。認可(両方の Tool で同じ検査)、絞り込みを先に順位付けを後に、業務日と `as_of`、範囲の情報、抜粋の上限、資料であって指示ではない旨の付記。索引の整合の照合(Work ごとに 1 回)。`docs/design/tools.md` の Tool の一覧と理由を更新します。

- 受け入れ: 完了の条件 2、3、5
- 検証: `bun test packages/tools packages/mcp`
- サイズ: L

#### Task 5: `openshain knowledge add`

対話で 1 件足します。何についての決まりか、有効日、根拠、言い換え(`aliases`)を順に聞きます。端末が無ければ質問せず使い方を表示します。一時領域で検証と build を通してから置き換え、落ちたら書いた内容を取り消します。

- 受け入れ: 完了の条件 7。検証に落ちたとき `knowledge/` が実行前と同じで、それまでの決まりが引き続き読めること
- 検証: `bun test packages/cli`
- サイズ: M

#### Task 6: 使われることの確認と文書

架空の会社の例に決まりと資料のひな型。実モデルでの eval(決まりを名指ししない依頼で自分で引く、無いときは無いと言う、候補が 2 件のとき黙って 1 件を選ばない)。docs/configuration.md に `knowledge/` の書き方、README の「知識の投入導線」を実装済みの記述に更新、CHANGELOG。3 観点のレビュー。

- 受け入れ: 完了の条件 8 から 11。文書に未実装の記述が残らないこと
- 検証: `OPENSHAIN_LIVE_TESTS=1 bun test packages/agent`、`bun test`
- サイズ: M
