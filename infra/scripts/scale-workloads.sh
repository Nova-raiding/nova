#!/bin/sh
set -eu
profile=${1:-pilot_50}
case "$profile" in
  pilot_50) api=3; sync=2; generation=2; publish=3; reconcile=2; automation=1 ;;
  wave_100) api=3; sync=2; generation=2; publish=3; reconcile=2; automation=1 ;;
  wave_250) api=6; sync=4; generation=6; publish=5; reconcile=3; automation=1 ;;
  target_500) api=12; sync=12; generation=16; publish=8; reconcile=4; automation=1 ;;
  *) echo "unknown capacity profile: $profile" >&2; exit 2 ;;
esac
echo "profile=$profile api=$api sync=$sync generation=$generation publish=$publish reconcile=$reconcile automation=$automation"
if [ "${EXECUTE:-false}" != true ]; then
  echo "dry run; set EXECUTE=true and provide SCALE_COMMAND"
  exit 0
fi
: "${SCALE_COMMAND:?SCALE_COMMAND is required when EXECUTE=true}"
for workload in api sync generation publish reconcile automation; do
  replicas=$(eval "printf '%s' \"\${$workload}\"")
  sh -c "$SCALE_COMMAND $workload $replicas"
done
