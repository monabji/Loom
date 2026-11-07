#!/usr/bin/env bash
set -euo pipefail

app_dir="${APPDIR:-$(dirname -- "$(readlink -f -- "$0")")}"
export LD_LIBRARY_PATH="${app_dir}/usr/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
exec "${app_dir}/loom" "$@"
