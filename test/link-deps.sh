#!/bin/sh
# Link the globally installed pi packages into ./node_modules so unit tests can import them.
set -e
cd "$(dirname "$0")/.."
PI_DIR="$(npm root -g)/@earendil-works/pi-coding-agent"
[ -d "$PI_DIR" ] || { echo "pi not installed globally (npm i -g @earendil-works/pi-coding-agent)"; exit 1; }
mkdir -p node_modules/@earendil-works
ln -sfn "$PI_DIR" node_modules/@earendil-works/pi-coding-agent
for p in pi-ai pi-tui pi-agent-core; do ln -sfn "$PI_DIR/node_modules/@earendil-works/$p" "node_modules/@earendil-works/$p"; done
ln -sfn "$PI_DIR/node_modules/typebox" node_modules/typebox
echo "linked pi packages from $PI_DIR"
