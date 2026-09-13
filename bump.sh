#!/usr/bin/env bash
# Stamp a content hash onto the local asset URLs in index.html.
#
# Browsers cache style.css/app.js by URL. Without a changing URL they may serve
# a stale copy for hours — heuristic caching applies even when the server sends
# no-store, because an entry stored earlier is never revalidated. Changing the
# query string makes it a different URL, so the browser must fetch it.
#
# Run before committing or deploying:  ./bump.sh
set -euo pipefail
cd "$(dirname "$0")"

hash_of() { shasum -a 256 "$1" | cut -c1-8; }

css=$(hash_of style.css)
js=$(hash_of app.js)

# Replace any existing ?v=… (or bare filename) with the new hash
perl -pi -e "s{(href=\")style\.css(\?v=[0-9a-f]+)?(\")}{\${1}style.css?v=$css\${3}}" index.html
perl -pi -e "s{(src=\")app\.js(\?v=[0-9a-f]+)?(\")}{\${1}app.js?v=$js\${3}}" index.html

echo "style.css -> ?v=$css"
echo "app.js    -> ?v=$js"
