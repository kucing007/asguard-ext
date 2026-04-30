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
cat > dist/CARA-INSTALL.txt << 'EOF'
===========================================
  ASGUARD — Cara Install / Update Extension
===========================================

INSTALL BARU:
1. Ekstrak file ZIP ini ke folder mana saja (misal: Desktop/asguard)
2. Buka Chrome, ketik chrome://extensions di address bar
3. Aktifkan "Developer mode" (toggle di kanan atas)
4. Klik "Load unpacked"
5. Pilih folder hasil ekstrak (folder yang berisi file manifest.json)
6. Selesai! Klik icon Asguard di toolbar untuk membuka panel

UPDATE:
1. Ekstrak file ZIP ini
2. Timpa (replace) folder extension yang lama dengan yang baru
3. Buka chrome://extensions
4. Klik tombol reload (🔄) pada kartu Asguard
5. Selesai!

CATATAN:
- Template, pengaturan, dan data lainnya TIDAK akan hilang saat update
- Jika ingin backup data, buka Pengaturan > Backup & Restore > Ekspor
- Butuh bantuan? Hubungi admin

===========================================
EOF
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
