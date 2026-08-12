#!/bin/bash
# ============================================================
# Master-Ai — GitHub Push Script
# ============================================================
# এই script টি চালানোর আগে আপনার GitHub Personal Access Token
# (PAT) প্রয়োজন। নিচের ধাপ অনুসরণ করুন:
#
# ১. https://github.com/settings/tokens এ যান
# ২. "Generate new token (classic)" ক্লিক করুন
# ৩. Scopes: "repo" (Full control of private repositories) সিলেক্ট করুন
# ৪. Generate token → token টি কপি করুন (ghp_xxxxxxxxxxxx...)
# ৫. নিচের command চালান:
#
#    GH_TOKEN=ghp_xxxxxxxxxxxx bash scripts/push-to-github.sh
#
# ============================================================

set -e

cd "$(dirname "$0")/.."

if [ -z "$GH_TOKEN" ]; then
  echo "❌ Error: GH_TOKEN environment variable সেট করা নেই"
  echo ""
  echo "Usage:"
  echo "  GH_TOKEN=ghp_your_token_here bash scripts/push-to-github.sh"
  echo ""
  echo "GitHub Personal Access Token তৈরি করুন:"
  echo "  https://github.com/settings/tokens"
  echo "  Scopes: repo (Full control of private repositories)"
  exit 1
fi

REPO_URL="https://${GH_TOKEN}@github.com/psfaruk/Master-Ai.git"

echo "🚀 Master-Ai — GitHub এ push করা হচ্ছে..."
echo ""

# Update remote URL with token
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"

# Ensure we're on main branch
git branch -M main

# Push
echo "📦 Pushing to https://github.com/psfaruk/Master-Ai.git (main branch)..."
git push -u origin main

echo ""
echo "✅ সফলভাবে push হয়েছে!"
echo ""
echo "🔗 Repo: https://github.com/psfaruk/Master-Ai"
echo ""
echo "এখন Railway তে deploy করুন:"
echo "  1. https://railway.app/new এ যান"
echo "  2. 'Deploy from GitHub repo' → psfaruk/Master-Ai সিলেক্ট করুন"
echo "  3. Railway স্বয়ংক্রিয়ভাবে detect করবে (nixpacks.toml + railway.json)"
echo "  4. Deploy ক্লিক করুন — build + start স্বয়ংক্রিয়"
echo "  5. প্রতিটি git push এ auto-redeploy হবে"
