# 観測と義務(Observation と Obligation)

Status: v0.1(実装済み。完了の条件 1 から 5 を満たします)

社員エージェントが、言われる前に仕事を始めるための最初の一段です。会社の内外で起きた事実を記録し、会社があらかじめ書いておいた決まりに当たれば、Work を作ります。

## 覚えてもらうこと

> 起きたことを書き留める。書き留めたものが決まりに当たれば、仕事が始まる。

出てくるのは「何が起きたか」と「起きたら何をするか」の 2 つだけです。

## 観測(`observations/<id>.json`)

openshain が認識した事実です。仕事ではありません。

```json
{
  "id": "obs_0199...",
  "type": "invoice.received",
  "source": "mailbox",
  "observedAt": "2026-09-15T10:03:00+09:00",
  "recordedAt": "2026-09-15T10:03:02.114Z",
  "scope": { "profession": "generic" },
  "payloadRef": "inbox/2026-09-15-sample-shoji.eml"
}
```

- `type` は会社が決める語です。義務の側と同じ語で書きます
- `source` はどこから知ったかです(`mailbox`、`folder`、人の名前)
- `observedAt` はそれが起きた時刻、`recordedAt` は openshain が知った時刻です。**2 つを分けます**。あとから届いた事実を、届いた順ではなく起きた順に読めるようにするためです
- `payloadRef` は中身の置き場です。中身そのものは観測に入れません。メールの全文を事実の記録に埋め込むと、記録が中身の複製になります
- **観測は書き換えません。** 事実は後から変わりません。間違いに気づいたら、新しい観測を書きます

`observations/` は予約パスです。Tool からは読み書きできません。社員エージェントが「起きたこと」を自分で書けると、事実と作り話の区別がなくなります。

## 義務(`obligations/<name>.yaml`)

条件が成立したら会社として遂行すべき Work です。人が書きます。

```yaml
version: 1
obligations:
  - id: accounting.invoice-received
    trigger:
      event: invoice.received      # この type の観測が来たら
    profession: generic
    create_work:
      type: accounts_payable       # この type の Work を作る
      objective: 届いた請求書を処理する
```

- この版で扱う引き金は `event` だけです。時刻の引き金(月末の 3 日前)と条件の引き金(30 日以上未払い)は、時計と常駐の仕組みが入る版で足します
- `profession` は、その義務が働く職種です。会社フォルダの職種と違う義務は当たりません
- 当たる義務が複数あれば、そのすべてが Work を作ります。観測 1 件から Work が 2 件できることもあります
- `obligations/` を置かない会社フォルダは、観測を記録するだけで何も始めません

## 対応の残り方

Work の側に残します。`work.created` に、どの観測から、どの義務で作られたかを書きます。

観測の側に Work の id を書き足す形にはしません。観測を書き換えないためです。「この観測から何が始まったか」は、Work を引いて答えます。

## 完了の条件

1. 観測 1 件を記録すると `observations/<id>.json` ができ、中身が上の形であること
2. 当たる義務があれば Work が 1 件できて、`work.created` に観測の id と義務の id が残ること
3. 当たる義務が無ければ Work はできず、観測だけが残ること
4. `observations/` と `obligations/` が Tool から読み書きできないこと
5. 職種の違う義務が当たらないこと
