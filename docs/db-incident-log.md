# Session DB incident log

Flat running tally of observed `inbound.db`/`outbound.db` problems, appended
as they're seen. Not exhaustive history — starts from 2026-07-14, when this
log was created. Newest first.

| Date | Session | DB | Type | Detail |
|------|---------|----|------|--------|
| 2026-07-15 | sess-1782093113438-cw3dlh | outbound | false positive (SQLITE_READONLY_ROLLBACK) | `checked()` in `src/delivery.ts` flagged real corruption on a transient readonly-rollback write error; `integrity_check` was `ok`. Fixed same day: readonly-rollback now needs 3 consecutive failures before it's treated as corruption ([[delivery.ts]] `checked()`). |
| 2026-07-14 | sess-1782093113438-cw3dlh | outbound | real corruption | Auto-repair triggered, backup taken (`outbound.db.corrupt-backup-20260714T162907`). Root cause not yet diagnosed. |
