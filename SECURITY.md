# Security

脆弱性は公開の Issue に書かず、GitHub の Security タブにある Report a vulnerability から非公開で知らせてください。受け取ってから 7 日以内に返事をします。対象は最新のリリースです。

openshain は利用者の API キーを環境変数からだけ読み、設定ファイルにも記録にも書きません。Tool は workspace の外のファイルに触れません。この前提が破れる報告を特に歓迎します。

## Reporting (English)

Please do not open a public issue for a vulnerability. Use "Report a vulnerability" under the Security tab of this repository. You will hear back within 7 days. The latest release is the supported version.

openshain reads API keys from environment variables only and never writes them to configuration or records, and its tools cannot reach files outside the workspace. Reports that break either assumption are especially welcome.
