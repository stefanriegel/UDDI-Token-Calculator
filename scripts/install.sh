#!/bin/sh
set -e

REPO="stefanriegel/UDDI-Token-Calculator"
BINARY="uddi-token-calculator"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
CHANNEL="stable"

# Parse flags
while [ $# -gt 0 ]; do
  case "$1" in
    --channel)
      if [ -z "$2" ]; then
        echo "Error: --channel requires a value (stable or dev)." >&2
        exit 1
      fi
      case "$2" in
        stable|dev) CHANNEL="$2" ;;
        *) echo "Error: unknown channel '$2'. Use 'stable' or 'dev'." >&2; exit 1 ;;
      esac
      shift 2
      ;;
    --help)
      echo "Usage: install.sh [--channel stable|dev]"
      echo ""
      echo "Options:"
      echo "  --channel stable   Install the latest stable release (default)"
      echo "  --channel dev      Install the latest dev pre-release"
      echo "  --help             Show this help message"
      exit 0
      ;;
    *)
      echo "Error: unknown option '$1'. Use --help for usage." >&2
      exit 1
      ;;
  esac
done

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

case "$OS" in
  darwin|linux) ;;
  *) echo "Unsupported OS: $OS (use Windows releases from GitHub)"; exit 1 ;;
esac

ASSET="${BINARY}_${OS}_${ARCH}"

# Get release tag via GitHub API
if [ "$CHANNEL" = "stable" ]; then
  TAG=$(curl -s "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"//;s/".*//')
else
  # Dev channel: find first pre-release from list endpoint
  TAG=$(curl -s "https://api.github.com/repos/${REPO}/releases?per_page=20" | \
    python3 -c "
import json, sys
for r in json.load(sys.stdin):
    if r.get('prerelease'):
        print(r['tag_name'])
        break
" 2>/dev/null)
  if [ -z "$TAG" ]; then
    # Fallback: find first prerelease tag via grep/sed
    TAG=$(curl -s "https://api.github.com/repos/${REPO}/releases?per_page=20" | \
      grep -B5 '"prerelease": true' | grep '"tag_name"' | head -1 | \
      sed 's/.*"tag_name": *"//;s/".*//')
  fi
fi

if [ -z "$TAG" ]; then
  echo "Failed to determine latest ${CHANNEL} release"
  exit 1
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

echo "Downloading ${BINARY} ${TAG} (${CHANNEL}) for ${OS}/${ARCH}..."
TMPFILE=$(mktemp)
HTTP_CODE=$(curl -sL -o "$TMPFILE" -w "%{http_code}" "$URL")

if [ "$HTTP_CODE" != "200" ]; then
  rm -f "$TMPFILE"
  echo "Download failed (HTTP ${HTTP_CODE}). No binary available for ${OS}/${ARCH}."
  echo "Check available assets at: https://github.com/${REPO}/releases/tag/${TAG}"
  exit 1
fi

chmod +x "$TMPFILE"

# Remove quarantine attribute on macOS
if [ "$OS" = "darwin" ]; then
  xattr -d com.apple.quarantine "$TMPFILE" 2>/dev/null || true
fi

# Ensure install directory exists
mkdir -p "$INSTALL_DIR"

# Install
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "${INSTALL_DIR}/${BINARY}"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "$TMPFILE" "${INSTALL_DIR}/${BINARY}"
fi

echo "Installed ${BINARY} ${TAG} (${CHANNEL}) to ${INSTALL_DIR}/${BINARY}"

# Check if install dir is in PATH
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo ""
    echo "NOTE: ${INSTALL_DIR} is not in your PATH."
    SHELL_NAME=$(basename "$SHELL")
    case "$SHELL_NAME" in
      zsh)  RC="$HOME/.zshrc" ;;
      bash) RC="$HOME/.bashrc" ;;
      *)    RC="your shell rc file" ;;
    esac
    echo "Add it with:  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ${RC}"
    echo "Then reload:  source ${RC}"
    ;;
esac

echo "Run '${BINARY}' to start."
