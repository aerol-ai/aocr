#!/bin/sh

set -e

DRY_RUN=${DRY_RUN:-"true"}
CONFIG_FILE=${1:-"/etc/docker/registry/config.yml"}

if [ "$DRY_RUN" = "true" ] || [ "$DRY_RUN" = "1" ]; then
    echo "Running registry garbage-collect in dry-run mode..."
    exec registry garbage-collect --dry-run "$CONFIG_FILE"
else
    echo "Running registry garbage-collect in DELETE mode..."
    exec registry garbage-collect "$CONFIG_FILE"
fi
