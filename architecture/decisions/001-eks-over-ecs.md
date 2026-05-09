# ADR-001: EKS over ECS for Container Orchestration

## Status
Accepted

## Context
<!-- FILL: Why was this decision made? -->
Client needed container orchestration for microservices. Options were EKS, ECS, and self-managed K8s.

## Decision
Chose EKS because:
- Team has Kubernetes experience from previous cloud
- Need for custom operators and CRDs
- Multi-cloud portability requirement
- Rich ecosystem (Helm, ArgoCD, etc.)

## Consequences
- Higher operational complexity than ECS
- Need to manage node groups and upgrades
- More flexibility for future requirements
