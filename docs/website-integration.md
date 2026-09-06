# 公式サイトとの連携

公式サイト(`https://openshain.jp`)は別の repo にあり、build のときにこの repo を特定の commit で checkout して、製品情報、文書、ブランド資産を読みます。この repo がそれらの原本で、サイト側にコピーは置きません。この文書は、サイトが読んでよい path の一覧と、それを変えるときの規則です。

## サイトが読む path

| path | 意味 |
|---|---|
| `packages/cli/package.json` | `version` が openshain の版です。5 つの package は同じ版を持ちます |
| `assets/openshain_wordmark_color.svg` | 文字だけのロゴです。明るい背景に使います |
| `assets/openshain_wordmark_color_for-dark.svg` | 文字だけのロゴの暗い背景用です |
| `assets/openshain_logomark_color.svg` | 印だけです。アイコンやアバターに使います |
| `assets/openshain_logomark_color_for-dark.svg` | 印だけの暗い背景用です |
| `assets/openshain_horizontal_lockup_color.svg` | 印と文字を横に並べた形です。README の先頭と同じです |
| `assets/openshain_horizontal_lockup_color_for-dark.svg` | 横の形の暗い背景用です |
| `assets/openshain_vertical_lockup_color.svg` | 印の下に文字を置いた形です |
| `assets/favicon.svg` | favicon です |
| `assets/favicon.ico` | favicon の ico 版です |
| `assets/icon-192.png` | サイトとアプリのアイコンです。正方形です |
| `assets/icon-512.png` | 512px のアイコンです |
| `assets/icon-1024.png` | 1024px のアイコンです |
| `assets/apple-touch-icon.png` | iOS のホーム画面用のアイコンです |
| `docs/` | 利用者向けの文書です。`docs/design/` は設計ノートです |
| `spec/` | 仕様です。`spec/schemas/` はコードから生成した JSON Schema です |
| `CHANGELOG.md` | 版ごとの変更です。`## [x.y.z] - 日付` の節に分かれています |
| `README.md` | 概要の日本語版です |
| `README.en.md` | 概要の英語版です |
| `LICENSE` | Apache-2.0 の全文です |

`assets/` の SVG が原本で、PNG は書き出しです。サイトは SVG を使い、PNG は表にあるものだけ使います。`_black` と `_white` の単色版も `assets/` にありますが、サイトが使うのは表の色つきです。

読んでよいのは表にある path だけです。表にない path(`packages/` の中身、`scripts/`、`.github/`、`test/`)はサイトから読みません。

## 変更の規則

- 表にある path の移動、改名、削除は breaking change です。`CHANGELOG.md` の Changed に書き、この表を同じ commit で直します。サイト側は、表の版に合わせて追従します
- ファイルを足すこと(新しい図、新しい文書)は breaking ではありません
- 版は `packages/cli/package.json` の `version` から読みます。tag `vX.Y.Z` の `X.Y.Z` と同じで、Release workflow が一致を確かめてから Release を作ります
- `docs/` と `spec/` は Markdown のままです。表示の形はサイト側が決めます。文書の中の相対リンクは、この repo の中の path です
- サイト側は特定の commit SHA で checkout して build します。SHA は最新の stable release の tag が指す commit です。main の HEAD を使うのは、stable release がまだ 1 件もないときだけです

## stable release の定義

- tag は `vX.Y.Z` の形です(例 `v0.1.0`)。これが stable です
- `vX.Y.Z-<印>`(`v0.2.0-rc.1`、`v0.2.0-beta.2`、`v0.2.0-experimental`)は prerelease です。Release workflow が GitHub Release に prerelease の印を付けます
- サイトの更新の対象外は、draft の Release、prerelease の印がある Release、Release になっていない tag です
- サイトが使う版は「最新の stable Release」で、「最新の tag」ではありません。GitHub API の `repos/openshain/openshain/releases/latest` が、draft と prerelease を除いた最新を返します

