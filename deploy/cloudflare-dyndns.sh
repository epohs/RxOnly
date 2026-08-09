#!/bin/bash
#
# Cloudflare Dynamic DNS updater
#
# This script keeps one or more Cloudflare DNS A records updated with the
# current public IPv4 address of this host (typically a home or small network).
#
# It is intended to be run from cron and will:
#   - Detect the current public IPv4 address
#   - Compare it to the last known address
#   - Update the configured Cloudflare DNS records only if the IP has changed
#   - Cache Cloudflare Zone and Record IDs to minimize API calls
#   - Log all activity and failures for troubleshooting
#
# Inspired by:
#   - https://letswp.justifiedgrid.com/cloudflare-as-dynamic-dns-raspberry-pi/
#   - https://gist.github.com/benkulbertis/fff10759c2391b6618dd/
#
# This script assumes a scoped Cloudflare API token with permission to edit
# DNS records for the target zone.
#

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Cloudflare API token (intentionally hardcoded here; protect this file)
auth_key="xxXxXXxXXxXxxXxxxXXxXxxxxXXxXXxxxxxXXXXx"

# Cloudflare zone (apex domain)
zone_name="yourdomain.com"

# DNS records to update
record_names=(
    "rxonly.yourdomain.com"
    # Add more subdomains here if needed
)

# ---------------------------------------------------------------------------
# Paths / state
# ---------------------------------------------------------------------------

my_path="$(cd "$(dirname "$0")" && pwd)"
data_dir="$my_path/data"

mkdir -p "$data_dir"

ip_file="$data_dir/ip.txt"
id_file="$data_dir/cloudflare.ids"
log_file="$data_dir/cloudflare.log"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() {
    [ -n "${1:-}" ] && echo "[$(date)] - $1" >> "$log_file"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

log "Check initiated"

# Current public IPv4 address
ip="$(curl -fsS http://ipv4.icanhazip.com | tr -d '\n')"

if [ -z "$ip" ]; then
    log "Failed to determine public IP"
    exit 1
fi

# Exit early if IP has not changed
if [ -f "$ip_file" ]; then
    old_ip="$(cat "$ip_file")"
    if [ "$ip" = "$old_ip" ]; then
        log "IP has not changed ($ip)"
        exit 0
    fi
fi

# Expected ID cache format: 1 zone ID + 1 per record
expected_lines=$((1 + ${#record_names[@]}))

if [ -f "$id_file" ] && [ "$(wc -l < "$id_file")" -eq "$expected_lines" ]; then
    zone_identifier="$(sed -n '1p' "$id_file")"
else
    zone_identifier="$(
        curl -fsS -X GET "https://api.cloudflare.com/client/v4/zones?name=$zone_name" \
            -H "Authorization: Bearer $auth_key" \
            -H "Content-Type: application/json" |
        grep -Po '(?<="id":")[^"]*' | head -1
    )"

    if [ -z "$zone_identifier" ]; then
        log "Failed to retrieve zone identifier"
        exit 1
    fi

    echo "$zone_identifier" > "$id_file"

    for record_name in "${record_names[@]}"; do
        record_identifier="$(
            curl -fsS -X GET "https://api.cloudflare.com/client/v4/zones/$zone_identifier/dns_records?name=$record_name" \
                -H "Authorization: Bearer $auth_key" \
                -H "Content-Type: application/json" |
            grep -Po '(?<="id":")[^"]*'
        )"

        if [ -z "$record_identifier" ]; then
            log "Failed to retrieve record ID for $record_name"
            exit 1
        fi

        echo "$record_identifier" >> "$id_file"
    done
fi

# Update each DNS record
failed=0
line=2

for record_name in "${record_names[@]}"; do
    record_identifier="$(sed -n "${line}p" "$id_file")"

    update="$(
        curl -fsS -X PUT "https://api.cloudflare.com/client/v4/zones/$zone_identifier/dns_records/$record_identifier" \
            -H "Authorization: Bearer $auth_key" \
            -H "Content-Type: application/json" \
            --data "{\"type\":\"A\",\"name\":\"$record_name\",\"content\":\"$ip\"}"
    )"

    if [[ "$update" == *"\"success\":false"* ]]; then
        log "FAILED to update $record_name: $update"
        failed=1
    else
        log "Updated $record_name to $ip"
    fi

    ((line++))
done

if [ "$failed" -eq 1 ]; then
    echo "Some updates failed. Check $log_file"
    exit 1
fi

echo "$ip" > "$ip_file"
echo "IP changed to: $ip"
