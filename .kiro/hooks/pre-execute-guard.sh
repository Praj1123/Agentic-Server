#!/bin/bash
# pre-execute-guard.sh — Shows risk info before execution. Exit 0 = allow, Exit 2 = block.

EVENT=$(cat)

python3 -c "
import sys, json, re

data = json.load(sys.stdin)
tool = data.get('tool_name', '')
tool_input = data.get('tool_input', {})

if tool in ('execute_bash', 'shell'):
    cmd = tool_input.get('command', '')
    cwd = tool_input.get('working_dir', data.get('cwd', '.'))
    
    destructive = ['rm ', 'delete', 'destroy', 'drop ', 'kill ', 'pkill', 'terraform destroy',
                   'kubectl delete', 'docker rm', 'docker stop', 'systemctl stop',
                   'helm uninstall']
    modify = ['terraform apply', 'kubectl apply', 'kubectl scale', 'kubectl rollout',
              'docker run', 'helm install', 'helm upgrade', 'systemctl restart',
              'apt install', 'yum install', 'pip install', 'npm install',
              'chmod', 'chown', 'mv ', 'cp ']
    
    risk = 'LOW'
    for pattern in destructive:
        if re.search(pattern, cmd):
            risk = 'HIGH'
            break
    if risk == 'LOW':
        for pattern in modify:
            if re.search(pattern, cmd):
                risk = 'MEDIUM'
                break
    
    if risk == 'LOW':
        sys.exit(0)
    
    icon = '🔴' if risk == 'HIGH' else '🟡'
    # Print to STDOUT (added to context, does NOT block)
    print(f'{icon} [{risk} RISK] Command: {cmd}')
    if risk == 'HIGH':
        print(f'⚠️ DESTRUCTIVE operation — will delete/terminate resources')
    else:
        print(f'ℹ️ Will modify infrastructure')
    sys.exit(0)

elif tool == 'use_aws':
    service = tool_input.get('service_name', '')
    operation = tool_input.get('operation_name', '')
    region = tool_input.get('region', '')
    
    read_prefixes = ('describe', 'list', 'get', 'head', 'lookup', 'search', 'check')
    if operation.startswith(read_prefixes):
        sys.exit(0)
    
    destructive_prefixes = ('delete', 'terminate', 'remove', 'deregister', 'revoke')
    if operation.startswith(destructive_prefixes):
        risk = 'HIGH'
        icon = '🔴'
    else:
        risk = 'MEDIUM'
        icon = '🟡'
    
    # Print to STDOUT (added to context, does NOT block)
    print(f'{icon} [{risk} RISK] AWS: {service} → {operation} ({region})')
    if risk == 'HIGH':
        print(f'⚠️ DESTRUCTIVE — will permanently delete/terminate resources')
    else:
        print(f'ℹ️ Will create/modify AWS resources')
    sys.exit(0)

else:
    sys.exit(0)
" <<< "$EVENT"

exit 0
