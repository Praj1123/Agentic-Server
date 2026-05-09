#!/bin/bash
# Safety guard hook — blocks destructive AWS operations for client-delivery agent
# Exit 0 = allow, Exit 2 = block

EVENT=$(cat)
TOOL_INPUT=$(echo "$EVENT" | grep -o '"tool_input".*' 2>/dev/null)

# Extract operation from the event
OPERATION=$(echo "$EVENT" | grep -oP '"operation_name"\s*:\s*"\K[^"]+' 2>/dev/null)

# List of blocked destructive operations
BLOCKED_OPS=(
  "delete" "terminate" "remove" "destroy"
  "put" "create" "update" "modify" "attach" "detach"
  "stop" "start" "reboot"
  "deregister" "disassociate" "revoke"
)

for blocked in "${BLOCKED_OPS[@]}"; do
  if echo "$OPERATION" | grep -qi "$blocked"; then
    echo "⛔ BLOCKED: Operation '$OPERATION' is destructive. This agent is read-only." >&2
    echo "If you need to make this change, contact your infrastructure team." >&2
    exit 2
  fi
done

# Allow read-only operations (describe, list, get)
exit 0
