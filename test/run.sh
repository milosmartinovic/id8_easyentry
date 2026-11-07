#!/bin/sh
# Every check that needs no car. With a bionic chroot holding vsomeip and the fake provider
# (native/seatctl/test, see README "Development"), also the end-to-end run: INTEGRATION=1 test/run.sh
set -e
cd "$(dirname "$0")/.."
node tools/mm-easy-entry/easyentry.js --test
node apps/mm_easy_entry/tools/test_app.js
for f in tools/mm-easy-entry/*.js apps/mm_easy_entry/src/*.js; do node --check "$f"; done
if [ -n "${INTEGRATION:-}" ]; then node test/integration.js; fi
echo "all checks ok"
