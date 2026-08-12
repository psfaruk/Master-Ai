# Railway Environment Variables

Railway-এ deploy করার সময় নিচের variables গুলো Variables tab এ যোগ করুন:

## Required (Railway auto-sets)

| Variable | Value | Notes |
|---|---|---|
| `PORT` | `3000` | Railway স্বয়ংক্রিয়ভাবে সেট করে |
| `NODE_ENV` | `production` | Production mode |

## Optional (only if using Prisma DB)

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `file:./prisma/dev.db` | SQLite — Railway volume এ store করতে চাইলে `/data/dev.db` use করুন |

## How Railway Auto-Deploys

1. `git push` to `main` branch
2. Railway detects push via GitHub webhook
3. Build phase (Nixpacks):
   - `bun install --frozen-lockfile`
   - `bun run build` (Next.js standalone build)
   - Copies `.next/static` and `public` into `.next/standalone/`
4. Deploy phase:
   - Runs `node .next/standalone/server.js`
   - Listens on `$PORT` (Railway injects this)
   - Health check via HTTP GET `/`

## Custom Domain

1. Railway dashboard → Settings → Networking
2. "Generate Domain" বা custom domain যোগ করুন
3. Railway একটি `xxx.up.railway.app` URL দিবে

## Logs

Railway dashboard → Deployments → যেকোনো deployment এ ক্লিক করুন → "Logs" tab এ real-time logs দেখুন।
