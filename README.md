# House Lights

Control the family's LIFX lights from an iPhone. Sign in with Face ID (passkeys); each person only reaches the houses they were invited to.

- App: https://house-lights-sigma.vercel.app
- Hosting: Vercel (Hobby plan) — static app in `public/`, one serverless function in `api/handler.js`.
- Storage: Upstash Redis (free tier, via the Vercel Marketplace) — passkeys, sessions, invites and synced settings.

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | What |
|---|---|
| `LIFX_TOKEN_<HOUSE>` | One per house, e.g. `LIFX_TOKEN_HOME`, `LIFX_TOKEN_MOM_AND_DAD`. Mark as **Sensitive**. |
| `SETUP_CODE` | Any passphrase. Needed once, to create the first (admin) passkey. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Added automatically when Upstash Redis is connected. |

Redeploy after changing environment variables.

## Development

```
npm install
npm test                 # backend tests, incl. a simulated Face ID authenticator
node test/dev-server.js  # full app on http://localhost:8787 with fake LIFX accounts
./bump-version.sh <v>    # bump the app version so phones load fresh files
```

The root `index.html` only forwards the old GitHub Pages address to the Vercel app.
