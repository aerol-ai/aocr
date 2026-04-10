#!/bin/sh

set -eu

SOURCE_CONFIG="/etc/docker/registry/config.yml"
RUNTIME_CONFIG="/tmp/registry-config.yml"
NEEDS_RENDER="false"

escape_sed_replacement() {
    printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

if [ "$#" -gt 0 ]; then
    case "$1" in
        *.yaml|*.yml)
            SOURCE_CONFIG="$1"
            NEEDS_RENDER="true"
            ;;
    esac
else
    set -- "$SOURCE_CONFIG"
    NEEDS_RENDER="true"
fi

if [ "$NEEDS_RENDER" = "true" ]; then
    sed \
        -e "s|__PORT__|$(escape_sed_replacement "${PORT}")|g" \
        -e "s|__HOOK_TOKEN__|$(escape_sed_replacement "${HOOK_TOKEN}")|g" \
        -e "s|__HOOK_URI__|$(escape_sed_replacement "${HOOK_URI}")|g" \
        -e "s|__REPLREG_HOST__|$(escape_sed_replacement "${REPLREG_HOST}")|g" \
        -e "s|__REPLREG_SECRET__|$(escape_sed_replacement "${REPLREG_SECRET}")|g" \
        -e "s|__S3_REGION__|$(escape_sed_replacement "${S3_REGION}")|g" \
        -e "s|__S3_BUCKET__|$(escape_sed_replacement "${S3_BUCKET}")|g" \
        -e "s|__S3_ENDPOINT__|$(escape_sed_replacement "${S3_ENDPOINT}")|g" \
        "$SOURCE_CONFIG" > "$RUNTIME_CONFIG"
fi

# Run garbage collection job in background
# /garbage-collect.sh &

case "${1:-}" in
    *.yaml|*.yml) set -- registry serve "$RUNTIME_CONFIG" ;;
    serve|garbage-collect|help|-*) set -- registry "$@" ;;
esac

exec "$@"
