# Incident Response Runbook

## Severity Levels
| Level | Definition | Response Time | Escalation |
|-------|-----------|---------------|------------|
| SEV1 | Production down | Immediate | Page on-call + manager |
| SEV2 | Degraded performance | 15 min | Notify on-call |
| SEV3 | Non-critical issue | 1 hour | Ticket |

## First Response Steps
1. **Acknowledge** the alert
2. **Assess** impact: How many users affected? Which services?
3. **Communicate** in incident channel
4. **Investigate** using steps below

## Investigation Checklist
```bash
# Check recent deployments
kubectl rollout history deployment -n production

# Check pod health
kubectl get pods -n production | grep -v Running

# Check application logs
kubectl logs -l app=<SERVICE> -n production --tail=100

# Check CloudWatch for anomalies
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApplicationELB \
  --metric-name HTTPCode_Target_5XX_Count \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 --statistics Sum

# Check RDS
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name CPUUtilization \
  --dimensions Name=DBInstanceIdentifier,Value=<DB_INSTANCE> \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 --statistics Average
```

## Common Root Causes
1. **Bad deployment** → Rollback: `kubectl rollout undo deployment/<NAME> -n production`
2. **Database overload** → Check slow queries, kill long-running queries
3. **Memory leak** → Restart pods: `kubectl rollout restart deployment/<NAME> -n production`
4. **External dependency down** → Check third-party status pages
5. **Traffic spike** → Scale up (see scaling runbook)

## Post-Incident
1. Create incident doc in `/incidents/`
2. Document timeline, root cause, resolution
3. Identify action items to prevent recurrence