## release のときのサイトの更新

Release workflow(`.github/workflows/release.yml`)は、stable の tag で GitHub Release を作った後、サイトの repo へ `repository_dispatch` を送ります。

- event type: `openshain-release`
- payload(`client_payload`): `tag`(`v0.1.0`)、`version`(`0.1.0`)、`sha`(tag が指す commit の 40 桁の SHA)、`release_url`(GitHub Release の URL)
- 送る条件: tag が `vX.Y.Z` の形で、repository variable `WEBSITE_REPOSITORY` と secret `WEBSITE_DISPATCH_TOKEN` の両方があるときです。どちらかが無ければ送らず、その旨をログに出して成功で終わります。dispatch が失敗しても Release は残ります

必要な設定(Settings > Secrets and variables > Actions):

| 名前 | 種類 | 中身 |
|---|---|---|
| `WEBSITE_REPOSITORY` | variable | サイトの repo。`owner/name` の形です |
| `WEBSITE_DISPATCH_TOKEN` | secret | サイトの repo に `repository_dispatch` を送れる token です。fine-grained personal access token で、対象をサイトの repo だけに絞り、Contents の Read and write を付けます。GitHub App の installation token でも構いません |

サイト側の workflow の形:

```yaml
on:
  repository_dispatch:
    types: [openshain-release]   # この repo の Release workflow が送ります
  workflow_dispatch:             # 手で build するときです
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with:
          repository: openshain/openshain
          ref: ${{ github.event.client_payload.sha }}   # 手で動かすときは releases/latest の tag を引きます
          path: openshain
      # build --docs ./openshain
```

dispatch は早く更新するための合図で、何を出すかの基準は GitHub Release です。dispatch が届かなかったとき(設定前、失敗)は、サイト側が `releases/latest` を読んで同じ結果になります。

## URL

- 正規の URL は `https://openshain.jp` です
- ドメインが開通するまで、`packages/*/package.json` の `homepage`、README、SECURITY.md のリンクは GitHub を指したままにします。まだ無い場所へ利用者を送らないためです。開通したときに切り替える場所は、5 つの package.json の `homepage` と、この文書です
- `security.txt`: サイトが `/.well-known/security.txt` を出します。`Contact` は SECURITY.md と同じ窓口にします。いまは GitHub の Report a vulnerability(`https://github.com/openshain/openshain/security/advisories/new`)です。`security@openshain.jp` が開通したら、SECURITY.md に足すのと同じ commit で security.txt にも足します。`Policy` は SECURITY.md の URL です

## 検査

`test/website-contract.test.ts` が、この文書の表にある path がすべて存在すること、`version` が semver で 5 つの package で一致することを見ます。`bun test` と CI で走ります。表に path を足したら、ファイルも同じ commit で足します。

## English summary

- The website repository checks this repository out at one commit SHA (the commit of the latest stable GitHub Release; `main` HEAD only while no stable release exists) and reads only the paths in the table above. Nothing is copied into the website repository.
- Version: `version` in `packages/cli/package.json`, equal to the tag without its `v`.
- Stable release: a tag of the form `vX.Y.Z`. Tags with a suffix (`-rc.1`, `-beta.2`, `-experimental`) become prereleases. Draft and prerelease releases are never picked up; use `releases/latest`.
- On a stable release the Release workflow sends `repository_dispatch` with event type `openshain-release` and `client_payload` `{tag, version, sha, release_url}` to the repository named by the `WEBSITE_REPOSITORY` variable, using the `WEBSITE_DISPATCH_TOKEN` secret. Without both, nothing is sent and the workflow still succeeds.
- Moving, renaming or deleting a path in the table is a breaking change; update the table in the same commit. `test/website-contract.test.ts` checks that every path exists.
- Canonical URL: `https://openshain.jp`. Links stay on GitHub until the domain is live; `security.txt` must keep the same contact as SECURITY.md.
