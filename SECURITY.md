# Security

脆弱性は公開の Issue に書かず、GitHub の Security タブにある Report a vulnerability から非公開で知らせてください。受け取ってから 7 日以内に返事をします。対象は最新のリリースです。

openshain は利用者の API キーを環境変数からだけ読み、設定ファイルにも記録にも書きません。Tool は workspace の外のファイルにアクセスできません。この前提が破れる報告を特に歓迎します。

`openshain.yaml` の `tools[].module` は workspace の中のコードを読み込んで実行します。Claude Code がフォルダの信頼を聞くのと同じ理由で、信用できないフォルダで openshain を動かさないでください。

承認(`authority/` の `approval_required`)について、いまの版の限界です。承認するのは接続が代理する principal で、その人が本当に操作したかを Runtime は確かめられません。対話型 CLI では人が画面で選びますが、MCP で接続した外部のエージェント(Claude Code など)は、自分が止められた呼び出しを自分で承認できます。承認を人の関門として使うなら、外部のエージェントには承認の要る規則を任せず、対話型 CLI で決めてください。端末の認証は後の版で入れます。資格者の判断(`review_decide`)も同じで、名乗りは会社の申告です。対話型 CLI では、承認と判断の Tool をモデルに渡しません。

`authority/` の規則は、Tool に渡されたパスの文字列を正規化して照合します。workspace の中の symlink がその外の場所を指す場合(path guard は workspace の外を拒否します)や、大文字と小文字を区別しないファイルシステムでは、規則の照合と実際の書き込み先がずれることがあります。規則は実在するディレクトリに対して書き、symlink を混ぜないでください。

## Reporting (English)

Please do not open a public issue for a vulnerability. Use "Report a vulnerability" under the Security tab of this repository. You will hear back within 7 days. The latest release is the supported version.

openshain reads API keys from environment variables only and never writes them to configuration or records, and its tools cannot reach files outside the workspace. Reports that break either assumption are especially welcome.

`tools[].module` in `openshain.yaml` loads and runs code from inside the workspace. Do not run openshain in a folder you would not trust, for the same reason Claude Code asks before trusting one.
