#!/bin/sh
# Recompile app.jsx -> app.js after editing the source. Requires Node.js.
# Usage:  npm install --no-save @babel/core @babel/cli @babel/preset-react
#         sh build.sh
# (babel.config.json pins the classic JSX runtime — the automatic runtime
#  emits `import` statements this no-bundler site cannot run.)
npx babel app.jsx -o app.js
