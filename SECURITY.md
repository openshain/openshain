# Security

脆弱性は公開の Issue に書かず、GitHub の Security タブにある Report a vulnerability から非公開で知らせてください。受け取ってから 7 日以内に返事をします。対象は最新のリリースです。

openshain は利用者の API キーを環境変数からだけ読み、設定ファイルにも記録にも書きません。Tool は workspace の外のファイルにアクセスできません。この前提が破れる報告を特に歓迎します。

`openshain.yaml` の `tools[].module` は workspace の中のコードを読み込んで実行します。Claude Code がフォルダの信頼を聞くのと同じ理由で、信用できないフォルダで openshain を動かさないでください。

承認(`authority/` の `approval_required`)について、いまの版の限界です。承認するのは接続が代理する principal で、その人が本当に操作したかを Runtime は確かめられません。対話型 CLI では人が画面で選びますが、MCP で接続した外部のエージェント(Claude Code など)は、自分が止められた呼び出しを自分で承認できます。承認を人の関門として使うなら、外部のエージェントには承認の要る規則を任せず、対話型 CLI で決めてください。端末の認証は後の版で入れます。資格者の判断(`review_decide`)も同じで、名乗りは会社の申告です。承認してから実行するまでの間に、その path が別の場所を指すようになった場合(会社フォルダの中の link やフォルダの入れ替え)は、実行せずに記録に残します。

`principals/<id>.yaml` の `reads`(その人の社員エージェントが働く範囲)も同じ限界を持ちます。止めるのは社員エージェントが openshain の Tool で読み書きする経路だけで、人に対する機密ではありません。会社フォルダを開ける人はどのファイルも読めますし、`--principal` で誰を名乗ることもできます。Claude Code や Codex は自分のファイル操作を持つので、範囲は効きません。範囲を効かせたいフォルダは対話型 CLI で扱ってください。対話型 CLI では、承認と判断の Tool をモデルに渡しません。名乗りを決めるのは端末で、社員エージェント自身は会話の途中でそれを変えられません。標準 Tool にシェルもプロセス起動も環境変数の変更もなく、`openshain.yaml` と `principals/` は予約パスだからです。

`authority/` の規則は、Tool に渡されたパスの文字列を正規化して照合します。workspace の中の symlink がその外の場所を指す場合(path guard は workspace の外を拒否します)や、大文字と小文字を区別しないファイルシステムでは、規則の照合と実際の書き込み先がずれることがあります。規則は実在するディレクトリに対して書き、symlink を混ぜないでください。

会社の決まりと根拠の資料(Knowledge)について、いまの版の限界です。`rules/`、`sources/`、`build/` は Runtime の予約パスで、openshain の Tool からは読めません。知識は索引を通し、依頼する人の権限で絞ってから返します。**この絞り込みが効くのは openshain の Tool を通る経路だけです**。その機械のファイルを読める人は、同じ内容を直接読めます。MCP で接続した外部のエージェント(Claude Code など)は自分のファイル操作を持っていて、Runtime はそれを塞げません。また、依頼する人は設定に書いた principal であって、その人だと確かめる仕組みはありません。機密の境界としてではなく、社員エージェントに渡す情報を絞る仕組みとして使ってください。

資料の本文は、会社の外から持ち込んだ文書を含みます。その中に社員エージェントへの指示が書かれていても、Runtime は取り除きません。資料として扱うよう Tool の結果に添えますが、取り扱いは接続したエージェント側の判断に委ねられます。

`openshain knowledge build` は、書き先が会社フォルダの中の実体であることを確かめてから索引を書きます。フォルダに置かれた link で、索引と、決まりに書かれた文字列を外のファイルへ書かせることはできません。

索引は、人が書いた入力と一致するかを毎回確かめてから使います。確かめているのは「索引が入力の像であること」だけです。**入力そのものを書ける人は、会社の決まりを差し替えられます**。誰が書いたかは確かめません。

社員エージェントが会話の中だけで、資格者の判断に当たる結論を述べることは、コードでは止まりません。止まるのは外へ効果を出す呼び出しです。

## Reporting (English)

Please do not open a public issue for a vulnerability. Use "Report a vulnerability" under the Security tab of this repository. You will hear back within 7 days. The latest release is the supported version.

openshain reads API keys from environment variables only and never writes them to configuration or records, and its tools cannot reach files outside the workspace. Reports that break either assumption are especially welcome.

`tools[].module` in `openshain.yaml` loads and runs code from inside the workspace. Do not run openshain in a folder you would not trust, for the same reason Claude Code asks before trusting one.

Knowledge (`rules/`, `sources/`, `build/`) is filtered by the requesting principal's scope before it reaches the model, and those three directories are reserved from the tools. That filter holds only on paths that go through openshain's tools: anyone who can read the machine's files can read the same content, and an outside agent connected over MCP brings its own file tools, which the runtime cannot block. The requesting principal is what the configuration says, not a verified identity. Treat it as a way to narrow what the employee agent is given, not as a confidentiality boundary. Source documents come from outside the company; if one contains instructions aimed at the agent, the runtime does not remove them. The index is checked against the files a person wrote before it is used, but that check only says the index is an image of those files: whoever can write them decides what the agent treats as company policy, and the runtime does not check who wrote them. Nothing in code stops the agent from stating a conclusion that belongs to a qualified professional when it does so only in conversation; what is stopped is a call that has an effect outside.

Approval (`approval_required` in `authority/`) has a limit in this version. The approver is the principal the connection acts for, and the runtime cannot tell whether that person really acted. On the interactive screen a person chooses; an outside agent connected over MCP (Claude Code, for one) can approve the very call that was held from it. If approval is your gate for a person, do not leave rules that need it to an outside agent: decide them on the interactive screen. Terminal authentication comes in a later version. A qualified reviewer's decision (`review_decide`) works the same way: the name is what the company declares. If the path a call names comes to mean somewhere else between the approval and the run (a link or a folder swapped inside the company folder), the call does not run and the record says so.

`reads` in `principals/<id>.yaml` (the range a person's employee agent works in) has the same limit. It stops the agent's own reads and writes through openshain's tools; it is not confidentiality between people. Anyone who can open the folder can read every file, and can name anyone with `--principal`. Claude Code and Codex bring their own file tools, so the range does not reach them: keep a folder on the interactive screen if the range is to hold there. On the interactive screen, the deciding tools are never offered to the model. The terminal decides the name; the employee agent cannot change it mid-conversation, because the standard tools carry no shell, no process launch and no way to set an environment variable, and `openshain.yaml` and `principals/` are reserved paths.

Rules in `authority/` match the normalized path string a tool was given. Where a symlink inside the workspace points outside it (the path guard refuses anything outside the workspace), or on a case-insensitive filesystem, what a rule matches and what is written can differ. Write rules against real directories and keep symlinks out of them.
