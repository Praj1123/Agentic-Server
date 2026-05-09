# Scaling Runbook

## When to Scale
- CPU > 80% sustained for 5 minutes
- Memory > 85%
- Response time > 2s (p95)
- Pod pending due to insufficient resources

## EKS Horizontal Pod Autoscaler
```bash
# Check current HPA status
kubectl get hpa -n production

# Manual scale (if HPA not responding fast enough)
kubectl scale deployment <DEPLOYMENT> --replicas=<COUNT> -n production
```

## EKS Node Group Scaling
```bash
# Check current nodes
kubectl get nodes

# Scale via AWS CLI (update desired capacity)
aws eks update-nodegroup-config \
  --cluster-name <CLUSTER> \
  --nodegroup-name <NODEGROUP> \
  --scaling-config desiredSize=<COUNT>
```

## RDS Read Replicas
```bash
# Check current replicas
aws rds describe-db-instances --query 'DBInstances[?ReadReplicaSourceDBInstanceIdentifier!=`null`]'

# Create read replica (if needed)
aws rds create-db-instance-read-replica \
  --db-instance-identifier <REPLICA-NAME> \
  --source-db-instance-identifier <PRIMARY>
```

## Rollback
If scaling causes issues:
1. Revert to previous replica count
2. Check application logs for errors
3. Verify database connections aren't exhausted
