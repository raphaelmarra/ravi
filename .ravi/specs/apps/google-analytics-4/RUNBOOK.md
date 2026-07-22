# Google Analytics 4 — Runbook

## Credential-free validation

```bash
ravi apps check google-analytics-4 --json
ravi apps show google-analytics-4 --json
bun test src/apps/google-analytics-4 src/cli/commands/ga4.test.ts
```

Use a deliberately absent connection to prove failure before network access:

```bash
bun src/cli/index.ts ga4 metadata 0 \
  --connection task-67f4084d-no-credential --json
```

Do not copy a legacy token or point this app at a legacy credential file.

## Later authenticated read-only proof

Only after credential onboarding is separately approved:

1. Configure a temporary broker connection with `analytics.readonly`.
2. Run `metadata 0`, `admin-account-summaries` and one bounded report.
3. Compare redacted shapes with SDE without changing either implementation.
4. Remove/disable the temporary connection through the credential owner flow.

Writes and destructive operations are not part of that read-only proof.
