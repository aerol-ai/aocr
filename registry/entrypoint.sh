#!/bin/sh

set -eu

SOURCE_CONFIG="/etc/docker/registry/config.yml"
RUNTIME_CONFIG="/tmp/registry-config.yml"
AUTH_CERT_BUNDLE_PATH="${AUTH_CERT_BUNDLE_PATH:-/etc/docker/registry/auth.crt}"
NEEDS_RENDER="false"

escape_sed_replacement() {
    printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

validate_token_root_certificate() {
    if [ ! -s "$AUTH_CERT_BUNDLE_PATH" ] || ! grep -q "BEGIN CERTIFICATE" "$AUTH_CERT_BUNDLE_PATH"; then
        echo "registry token auth requires a PEM-encoded X.509 certificate bundle at $AUTH_CERT_BUNDLE_PATH" >&2
        echo "provide auth.jwtPublicCertificate (BEGIN CERTIFICATE), not a raw public key (BEGIN PUBLIC KEY)" >&2
        exit 1
    fi
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
    validate_token_root_certificate
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
