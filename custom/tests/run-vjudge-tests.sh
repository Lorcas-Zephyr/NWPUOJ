#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

docker run --rm --network none \
  -v "$root/custom/tests:/tests:ro" \
  -v "$root/custom/libs-built/vjudge:/work/vjudge:ro" \
  -v "$root/custom/libs/vjudge-credential-context.js:/libs/vjudge-credential-context.js:ro" \
  -v "$root/custom/node_modules:/app/custom-node-modules:ro" \
  -e UOJ_VJUDGE_MODULE=/work/vjudge/uoj \
  -e HDU_VJUDGE_MODULE=/work/vjudge/hdu \
  -e POJ_VJUDGE_MODULE=/work/vjudge/poj \
  -e NODE_PATH=/app/custom-node-modules:/app/node_modules \
  menci/syzoj-web sh -c '
    node /tests/uoj_vjudge.test.js &&
    node /tests/hdu_vjudge.test.js &&
    node /tests/hdu_protocol.test.js &&
    node /tests/poj_vjudge.test.js &&
    node /tests/poj_protocol.test.js
  '
