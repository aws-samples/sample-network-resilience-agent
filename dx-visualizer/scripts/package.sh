#!/bin/bash
# Build and package the app into a distributable zip file.
# Usage: ./scripts/package.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_NAME="dx-visualizer"

cd "$PROJECT_DIR"

echo "Installing dependencies..."
npm ci --silent

echo "Building..."
npm run build

# Create a clean staging directory
STAGE_DIR="$PROJECT_DIR/$DIST_NAME"
rm -rf "$STAGE_DIR" "$PROJECT_DIR/$DIST_NAME.zip"
mkdir -p "$STAGE_DIR"

# Copy built files and start scripts
cp -r dist/* "$STAGE_DIR/"
cp scripts/start.sh "$STAGE_DIR/"
cp scripts/start.bat "$STAGE_DIR/"
cp .env.example "$STAGE_DIR/" 2>/dev/null || true

# Create a simple README for the zip
cat > "$STAGE_DIR/README.txt" << 'EOF'
AWS Direct Connect Topology Visualizer
=======================================

Quick Start:
  macOS/Linux:  ./start.sh
  Windows:      start.bat

Then open http://localhost:3000 in your browser.

Requirements:
  - Python 3 (pre-installed on macOS/Linux) OR Node.js 18+
  - The start script auto-detects which is available.

Configuration:
  Click "Connect AWS" in the app to enter your AWS credentials.
  Credentials are never stored — they only live in browser memory for the session.

Need a different port?
  ./start.sh 8080
  start.bat 8080
EOF

# Zip it
cd "$PROJECT_DIR"
zip -rq "$DIST_NAME.zip" "$DIST_NAME"
rm -rf "$STAGE_DIR"

echo ""
echo "Done! Distributable package: $PROJECT_DIR/$DIST_NAME.zip"
echo "Size: $(du -h "$DIST_NAME.zip" | cut -f1)"
