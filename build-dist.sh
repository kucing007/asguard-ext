#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PEM="./dist.pem"

echo "🧹 Cleaning old build..."
rm -rf dist asguard-ext.zip dist.crx

echo "🔨 Building for production..."
npm run build 2>&1 | grep -v 'Obfuscator Pro' | grep -v 'obfuscator.io'

echo "🧹 Removing non-essential files..."
find dist -name "*.map" -delete 2>/dev/null || true
find dist -name "*.ts" -not -path "*/node_modules/*" -delete 2>/dev/null || true
find dist -name "*.tsx" -delete 2>/dev/null || true
find dist -name ".DS_Store" -delete 2>/dev/null || true

echo "📦 Creating zip..."
cd dist && zip -r ../asguard-ext.zip . -x "*.DS_Store" && cd ..

echo "🔐 Packing CRX..."
if [ -f "$PEM" ]; then
  "$CHROME" --pack-extension=./dist --pack-extension-key="$PEM" 2>/dev/null
else
  "$CHROME" --pack-extension=./dist 2>/dev/null
  echo "   ⚠ New dist.pem created — keep it safe, don't lose it!"
fi

ZIP_SIZE=$(du -h asguard-ext.zip | cut -f1)
CRX_SIZE=$(du -h dist.crx | cut -f1)
VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')

echo ""
echo "✅ Done! v${VERSION}"
echo "   📁 asguard-ext.zip  ($ZIP_SIZE) — Load unpacked"
echo "   📁 dist.crx         ($CRX_SIZE) — Distribute to users"
echo "   🔑 dist.pem                     — Signing key (DO NOT share)"
