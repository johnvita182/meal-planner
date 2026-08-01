# Login throttle

Added to `login()` in `Code.gs`.

## Design

| | |
|---|---|
| Threshold | 20 failed logins |
| Window | 15 minutes (`CacheService`, auto-expiring) |
| Scope | Global — Apps Script cannot see client IP |
| On success | Counter resets |
| Manual reset | Run `resetThrottle()` from the editor |

## Why global, and what that costs

Apps Script web apps do not expose the caller's IP address, so the counter cannot
be per-client. It is one counter for the whole script.

The tradeoff: someone hammering the endpoint can push the counter over the limit and
lock the family out for up to 15 minutes. That is a nuisance, not a breach — and
`resetThrottle()` clears it instantly from the editor.

The threshold is deliberately high (20). Normal use produces zero failures; a
mistyped passphrase produces one or two. Twenty consecutive failures means someone
is guessing.

## What this does and does not protect

**Does:** caps guesses at ~20 per 15 min, i.e. ~1,900/day. Against a 4-random-word
passphrase that is effectively unbreakable.

**Does not:** protect a weak passphrase from a lucky guess, or stop anyone who
already knows the passphrase. Entropy in the passphrase is still doing most of the work.

## Note on cache behaviour

`CacheService` is best-effort — Google may evict entries early under memory pressure,
which would reset the counter sooner than 15 minutes. Acceptable here: the throttle is
defence in depth, not the primary control.
