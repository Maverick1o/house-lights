#!/bin/sh
# Give every app file a new version so phones always load matching files.
# (app.js is a small loader; the app itself is main.js plus the shared modules.)
# Usage: ./bump-version.sh 2026.11.24-1
set -e
cd "$(dirname "$0")"
v="$1"; [ -n "$v" ] || { echo "usage: $0 <version>"; exit 1; }
sed -i '' -E "s/(app\.js|styles\.css)\?v=[^\"]+/\1?v=$v/g" public/index.html
sed -i '' -E "s/^  var version = '[^']+';/  var version = '$v';/" public/app.js
sed -i '' -E "s/(name=\"app-version\" content=\")[^\"]+/\1$v/" public/index.html
sed -i '' -E "s/^const APP_VERSION = '[^']+';/const APP_VERSION = '$v';/" public/main.js
sed -i '' -E "s#(shared/[a-z-]+\.js)\?v=[^']+'#\1?v=$v'#g" public/main.js
grep -n "?v=\|APP_VERSION = \|var version = \|app-version" public/index.html public/app.js public/main.js
