cat <<EOF > lessons.json
{
  "lessons": [
    {
      "id": 0,
      "rule": "System initialized with clean slate",
      "tags": ["system"],acat <<'EOF' > reset_bot.sh
#!/bin/bash

echo "🔄 Resetting bot data and logs..."

# 1. Reset lessons.json to clean state
cat <<INNER_EOF > lessons.json
{
  "lessons": [
    {
      "id": 0,
      "rule": "System initialized with clean slate",
      "tags": ["system"],
      "outcome": "neutral",
      "context": "Initial setup",
      "pnl_pct": 0,
      "range_efficiency": 0,
      "pool": "0x0000000000000000000000000000000000000000",
      "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    }
  ],
  "performance": []
}
INNER_EOF

# 2. Delete pool memory (persistent cooldowns/history)
if [ -f pool-memory.json ]; then
    rm pool-memory.json
    echo "🗑️  pool-memory.json deleted."
else
    echo "ℹ️  pool-memory.json not found, skipping delete."
fi

# 3. PM2 Maintenance
echo "🧹 Flushing PM2 logs..."
pm2 flush all

echo "🚀 Restarting meridian..."
pm2 restart meridian

echo "📝 Opening logs..."
pm2 logs meridian
EOF
      "outcome": "neutral",
      "context": "Initial setup",
      "pnl_pct": 0,
      "range_efficiency": 0,
      "pool": "0x0000000000000000000000000000000000000000",
      "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    }
  ],
  "performance": []
}
EOF
rm pool-memory.json
./reset_bot.sh
