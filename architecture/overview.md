# Architecture Overview

## High-Level Diagram
```
Internet
    │
    ▼
┌─────────────┐
│ CloudFront  │ ← CDN + WAF
└──────┬──────┘
       │
┌──────▼──────┐
│     ALB     │ ← Application Load Balancer
└──────┬──────┘
       │
┌──────▼──────────────────────────┐
│          EKS Cluster            │
│  ┌─────────┐  ┌─────────┐      │
│  │ App Pods│  │ API Pods│      │
│  └────┬────┘  └────┬────┘      │
└───────┼─────────────┼───────────┘
        │             │
   ┌────▼────┐   ┌───▼────┐
   │ElastiCache│  │  RDS   │
   │ (Redis)  │  │(Postgres)│
   └──────────┘  └─────────┘
```

## Accounts Structure
<!-- FILL DURING MIGRATION -->
| Account | ID | Purpose |
|---------|-----|---------|
| Production | | Live workloads |
| Staging | | Pre-prod testing |
| Dev | | Development |
| Shared Services | | CI/CD, monitoring |

## Key Design Decisions
<!-- Document WHY things were built this way -->
See `/architecture/decisions/` for ADRs.

## Data Flow
1. User request → CloudFront → ALB → EKS pod
2. Pod → ElastiCache (session/cache) or RDS (persistent data)
3. Async jobs → EventBridge → Lambda/SQS → Worker pods

## Disaster Recovery
- **RPO**: 
- **RTO**: 
- **DR Region**: 
- **Strategy**: (pilot light / warm standby / active-active)
