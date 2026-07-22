# Google Analytics 4 — Checks

- Manifest id is `google-analytics-4` and CLI command is `ravi ga4`.
- Manifest check has no errors or recursive command paths.
- Every finite CLI operation exposes `--json`, `@CommandAccess` and `@Returns`.
- Read, write and destructive capabilities are distinct; financial is absent.
- Credential resolution fails before fetch when no connection exists.
- Official paths/methods are asserted with fake fetch and fake token only.
- No source, test, log or manifest contains a real credential or legacy property id.
- No file under the SDE legacy repository is changed.
