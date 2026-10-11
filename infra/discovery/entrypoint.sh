#!/bin/sh
# Exit 78 is an operator stop: remain blocked rather than repeatedly competing.
node --experimental-transform-types --import ./scripts/ingest/register.mjs services/media-gateway/discovery.mts &
worker_pid=$!
trap 'kill -TERM "$worker_pid" 2>/dev/null; wait "$worker_pid"; exit 0' TERM INT
wait "$worker_pid"
worker_status=$?
if [ "$worker_status" -eq 78 ]; then
  echo '{"event":"discovery_operator_intervention_required","exitCode":78}'
  sleep infinity &
  worker_pid=$!
  wait "$worker_pid"
fi
exit "$worker_status"
