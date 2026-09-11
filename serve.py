#!/usr/bin/env python3
"""Static dev server that never caches.

python -m http.server sends Last-Modified and no cache directives, so browsers
hold on to style.css/app.js across edits — which silently serves stale UI while
you are testing a change you just made.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter output
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    directory = sys.argv[2] if len(sys.argv) > 2 else "."
    handler = lambda *a, **kw: NoCacheHandler(*a, directory=directory, **kw)
    print(f"Serving {directory} on http://localhost:{port} (no-cache)")
    ThreadingHTTPServer(("", port), handler).serve_forever()
