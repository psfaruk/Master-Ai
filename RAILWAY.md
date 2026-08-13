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

## Optional (candle alignment)

তিনটি অ্যাপ সবসময় একই candle-কে একই নামে label করে না — একটি অ্যাপ যে candle
বিশ্লেষণ করছে সেটির সময় দেয়, আরেকটি যে candle predict করছে সেটির। ফলে signal
গুলো পাশাপাশি bucket-এ পড়ে যায় এবং কখনো consensus তৈরি হয় না।

**App 2-এর offset কোডেই ঠিক করা আছে — আবার সেট করবেন না।** App 2-এর
`/api/share-signals` শেষ *বন্ধ হওয়া* candle-এর সময় পাঠায়, কিন্তু signal-টা
তার *পরের* (চলতি) candle-এর জন্য। তাই `app2-cache.ts`-এ এক candle এগিয়ে
নেওয়া হয়। এর উপরে `APP2_CANDLE_OFFSET=1` দিলে এক candle বেশি সরে যাবে।

বাকি কোনো offset থাকলে `/api/diag`-এ `offsets[].modalOffsetCandles` দেখুন।
মান `0` হলে alignment ঠিক আছে, কিছু সেট করার দরকার নেই। `0` না হলে নিচের
variable দিয়ে ঠিক করুন (`offsets[].hint`-এ ঠিক কোনটা সেট করতে হবে লেখা থাকে):

| Variable | Value | Notes |
|---|---|---|
| `APP1_CANDLE_OFFSET` | `0` | App 1-এর candle কত candle শিফট করতে হবে (−5 … 5) |
| `APP2_CANDLE_OFFSET` | `0` | App 2-এর জন্য একই |
| `APP3_CANDLE_OFFSET` | `0` | App 3-এর জন্য একই |

## Optional (signal-pusher mini-service)

| Variable | Value | Notes |
|---|---|---|
| `SNAPSHOT_URL` | `http://127.0.0.1:3000/api/snapshot` | pusher এখান থেকে snapshot relay করে — নিজে aggregate করে না |
| `PUSH_INTERVAL_MS` | `5000` | কত ms পর পর push করবে |

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
