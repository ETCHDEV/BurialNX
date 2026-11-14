#!/usr/bin/env bash
# =============================================================================
# build-nxjs-runtime.sh — rebuild the nx.js runtime NRO with the BurialNX
# sleep/wake applet-hook patch, and install it into this repo's
# node_modules/@nx.js/nro so `npm run build` bundles the PATCHED runtime.
#
# WHY
# ----
# Stock nx.js (v1.0.0-beta.7) does NOT expose any applet lifecycle signal
# (no appletGetMessage, no AppletHook). BurialNX's sleep/wake detector
# (src/sleep-detect.ts) therefore falls back to a steady-frame heuristic,
# which is robust against the "restart mid-load" false positive but is still
# a heuristic. The deterministic signal — a libnx AppletHook for
# AppletHookType_OnFocusState — requires a ONE-LINE-LEVEL change to nx.js's
# native core (source/applet.cc). This script applies that patch
# (patches/nxjs-applet-sleep.patch) and rebuilds the runtime so the patched
# `nxjs.nro` exposes Switch.appletConsumeSleepWake() to JS.
#
# REQUIREMENTS
# ------------
# A devkitPro/libnx environment. The easiest way is the official devkitpro
# Docker image:
#
#   docker run --rm -it -v "$PWD":/work -w /work devkitpro/devkita64 \
#       bash tools/build-nxjs-runtime.sh
#
# (devkitpro/devkita64 ships devkitA64, libnx, portlibs, and Node.) On a
# bare-metal devkitpro install, just ensure DEVKITPRO is set and pnpm +
# node are on PATH, then run this script.
#
# WHAT IT DOES
# ------------
#   1. Clone nx.js at the tag matching @nx.js/nro (default: v1.0.0-beta.7).
#   2. Apply patches/nxjs-applet-sleep.patch to source/applet.cc.
#   3. pnpm install + pnpm bundle (build the JS runtime bundle).
#   4. make (compile source/*.cc with devkitA64 + libnx → nxjs.nro).
#   5. Copy the rebuilt nxjs.nro into node_modules/@nx.js/nro/nxjs.nro.
#   6. Print the next step: `npm run build` now bundles the patched runtime.
#
# After this, `npm run build` / `npm run build -- --debug` produce a
# burialnx(.nro|-debug.nro) whose runtime exposes appletConsumeSleepWake().
# BurialNX's sleep-detect.ts auto-detects the native function at runtime and
# switches from the heuristic to the deterministic path (see the one-time
# "_wake: native appletConsumeSleepWake available" log line).
# =============================================================================
set -euo pipefail

# --- repo root = directory containing this script's parent (tools/) -------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

NXJS_TAG="${NXJS_TAG:-v1.0.0-beta.7}"
PATCH="$REPO_ROOT/patches/nxjs-applet-sleep.patch"
WORK_DIR="${WORK_DIR:-$REPO_ROOT/.nxjs-build}"
NRO_DEST="$REPO_ROOT/node_modules/@nx.js/nro/nxjs.nro"

echo ">> BurialNX: build patched nx.js runtime"
echo "   repo root : $REPO_ROOT"
echo "   nx.js tag : $NXJS_TAG"
echo "   work dir  : $WORK_DIR"
echo "   patch     : $PATCH"

# --- preflight -------------------------------------------------------------
if [[ -z "${DEVKITPRO:-}" ]]; then
	echo "!! DEVKITPRO is not set. This script must run inside a devkitPro" >&2
	echo "   environment (e.g. the devkitpro/devkita64 Docker image)." >&2
	exit 1
fi
echo "   DEVKITPRO : $DEVKITPRO"
if [[ ! -f "$PATCH" ]]; then
	echo "!! patch not found: $PATCH" >&2
	exit 1
fi
command -v pnpm >/dev/null 2>&1 || {
	echo "!! pnpm not found on PATH (nx.js uses pnpm workspaces)." >&2
	exit 1
}
command -v node  >/dev/null 2>&1 || { echo "!! node not found on PATH."  >&2; exit 1; }

# --- 1. clone nx.js at the pinned tag (reuse if present) -------------------
if [[ -d "$WORK_DIR/nx.js/.git" ]]; then
	echo ">> reusing existing clone at $WORK_DIR/nx.js"
	git -C "$WORK_DIR/nx.js" fetch --tags --depth 1 origin "$NXJS_TAG"
	git -C "$WORK_DIR/nx.js" checkout "$NXJS_TAG"
else
	mkdir -p "$WORK_DIR"
	echo ">> cloning nx.js @ $NXJS_TAG"
	git clone --depth 1 --branch "$NXJS_TAG" https://github.com/TooTallNate/nx.js.git "$WORK_DIR/nx.js"
fi

# --- 2. apply the patch -----------------------------------------------------
echo ">> applying $PATCH"
git -C "$WORK_DIR/nx.js" checkout -- . 2>/dev/null || true
git -C "$WORK_DIR/nx.js" apply "$PATCH"
echo "   patched functions now registered:"
grep -n "appletConsumeSleepWake\|appletGetFocusState\|appletHook(" "$WORK_DIR/nx.js/source/applet.cc" || true

# --- 3. install deps + build the JS runtime bundle --------------------------
echo ">> pnpm install (nx.js workspaces)"
cd "$WORK_DIR/nx.js"
pnpm install --frozen-lockfile=false

echo ">> pnpm bundle (JS runtime bundle)"
pnpm bundle --force

# --- 4. make → nxjs.nro (native compile with devkitA64 + libnx) ------------
echo ">> make (this compiles source/*.cc with devkitA64 + libnx — may take several minutes)"
make -j"$(nproc)"

if [[ ! -f "$WORK_DIR/nx.js/nxjs.nro" ]]; then
	echo "!! build finished but nxjs.nro was not produced." >&2
	exit 1
fi
echo "   built: $(ls -la "$WORK_DIR/nx.js/nxjs.nro" | awk '{print $5" bytes"}')"

# --- 5. install into BurialNX's @nx.js/nro ----------------------------------
echo ">> installing patched nxjs.nro → $NRO_DEST"
mkdir -p "$(dirname "$NRO_DEST")"
cp "$WORK_DIR/nx.js/nxjs.nro" "$NRO_DEST"

# --- 6. next steps ----------------------------------------------------------
echo
echo ">> DONE. The patched nx.js runtime is now installed."
echo "   Next: build the BurialNX NROs (the build will bundle the patched runtime):"
echo "       npm run build            # → burialnx.nro"
echo "       npm run build -- --debug # → burialnx-debug.nro"
echo
echo "   Verify the native signal is active by checking the debug log for:"
echo "       _wake: native appletConsumeSleepWake available (deterministic detection active)"
