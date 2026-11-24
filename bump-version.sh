#!/bin/sh
# Give app.js and styles.css a new version so phones always load matching files.
# Usage: ./bump-version.sh 2026.11.24-1
set -e
cd "$(dirname "$0")"
v="$1"; [ -n "$v" ] || { echo "usage: $0 <version>"; exit 1; }
sed -i '' -E "s/(app\.js|styles\.css)\?v=[^\"]+/\1?v=$v/g" public/index.html
sed -i '' -E "s/^const APP_VERSION = '[^']+';/const APP_VERSION = '$v';/" public/app.js
grep -n "?v=\|APP_VERSION = " public/index.html public/app.js
