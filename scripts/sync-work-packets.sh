cat > scripts/sync-work-packets.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# 기본: ../spec-agent/work-packets → ./work-packets
SRC="${1:-../spec-agent/work-packets}"
DST="${2:-./work-packets}"

mkdir -p "$DST"
rsync -av --delete "$SRC"/ "$DST"/

echo "Synced work-packets:"
ls -la "$DST" | sed -n '1,80p'
EOF

chmod +x scripts/sync-work-packets.sh