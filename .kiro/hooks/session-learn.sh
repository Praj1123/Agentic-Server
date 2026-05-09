#!/bin/bash
# session-learn.sh — Runs when agent finishes responding
# Reads the session log and reminds agent to store learnings

EVENT=$(cat)
CWD=$(echo "$EVENT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd','.'))" 2>/dev/null || echo ".")

LOG_FILE="$CWD/.kiro/learning/session.jsonl"

# Only trigger if there are captured actions this session
if [ -f "$LOG_FILE" ]; then
    LINES=$(wc -l < "$LOG_FILE" 2>/dev/null || echo "0")
    if [ "$LINES" -gt 0 ]; then
        echo "📝 Session has $LINES captured actions. Store key learnings in knowledge base using: knowledge add"
        # Clear session log after reminder
        > "$LOG_FILE"
    fi
fi

exit 0
