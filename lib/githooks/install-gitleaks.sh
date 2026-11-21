#!/usr/bin/env bash
# Installs the pinned gitleaks binary into <dest-dir>/gitleaks after checking its sha256.
# Idempotent; never fails a session (always exits 0; the pre-commit scan warns and skips without it).
# Usage: install-gitleaks.sh <dest-dir> [--quiet]
# Checksums: gitleaks_<v>_checksums.txt from the official GitHub release.
set -u
DEST="${1:?usage: install-gitleaks.sh <dest-dir> [--quiet]}"
QUIET=0; [ "${2:-}" = "--quiet" ] && QUIET=1
say() { [ "$QUIET" = 1 ] || echo "$@"; }

VERSION="8.30.1"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)               PLAT=linux_x64;    SUM=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  Linux-aarch64|Linux-arm64)  PLAT=linux_arm64;  SUM=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  Darwin-arm64)               PLAT=darwin_arm64; SUM=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  Darwin-x86_64)              PLAT=darwin_x64;   SUM=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  *) echo "project-kit: no pinned gitleaks for $(uname -s)-$(uname -m); install gitleaks on PATH to enable the secret scan." >&2; exit 0 ;;
esac

BIN="$DEST/gitleaks"
if [ -x "$BIN" ] && "$BIN" version 2>/dev/null | grep -q "$VERSION"; then
  say "gitleaks $VERSION already installed"
  exit 0
fi
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_${PLAT}.tar.gz"
if ! curl -fsSL --max-time 60 -o "$TMP/gl.tgz" "$URL"; then
  echo "project-kit: gitleaks download failed; the pre-commit secret scan will warn and skip." >&2; exit 0
fi
if [ "$(sha "$TMP/gl.tgz")" != "$SUM" ]; then
  echo "project-kit: CHECKSUM MISMATCH for the gitleaks download; not installing." >&2; exit 0
fi
mkdir -p "$DEST" "$TMP/x"
tar -xzf "$TMP/gl.tgz" -C "$TMP/x" gitleaks && cp "$TMP/x/gitleaks" "$BIN" && chmod 0755 "$BIN"
if [ -x "$BIN" ] && "$BIN" version 2>/dev/null | grep -q "$VERSION"; then say "gitleaks $VERSION installed at $BIN"; else echo "project-kit: gitleaks install failed" >&2; fi
exit 0
