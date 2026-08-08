# Backend changelog

## Since the first `Code.gs` commit

| Change | Why |
|---|---|
| Login brute-force throttle | `/exec` is public; 20 failures per 15 min, counter resets on success, `resetThrottle()` clears it manually |
| `linkUrl()` / `linkStatus()` | The Sheet's Link column stores provenance inline (`url [best-effort match...]`). Split back into a clean href plus a status so "View Original" works |
| `toggleItem` matches aisle + item | The same item can legitimately appear in two aisles; matching on name alone toggled the wrong row |
| Ten-aisle shopping prompt | Replaced the six generic aisles with the ten that follow Tamimi/Danube/Panda layout, so the list reads in shopping order |
| `addItem` default aisle | Was `🥫 Other`, which is not one of the aisles — now `🫙 Canned & Jarred Goods` |

## Deployment note

These are all editor-side changes. Re-paste `Code.gs` and save; no new deployment is
needed because `/exec` serves the saved code of the existing deployment version.
If you ever do redeploy, use **Manage deployments → edit the existing one**, never
"New deployment" — that changes the `/exec` URL and breaks the live app.

## Known limitations

- The throttle counter is global (Apps Script cannot see client IP), so a determined
  attacker can lock the family out for up to 15 minutes. `resetThrottle()` fixes it instantly.
- `CacheService` is best-effort; Google may evict the counter early.
- Rating (`rateMeal`) is implemented but dormant — the columns exist, the UI is off.
