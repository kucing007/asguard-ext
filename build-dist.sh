#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

echo "🧹 Cleaning old build..."
rm -rf dist asguard-ext.zip

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
2. Buka Chrome, ketik "chrome://extensions" di address bar
3. Aktifkan "Developer mode" (toggle di kanan atas)
4. Klik "Load unpacked"
5. Pilih folder hasil ekstrak (folder yang berisi file manifest.json)
6. Selesai! Klik icon Asguard di toolbar untuk membuka panel

UPDATE (dari versi ini ke versi berikutnya):
1. Ekstrak file ZIP ini ke folder mana saja (boleh folder baru, boleh timpa)
2. Buka chrome://extensions, klik reload (🔄) pada kartu Asguard
   ATAU klik "Load unpacked" lalu pilih folder baru
3. Template & pengaturan tetap tersimpan — extension ID sudah dipasang permanen

CATATAN:
- Setelah upgrade pertama ke versi ini, folder mana pun aman — data tetap tersimpan
- Untuk backup manual: Pengaturan > Backup & Restore > Ekspor
- Butuh bantuan? Hubungi admin

===========================================
EOF
cd dist && zip -r ../asguard-ext.zip . -x "*.DS_Store" && cd ..

ZIP_SIZE=$(du -h asguard-ext.zip | cut -f1)
VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')

echo ""
echo "✅ Done! v${VERSION}"
echo "   📁 asguard-ext.zip  ($ZIP_SIZE) — Distribute to users (load unpacked)"
