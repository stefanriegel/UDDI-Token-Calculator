#!/bin/sh
set -e

REPO="stefanriegel/UDDI-Token-Calculator"
BINARY="uddi-token-calculator"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

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

# Get latest release tag
TAG=$(curl -sI "https://github.com/${REPO}/releases/latest" | grep -i '^location:' | sed 's|.*/||' | tr -d '\r')
if [ -z "$TAG" ]; then
  echo "Failed to determine latest release"
  exit 1
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

echo "Downloading ${BINARY} ${TAG} for ${OS}/${ARCH}..."
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

echo "Installed ${BINARY} ${TAG} to ${INSTALL_DIR}/${BINARY}"

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
