#!/bin/bash
# Download the India-wide village directory (~6.6 lakh rows) into data/4-village.csv.
# This file is ~100 MB uncommitted (git-ignored) — seed it into Mongo, don't commit it.
# Source: planemad/india-local-government-directory (mirror of lgdirectory.gov.in).
set -euo pipefail
cd "$(dirname "$0")/data"

URL="https://raw.githubusercontent.com/planemad/india-local-government-directory/master/administrative/4-village.csv.zip"
echo "⬇️  downloading village directory…"
curl -fL --retry 3 -o 4-village.csv.zip "$URL"
echo "📦 unzipping…"
unzip -o 4-village.csv.zip
rm -f 4-village.csv.zip
echo "✅ data/4-village.csv ready ($(wc -l < 4-village.csv) lines). Now: node scripts/geo-data/seed-geo.js --villages"
