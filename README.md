# Vira

**Your infrastructure, explained.** Vira is a project-specific AI agent that learns your AWS infrastructure during migration and becomes a knowledgeable assistant for your team post-handover.

---

## What It Does

- **During migration** — You use Vira as your working tool. Every action, decision, and resource detail is automatically captured into a knowledge base.
- **Post-handover** — The client gets the same agent, already trained on *their* specific infrastructure. They ask questions in plain English and get accurate, context-aware answers.

No more forgotten KT sessions. No more stale documentation. Vira is a living, queryable handover document.

---

## Features

| Feature | Description |
|---------|-------------|
| Multi-project | Each client/project gets its own agent, knowledge base, and AWS credentials |
| Auto-learning KB | Automatically captures infrastructure actions and categorizes them |
| Role-based access | Admin (full control) vs User (read-heavy, write needs approval) |
| OTP authentication | Email-based OTP for all users when SMTP is configured |
| AWS credential isolation | Per-project encrypted credential storage (IAM keys, SSO, profiles) |
| Smart context | Relevance-scored KB search with recency bias |
| Typing indicator | Real-time status showing what Vira is doing |
| Admin dashboard | Manage projects, users, usage stats, and settings |
| Email notifications | Welcome emails, OTP, project assignment notifications |

---

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌───────────┐
│   Browser    │────▶│  Express Server   │────▶│  kiro-cli │
│  (Frontend)  │◀────│  (Node.js)        │◀────│  (AI)     │
└──────────────┘     └──────────────────┘     └───────────┘
                              │                       │
                     ┌────────┴────────┐              │
                     │    SQLite DB    │        ┌─────┴─────┐
                     │ users/sessions  │        │  AWS APIs  │
                     └─────────────────┘        └───────────┘
```

**Stack:**
- Backend: Node.js + Express
- Database: SQLite (via better-sqlite3)
- AI Engine: kiro-cli
- Frontend: Vanilla HTML/CSS/JS
- Auth: PBKDF2 + session tokens + email OTP

---

## Quick Start

### Prerequisites

- Node.js 18+
- [kiro-cli](https://kiro.dev) installed and authenticated (`kiro-cli login`)
- AWS CLI (optional, for credential verification)

### Setup

```bash
git clone <your-repo-url>
cd Agentic-Server/web/backend

# Install dependencies
npm install

# Generate encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Configure environment
cp .env.example .env
# Edit .env — add ENCRYPTION_KEY and SMTP credentials
```

### Run

```bash
npm start
# Open http://localhost:3002
```

First user to sign up becomes the admin.

---

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3002) |
| `ENCRYPTION_KEY` | Yes | 64-char hex string for encrypting AWS credentials |
| `SMTP_HOST` | No | SMTP server (default: smtp.gmail.com) |
| `SMTP_PORT` | No | SMTP port (default: 587) |
| `SMTP_USER` | No | SMTP email (enables OTP + email notifications) |
| `SMTP_PASS` | No | SMTP password or app password |
| `SMTP_FROM` | No | From address for emails |
| `APP_URL` | No | Public URL for email links (default: http://localhost:3002) |
| `SESSION_TTL_HOURS` | No | Session duration in hours (default: 24) |
| `PROJECTS_DIR` | No | Custom projects directory |

---

## Project Structure

```
Agentic-Server/
├── .github/workflows/deploy.yml    # Auto-deploy via SSH
├── .gitignore
├── README.md
└── web/
    ├── backend/
    │   ├── server.js               # Express API server
    │   ├── package.json
    │   ├── .env                    # Local config (not committed)
    │   └── .env.example            # Config template
    └── frontend/
        ├── index.html              # Chat UI
        └── admin.html              # Admin dashboard
```

---

## API Reference

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/signup` | First admin registration |
| POST | `/api/login` | Login (returns token) |
| POST | `/api/logout` | Invalidate session |
| POST | `/api/change-password` | Change own password |
| POST | `/api/reset-password` | Admin resets user password |

