#!/bin/sh
# A mounted volume (Railway, Docker) is owned by root, but the server runs as the unprivileged "hookmint" user.
# Start as root only long enough to hand the data folder to that user, then drop privileges for good.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${HOOKMINT_DATA_DIR:-/data}"
  chown -R hookmint:hookmint "${HOOKMINT_DATA_DIR:-/data}"
  exec setpriv --reuid="$(id -u hookmint)" --regid="$(id -g hookmint)" --init-groups "$@"
fi
exec "$@"
