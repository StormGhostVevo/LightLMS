#!/bin/sh
# Hosting platforms usually mount a volume owned by root, which the unprivileged "node" user can't write to.
# So: if we start as root, hand /data to "node", then continue as "node". If we already start as "node", just run.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
