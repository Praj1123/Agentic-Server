#!/bin/bash
# auto-capture.sh — Runs after every tool use, logs meaningful interactions
# The agent will use these logs to build knowledge over time

EVENT=$(cat)
HOOK_EVENT=$(echo "$EVENT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    tool = data.get('tool_name', '')
    tool_input = json.dumps(data.get('tool_input', {}))
    tool_response = data.get('tool_response', {})
    success = tool_response.get('success', False)
    
    # Skip trivial operations
    skip_tools = ['fs_read', 'grep', 'glob', 'code']
    if tool in skip_tools:
        sys.exit(0)
    
    # Skip knowledge tool itself (avoid recursion)
    if tool == 'knowledge':
        sys.exit(0)
    
    # Log meaningful operations
    timestamp = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
    log_entry = {
        'timestamp': timestamp,
        'tool': tool,
        'input_summary': tool_input[:500],
        'success': success
    }
    
    # Write to session log
    import os
    log_dir = os.path.join(data.get('cwd', '.'), '.kiro', 'learning')
    os.makedirs(log_dir, exist_ok=True)
    
    log_file = os.path.join(log_dir, 'session.jsonl')
    with open(log_file, 'a') as f:
        f.write(json.dumps(log_entry) + '\n')
    
    # Print summary for agent context
    print(f'[CAPTURED] {tool} — logged for learning')
except Exception as e:
    pass
" 2>/dev/null)

[ -n "$HOOK_EVENT" ] && echo "$HOOK_EVENT"
exit 0
