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
  echo "dry run; set EXECUTE=true to apply with kubectl"
  exit 0
fi
namespace=${SCALE_NAMESPACE:-merchant}
printf '%s\n' "$namespace" | grep -Eq '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' || { echo "invalid SCALE_NAMESPACE" >&2; exit 2; }
kubectl scale -n "$namespace" deployment/merchant-api --replicas="$api"
kubectl scale -n "$namespace" deployment/merchant-worker-sync --replicas="$sync"
kubectl scale -n "$namespace" deployment/merchant-worker-generation --replicas="$generation"
kubectl scale -n "$namespace" deployment/merchant-worker-publish --replicas="$publish"
kubectl scale -n "$namespace" deployment/merchant-worker-reconcile --replicas="$reconcile"
kubectl scale -n "$namespace" deployment/merchant-worker-automation --replicas="$automation"
