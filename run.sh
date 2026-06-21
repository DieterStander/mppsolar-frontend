#!/usr/bin/env bash
# Launch the Inverter Console.
#
#   ./run.sh                       # serve against the real inverter (/dev/hidraw0)
#   MPPF_PORT=test ./run.sh        # dev mode, no hardware (canned responses)
#
# First run creates a virtualenv and installs dependencies.
set -euo pipefail
cd "$(dirname "$0")"

VENV=".venv"
if [ ! -d "$VENV" ]; then
  echo "Creating virtualenv…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip
  "$VENV/bin/pip" install -r requirements.txt
fi

export MPPF_PORT="${MPPF_PORT:-/dev/hidraw0}"
export MPPF_HTTP_PORT="${MPPF_HTTP_PORT:-8080}"

echo "Serving on http://0.0.0.0:${MPPF_HTTP_PORT}  (inverter port: ${MPPF_PORT})"
exec "$VENV/bin/uvicorn" backend.app:app --host "${MPPF_HOST:-0.0.0.0}" --port "${MPPF_HTTP_PORT}"