### Projects

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List projects (filtered by role) |
| POST | `/api/projects` | Create project (admin only) |
| DELETE | `/api/projects/:name` | Delete project (admin only) |

### Chat

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat` | Send message, get response |
| GET | `/api/progress/:key` | Poll typing indicator status |
| GET | `/api/history/:project` | Get chat history |
| POST | `/api/reset` | Clear chat history |

### Knowledge Base

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/knowledge/:project` | Get KB content |
| GET | `/api/knowledge/:project/export` | Download KB as markdown |

### AWS Credentials

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/credentials` | Save AWS credentials (IAM/SSO/profile) |
| GET | `/api/credentials/:project` | Check credential status |
| DELETE | `/api/credentials/:project/disconnect` | Remove credentials |

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/me` | Current user info |
| GET | `/api/admin/users` | List all users |
| POST | `/api/admin/users` | Create user |
| DELETE | `/api/admin/users/:email` | Delete user |
| POST | `/api/admin/users/:email/projects` | Assign project to user |
| DELETE | `/api/admin/users/:email/projects/:project` | Unassign project |
| GET | `/api/usage/:project` | Usage stats |

---

## Roles & Permissions

| | Admin | User |
|---|---|---|
| Create/delete projects | ✅ | ❌ |
| Manage users | ✅ | ❌ |
| Chat with all projects | ✅ | Only assigned projects |
| AWS write actions | ✅ Unrestricted | Requires approval in chat |
| Tool access | All tools | Read tools + use_aws |
| Admin dashboard | ✅ | ❌ |

---

## Deployment

### Automated (GitHub Actions)

Push to `main` → auto-deploys to your server via SSH.

Required GitHub secrets:
- `SERVER_HOST` — server IP/hostname
- `SERVER_USER` — SSH username
- `SSH_KEY` — private key

### Manual

```bash
# On your server
git clone <repo> /opt/vira
cd /opt/vira/web/backend
npm install --omit=dev
cp .env.example .env
# Edit .env with production values

# Run with systemd
sudo tee /etc/systemd/system/vira.service > /dev/null << 'EOF'
[Unit]
Description=Vira
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/vira/web/backend
ExecStart=/usr/bin/node server.js
Restart=always
EnvironmentFile=/opt/vira/web/backend/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now vira
```

### HTTPS (recommended)

Use Caddy as a reverse proxy:

```
vira.yourdomain.com {
    reverse_proxy localhost:3002
}
```

---

## Security

- Passwords hashed with PBKDF2 (10k iterations, SHA-512, random salt)
- Session tokens: 384-bit random, stored in SQLite with TTL
- AWS credentials encrypted at rest (AES-256-CBC, random IV)
- Encryption key: auto-generated or set via environment variable
- Input sanitization on all user inputs
- Helmet.js security headers
- Rate limiting: 30 requests/minute per user
- Role-based tool restriction for kiro-cli

---

## Client Onboarding Guide

1. **Create project** in admin panel
2. **Connect AWS credentials** (recommend read-only IAM role for clients)
3. **Use Vira** during migration — it auto-learns
4. **Create user account** for client team
5. **Assign project** to user — they receive email with access details
6. **Client logs in** and starts asking questions about their infrastructure

---

## Recommended IAM Policy for Client Users

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:Describe*",
        "rds:Describe*",
        "s3:List*",
        "s3:GetBucket*",
        "elasticloadbalancing:Describe*",
        "cloudfront:List*",
        "cloudfront:Get*",
        "route53:List*",
        "route53:Get*",
        "lambda:List*",
        "lambda:Get*",
        "ecs:Describe*",
        "ecs:List*",
        "iam:List*",
        "iam:Get*",
        "cloudwatch:GetMetricData",
        "cloudwatch:DescribeAlarms",
        "ce:GetCostAndUsage",
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

---

## License

Proprietary. All rights reserved.
