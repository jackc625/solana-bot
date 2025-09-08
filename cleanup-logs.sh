#!/bin/bash

# Log cleanup script for Solana bot
# Run this periodically to prevent logs from growing too large

echo "🧹 Starting log cleanup..."

# Backup current logs
mkdir -p data/backups
timestamp=$(date +"%Y%m%d_%H%M%S")

# Backup and truncate debug.log if it's too large
if [ -f "data/debug.log" ]; then
    size=$(wc -c < "data/debug.log")
    if [ $size -gt 10485760 ]; then  # 10MB
        echo "📋 Debug log is ${size} bytes, rotating..."
        cp "data/debug.log" "data/backups/debug_${timestamp}.log"
        tail -1000 "data/debug.log" > "data/debug.log.tmp"
        mv "data/debug.log.tmp" "data/debug.log"
        echo "✅ Debug log rotated, kept last 1000 lines"
    fi
fi

# Backup and truncate error.log if it's too large
if [ -f "data/errors.log" ]; then
    size=$(wc -c < "data/errors.log")
    if [ $size -gt 50485760 ]; then  # 50MB
        echo "📋 Error log is ${size} bytes, rotating..."
        cp "data/errors.log" "data/backups/errors_${timestamp}.log"
        tail -5000 "data/errors.log" > "data/errors.log.tmp"
        mv "data/errors.log.tmp" "data/errors.log"
        echo "✅ Error log rotated, kept last 5000 lines"
    fi
fi

# Clean up old backups (keep only last 7 days)
find data/backups -name "*.log" -mtime +7 -delete 2>/dev/null || true

echo "🎉 Log cleanup completed"