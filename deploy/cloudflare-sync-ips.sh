#!/bin/bash
#
# This script keeps nginx correctly configured when running behind Cloudflare.
#
# Cloudflare proxies all incoming requests, so without this configuration
# nginx would see every client as a Cloudflare IP instead of the real visitor.
#
# The script:
#   - Downloads Cloudflare’s current IPv4 and IPv6 ranges
#   - Generates an nginx include file with `set_real_ip_from` entries
#   - Configures nginx to trust the `CF-Connecting-IP` header
#   - Reloads nginx after verifying the configuration
#
# It is intended to be run from cron so Cloudflare IP changes are picked up
# automatically and logs, rate limiting, and access controls continue to
# see real client IP addresses.
#

set -euo pipefail

CLOUDFLARE_FILE_PATH="${1:-/etc/nginx/cloudflare}"
TMP_FILE="$(mktemp)"

# Generate the Cloudflare IP config
{
    echo "# Cloudflare"
    echo ""
    echo "# - IPv4"
    curl -fsSL https://www.cloudflare.com/ips-v4 | while read -r ip; do
        echo "set_real_ip_from $ip;"
    done

    echo ""
    echo "# - IPv6"
    curl -fsSL https://www.cloudflare.com/ips-v6 | while read -r ip; do
        echo "set_real_ip_from $ip;"
    done

    echo ""
    echo "real_ip_header CF-Connecting-IP;"
} > "$TMP_FILE"

# Move into place atomically
mv "$TMP_FILE" "$CLOUDFLARE_FILE_PATH"

# Test configuration and reload nginx
nginx -t && systemctl reload nginx
