#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION_FILE="$ROOT/version.js"
SW_FILE="$ROOT/service-worker.js"

# Extraer la versión de version.js
VERSION=$(grep -oP "'\K[0-9]+\.[0-9]+\.[0-9]+(?=')" "$VERSION_FILE" | head -1)
if [[ -z "$VERSION" ]]; then
  echo "Error: no se pudo leer la versión de $VERSION_FILE" >&2
  exit 1
fi

# Actualizar el fallback en service-worker.js
sed -i "s/\(self\.EDUMIX_VERSION || '\)[^']*'/\1${VERSION}'/" "$SW_FILE"

echo "Versión sincronizada: $VERSION"
