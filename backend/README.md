# Backend — Apps Script Web App

`Code.gs` is the API that sits between the web app and the Google Sheet. It is **not**
deployed from this repo — it is pasted into the Apps Script project bound to
`Family_Meal_Planner`. This copy exists so the backend is version-controlled alongside
the frontend.

## Setup (one-time)

1. Open the Sheet -> Extensions -> Apps Script (this binds the script to the Sheet)
2. Paste the contents of `Code.gs`
3. Project Settings -> Script Properties:

   | Property | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | `sk-ant-...` |
   | `FAMILY_PASSPHRASE` | agreed family passphrase |
   | `TOKEN_SECRET` | any long random string |
   | `MODEL` | optional, defaults to `claude-sonnet-4-6` |

4. Run `selfTest()` from the editor — confirms tabs and properties line up
5. Deploy -> New deployment -> Web app
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Deploy -> Test deployments -> copy the `/dev` URL

## Two URLs

| URL | Runs | Used by |
|---|---|---|
| `/exec` | the deployed version | `main` — the live app |
| `/dev` | whatever is currently saved | local preview of the `dev` branch |

**When changing code later:** Deploy -> Manage deployments -> edit the *existing*
deployment. Creating a new deployment changes the `/exec` URL and breaks the live app.

## Notes

- CORS: Apps Script cannot set custom headers. The frontend posts with
  `Content-Type: text/plain` so the browser skips preflight.
- All writes are wrapped in `LockService` so concurrent saves queue rather than collide.
- `_Meta` holds revision counters; the frontend polls `getRevisions` every 20s.
- Testing uses the sentinel week `2099-01-01` so test rows never mix with real data.
