#!/bin/bash
# Start a local web server to serve the app.
# Usage: ./start.sh [port]

PORT="${1:-3000}"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Starting DX Visualizer on http://localhost:$PORT"
echo "Press Ctrl+C to stop."
echo ""

# Try Python 3 first (pre-installed on macOS/Linux)
if command -v python3 &>/dev/null; then
  cd "$DIR" && python3 -m http.server "$PORT"
elif command -v python &>/dev/null; then
  cd "$DIR" && python -m http.server "$PORT"
elif command -v npx &>/dev/null; then
  npx --yes serve "$DIR" -l "$PORT" -s
else
  echo "Error: No suitable server found."
  echo "Please install Python 3 or Node.js, then try again."
  exit 1
fi
