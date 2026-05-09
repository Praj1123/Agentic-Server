# Self-Learning Infrastructure Agent

An AI DevOps agent that **learns from your daily work**. Use it on any project — the more you use it, the smarter it gets. Then sell it to the client as a trained engineer.

## The Concept

```
Day 1:   You debug a pod crash → Agent remembers the fix
Day 5:   You set up CI/CD → Agent knows the pipeline
Day 15:  You optimize costs → Agent knows the cost structure
Day 30:  You handle an incident → Agent knows the resolution
...
Day 90:  Agent knows EVERYTHING about this infra
         → Package it → Sell to client
```

## Quick Start

```bash
cd client-infra-agent

# Enable knowledge base
kiro-cli settings chat.enableKnowledge true

# Start working (agent learns from everything you do)
kiro-cli chat --agent migration
```

That's it. Just use it for your daily DevOps work. It absorbs automatically.

## How Auto-Learning Works

```
You ask: "Debug why pods are crashing in cash-invoice namespace"
         │
Agent:   ├── Runs kubectl, checks logs, finds OOM issue
         ├── Fixes it (increases memory limit)
         ├── [postToolUse hook] → Logs the action
         └── [stop hook] → Stores: "cash-invoice pods OOM → fix: increase memory to 1Gi"
         
Next time you ask: "pods crashing again"
Agent:   ├── Searches knowledge base FIRST
         ├── Finds: "Last time this was OOM, fixed by increasing memory"
         └── Gives informed answer immediately
```

## What Gets Captured Automatically

| Your Action | What Agent Learns |
|---|---|
| Debug a bug | Problem → root cause → fix |
| Run terraform | What infra exists, how it's configured |
| Deploy something | Deployment process, environments |
| Check CloudWatch | What metrics matter, normal baselines |
| Handle incident | Symptoms → investigation → resolution |
| Modify security groups | Network rules, access patterns |
| Optimize costs | Cost structure, savings applied |

## Project Structure

```
client-infra-agent/
├── .kiro/
│   ├── agents/
│   │   ├── migration.json        ← YOU use (learns everything)
│   │   └── client-delivery.json  ← CLIENT gets (uses learned knowledge)
│   ├── skills/                   ← Auto-fill from usage
│   ├── hooks/
│   │   ├── auto-capture.sh      ← Logs every meaningful action
│   │   ├── session-learn.sh     ← Reminds agent to store learnings
│   │   └── safety-guard.sh      ← Blocks destructive ops (client mode)
│   └── learning/                 ← Session action logs
├── runbooks/                     ← You write these as you work
├── architecture/                 ← Grows as you document
├── incidents/                    ← Log incidents as they happen
├── web/
│   ├── frontend/index.html       ← Chat UI for client
│   └── backend/server.js         ← API wrapping kiro-cli
└── scripts/
    ├── capture-knowledge.sh      ← Bulk index docs
    └── prepare-handoff.sh        ← Package for client
```

## Daily Workflow

Just use the agent for your normal work:

```bash
kiro-cli chat --agent migration

> debug why the cash-invoice service is returning 500 errors
> deploy the fix to staging
> check if the RDS connections are healthy
> why is the ALB showing unhealthy targets
> set up cloudwatch alarm for this
```

Every interaction builds the knowledge base. After weeks/months of use, the agent knows:
- Every service and how they connect
- Common failure modes and fixes
- Deployment procedures
- Monitoring setup
- Cost structure
- Security configuration

## Deliver to Client

### Option 1: Web Interface
```bash
cd web/backend && npm install && npm start
# Client opens http://localhost:3001
```

### Option 2: CLI
```bash
kiro-cli chat --agent client-delivery
```

### Option 3: Package for handoff
```bash
./scripts/prepare-handoff.sh cash-invoice
```

## The Business

| Phase | What Happens | Revenue |
|---|---|---|
| Migration | You use agent daily, it learns | Project fee |
| KT | Client sees agent working | Included |
| Handoff | Client gets trained agent | $3-8K/month |
| Updates | You add knowledge when they escalate | $200-500/hr |
