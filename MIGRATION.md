# Cloud migration — what changed and why

The app used to keep everything in each browser's `localStorage`. Two phones meant two
unrelated copies of the week. It now reads and writes a Google Sheet through an Apps
Script Web App, so the whole family shares one plan.

## Before / after

| | Before | After |
|---|---|---|
| Weekly plan, shopping list, ticks | `localStorage`, per device | Google Sheet |
| Recipe database | 44KB hardcoded in `index.html` | Sheet, read on load |
| Anthropic API key | Pasted into every browser | One Script Property, server-side |
| Auth | None | Family passphrase + HMAC token |
| Multi-user | Impossible | 20s polling, conflict prompt, "updated by" attribution |
| File size | 105,141 bytes | ~56,000 bytes |

CSS is carried across byte-for-byte. The six tabs, layout and styling are unchanged.

## Sheet schema

**📅 Weekly Meal Plan** — one row per meal, not per day, so a rating can attach to a
single meal and history is just a filter on `Week Start`.

`Week Start | Day | Slot | Recipe | Locked | Rating | Toddler Reaction | Notes`

**🛒 Shopping List** — one row per item, so ticking a box is a single-cell write and two
people shopping at once never contend.

`Week Start | Aisle | Item | Qty | Checked | Added By`

**_Meta** — revision counters the clients poll, plus `current_week`, `updated_at`, `updated_by`.

**📊 Meal History & Ratings** is deliberately out of scope. The app never touches it.
History comes from past weeks of the Weekly Meal Plan.

## Concurrency

Three layers, because Sheets has no transactions:

1. **LockService** serialises every write, so concurrent saves queue instead of interleaving.
2. **Field-level writes** mean most actions can't contend at all — ticking a shopping item
   writes one cell, adding a recipe appends one row.
3. **Revision counters** in `_Meta` drive a 20-second poll plus a refresh on tab focus.
   Only `savePlan` can genuinely conflict; it sends the revision it was based on and gets
   an explicit "overwrite or reload" prompt rather than silently clobbering.

Worst-case staleness is ~20 seconds. Sheets cannot push, and that is fine for a family app.

## Client-side guarantees

The generation prompt asks the model to avoid duplicates, honour the 3-from-database /
2-new ratio and never suggest tagine. `enforcePlanRules` enforces all three after the
fact, because a prompt instruction is not a guarantee. Substituted meals are labelled so
the swap is visible rather than silent.

`PLAN_DIRTY` stops a background sync from overwriting suggestions still being reviewed,
and expires after 30 minutes so an abandoned draft doesn't block sync forever.

## Rollback

`main` is untouched until this merges. The tag `v1-localstorage` marks the last
localStorage-only commit — reverting to it restores the previous app exactly, though
each device would need its API key re-entered.

## Deferred

- **Rating.** `rateMeal` and the columns exist; the UI is off pending a decision.
- **Sentinel-week testing.** The plan called for testing against `2099-01-01`. The local
  preview pointed at `/exec`, so test writes went to the real Sheet. No harm done, but the
  isolation was never exercised.
