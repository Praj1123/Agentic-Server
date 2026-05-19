const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const helmet = require('helmet');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const pino = require('pino');

// Load .env
require('dotenv').config({ path: path.join(__dirname, '.env') });

// --- Logger ---
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty', options: { colorize: true } } : undefined
});

// --- Config ---
const PORT = process.env.PORT || 3002;
const SESSION_TTL = (parseInt(process.env.SESSION_TTL_HOURS) || 24) * 60 * 60 * 1000;
const RATE_LIMIT = 30;
const RATE_WINDOW = 60000;
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(
  process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'infra-agent')
    : path.join(os.homedir(), '.infra-agent'),
  'projects'
);
const DATA_DIR = path.dirname(PROJECTS_DIR);
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// --- Encryption Key (point 4: must be set in env, not derived from hostname) ---
let ENCRYPTION_KEY;
if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length >= 32) {
  ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
} else {
  const keyFile = path.join(DATA_DIR, '.encryption-key');
  if (fs.existsSync(keyFile)) {
    ENCRYPTION_KEY = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  } else {
    ENCRYPTION_KEY = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, ENCRYPTION_KEY.toString('hex'), { mode: 0o600 });
    logger.info('Generated new encryption key at %s', keyFile);
  }
}

// --- SQLite Database (point 8) ---
const db = new Database(path.join(DATA_DIR, 'infra-agent.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    projects TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    user_email TEXT NOT NULL,
    date TEXT NOT NULL DEFAULT (date('now')),
    UNIQUE(project, user_email, date) ON CONFLICT IGNORE
  );
  CREATE TABLE IF NOT EXISTS usage_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    user_email TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrate existing JSON data if present
function migrateJsonData() {
  const usersFile = path.join(DATA_DIR, 'users.json');
  if (fs.existsSync(usersFile)) {
    try {
      const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
      const insert = db.prepare('INSERT OR IGNORE INTO users (email, name, password_hash, salt, role, projects, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const [email, u] of Object.entries(users)) {
        insert.run(email, u.name || email.split('@')[0], u.password || u.hash, u.salt, u.role || 'user', JSON.stringify(u.projects || []), u.createdAt || new Date().toISOString());
      }
      fs.renameSync(usersFile, usersFile + '.migrated');
      logger.info('Migrated users.json to SQLite');
    } catch (e) { logger.error(e, 'Failed to migrate users.json'); }
  }
}
migrateJsonData();

// --- Encryption helpers ---
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(data) {
  const [ivHex, encrypted] = data.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ivHex, 'hex'), ENCRYPTION_KEY);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// --- Auth helpers ---
function hashPw(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPw(password, hash, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex') === hash;
}

// --- Input Sanitization (point 5) ---
function sanitizeProjectName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 64);
}

function sanitizeMessage(msg) {
  if (typeof msg !== 'string') return '';
  // Strip null bytes and limit length
  return msg.replace(/\0/g, '').slice(0, 10000);
}

// --- Session management (point 3) ---
function createSession(email, name, role) {
  const token = crypto.randomBytes(48).toString('hex');
  db.prepare('INSERT INTO sessions (token, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)').run(token, email, name, role, Date.now());
  return token;
}

function getSession(token) {
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (Date.now() - row.created_at > SESSION_TTL) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Cleanup expired sessions every hour
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL;
  const result = db.prepare('DELETE FROM sessions WHERE created_at < ?').run(cutoff);
  if (result.changes > 0) logger.info('Cleaned %d expired sessions', result.changes);
}, 60 * 60 * 1000);


// --- Express App (point 2: helmet + security headers) ---
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({ method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - start, user: req.user?.email }, 'request');
  });
  next();
});

// --- Rate Limiting ---
const rateLimits = {};
function checkRateLimit(user) {
  const now = Date.now();
  if (!rateLimits[user]) rateLimits[user] = [];
  rateLimits[user] = rateLimits[user].filter(t => now - t < RATE_WINDOW);
  if (rateLimits[user].length >= RATE_LIMIT) return false;
  rateLimits[user].push(now);
  return true;
}

// --- Auth Middleware ---
function authMiddleware(req, res, next) {
  if (['/api/login', '/api/signup'].includes(req.path) || !req.path.startsWith('/api/')) return next();
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'Session expired. Please login again.' });
  req.user = session;
  next();
}

// --- Auth Routes ---
const otpStore = {};

app.post('/api/signup', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.json({ success: false, error: 'Email and password required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ success: false, error: 'Invalid email' });
  if (password.length < 8) return res.json({ success: false, error: 'Password must be at least 8 characters' });

  const existingUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (existingUsers.count > 0) return res.json({ success: false, error: 'Contact your admin to get an account.' });

  const { hash, salt } = hashPw(password);
  db.prepare('INSERT INTO users (email, name, password_hash, salt, role) VALUES (?, ?, ?, ?, ?)').run(email, name || email.split('@')[0], hash, salt, 'admin');

  const token = createSession(email, name || email.split('@')[0], 'admin');
  logger.info({ email }, 'First admin signup');
  res.json({ success: true, token, name: name || email.split('@')[0], role: 'admin' });
});

app.post('/api/login', (req, res) => {
  const { email, password, otp } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.json({ success: false, error: 'Email not found. Contact admin.' });
  if (!verifyPw(password || '', user.password_hash, user.salt)) return res.json({ success: false, error: 'Incorrect password' });

  if (process.env.SMTP_USER) {
    if (!otp) {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      otpStore[email] = { code, expiresAt: Date.now() + 5 * 60 * 1000 };
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: parseInt(process.env.SMTP_PORT || '587'), secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
      transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER, to: email,
        subject: 'Vira — Login OTP',
        html: `<h2>Your login code</h2><p style="font-size:32px;font-weight:bold;color:#6366f1;letter-spacing:4px">${code}</p><p>Expires in 5 minutes.</p>`
      }).catch(err => logger.error(err, 'OTP email failed'));
      return res.json({ success: false, otpSent: true, error: 'OTP sent to your email. Enter it to continue.' });
    }
    const stored = otpStore[email];
    if (!stored || stored.code !== otp || Date.now() > stored.expiresAt) {
      return res.json({ success: false, error: 'Invalid or expired OTP' });
    }
    delete otpStore[email];
  }

  const token = createSession(email, user.name, user.role);
  logger.info({ email, role: user.role }, 'Login');
  res.json({ success: true, token, name: user.name, role: user.role });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['authorization'];
  if (token) deleteSession(token);
  res.json({ success: true });
});

app.use(authMiddleware);

// --- Password Change (point 9) ---
app.post('/api/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.json({ success: false, error: 'Both passwords required' });
  if (newPassword.length < 8) return res.json({ success: false, error: 'New password must be at least 8 characters' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(req.user.email);
  if (!verifyPw(currentPassword, user.password_hash, user.salt)) return res.json({ success: false, error: 'Current password incorrect' });

  const { hash, salt } = hashPw(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE email = ?').run(hash, salt, req.user.email);
  // Invalidate all other sessions for this user
  db.prepare('DELETE FROM sessions WHERE email = ? AND token != ?').run(req.user.email, req.headers['authorization']);
  logger.info({ email: req.user.email }, 'Password changed');
  res.json({ success: true });
});

app.post('/api/reset-password', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { email, newPassword } = req.body;
  if (!email || !newPassword) return res.json({ success: false, error: 'Email and new password required' });
  if (newPassword.length < 8) return res.json({ success: false, error: 'Password must be at least 8 characters' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.json({ success: false, error: 'User not found' });

  const { hash, salt } = hashPw(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE email = ?').run(hash, salt, email);
  db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
  logger.info({ admin: req.user.email, target: email }, 'Password reset by admin');
  res.json({ success: true });
});


// --- Per-project state ---
const projectState = {};

function getState(project) {
  if (!projectState[project]) {
    projectState[project] = { history: [], awsEnv: {} };
    const historyFile = path.join(PROJECTS_DIR, project, 'chat-history.json');
    if (fs.existsSync(historyFile)) { try { projectState[project].history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch {} }
    const credFile = path.join(PROJECTS_DIR, project, '.aws-env.json');
    if (fs.existsSync(credFile)) {
      try {
        const raw = fs.readFileSync(credFile, 'utf8');
        projectState[project].awsEnv = JSON.parse(raw.includes(':') ? decrypt(raw) : raw);
      } catch {}
    }
  }
  return projectState[project];
}

function saveHistory(project) {
  const state = projectState[project];
  if (!state) return;
  const historyFile = path.join(PROJECTS_DIR, project, 'chat-history.json');
  try { fs.writeFileSync(historyFile, JSON.stringify(state.history, null, 2)); } catch {}
}

function saveAwsEnv(project, env) {
  const credFile = path.join(PROJECTS_DIR, project, '.aws-env.json');
  try { fs.writeFileSync(credFile, encrypt(JSON.stringify(env))); } catch {}
}

// Serve frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// --- Projects API ---
app.get('/api/projects', (req, res) => {
  const projects = [];
  if (fs.existsSync(PROJECTS_DIR)) {
    fs.readdirSync(PROJECTS_DIR).forEach(name => {
      const dir = path.join(PROJECTS_DIR, name);
      if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, '.kiro', 'agents', `${name}.json`))) {
        projects.push({ name });
      }
    });
  }
  if (req.user.role === 'admin') return res.json({ projects });
  const user = db.prepare('SELECT projects FROM users WHERE email = ?').get(req.user.email);
  const userProjects = JSON.parse(user?.projects || '[]');
  res.json({ projects: projects.filter(p => userProjects.includes(p.name)) });
});

app.post('/api/projects', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Only admin can create projects' });
  const { name, region, description } = req.body;
  if (!name) return res.json({ success: false, error: 'Name required' });
  const safeName = sanitizeProjectName(name);
  if (!safeName) return res.json({ success: false, error: 'Name required (letters, numbers, hyphens, spaces allowed)' });
  const projectDir = path.join(PROJECTS_DIR, safeName);
  if (fs.existsSync(projectDir)) return res.json({ success: false, error: 'Project already exists' });

  fs.mkdirSync(path.join(projectDir, '.kiro', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'prompts'), { recursive: true });

  const agentConfig = {
    name: safeName, description: description || `Agent for ${safeName}`,
    prompt: 'file://../../prompts/system-prompt.md',
    tools: ["fs_read", "fs_write", "execute_bash", "use_aws", "grep", "glob", "knowledge"],
    allowedTools: ["fs_read", "grep", "glob", "knowledge"],
    resources: ["file://runbooks/**/*.md", "file://architecture/**/*.md"],
    welcomeMessage: `Agent for ${safeName} ready.`
  };
  fs.writeFileSync(path.join(projectDir, '.kiro', 'agents', `${safeName}.json`), JSON.stringify(agentConfig, null, 2));

  const prompt = `# ${safeName} — Infrastructure Agent\n\nYou are the infrastructure expert for the "${safeName}" project on AWS (region: ${region || 'us-east-1'}).\n\n## WHO YOU ARE:\n- You migrated this workload to AWS and know every detail about it\n- You are the team's go-to person for understanding, debugging, and managing this infrastructure\n- You have full AWS expertise but explain things in SIMPLE terms\n\n## HOW TO ANSWER:\n- ALWAYS check the knowledge base first for project-specific details\n- When explaining AWS concepts, use analogies and plain language\n- If you don't have project-specific info in the knowledge base, say so and offer to look it up via AWS\n\n## RULES:\n1. Check knowledge base FIRST before making any AWS API calls\n2. Show plan → ask approval → execute on "yes"\n3. When user says "yes" — execute immediately, no re-confirmation\n4. NEVER say "run it yourself" — you execute everything\n5. After completing tasks, store a detailed summary in knowledge base\n6. Present data in TABLES, not bullet lists\n\n## DEFAULTS:\n- Region: ${region || 'us-east-1'}\n- If use_aws fails, fall back to execute_bash with AWS CLI\n`;
  fs.writeFileSync(path.join(projectDir, 'prompts', 'system-prompt.md'), prompt);
  logger.info({ project: safeName, admin: req.user.email }, 'Project created');
  res.json({ success: true });
});

app.delete('/api/projects/:name', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Only admin can delete projects' });
  const safeName = sanitizeProjectName(req.params.name);
  const projectDir = path.join(PROJECTS_DIR, safeName);
  if (!fs.existsSync(projectDir)) return res.json({ success: false, error: 'Not found' });
  fs.rmSync(projectDir, { recursive: true, force: true });
  delete projectState[safeName];
  logger.info({ project: safeName, admin: req.user.email }, 'Project deleted');
  res.json({ success: true });
});

// --- Chat API (points 5 & 6: sanitization + role-based tool restriction) ---
app.post('/api/chat', (req, res) => {
  const { message, project } = req.body;
  if (!message || !project) return res.status(400).json({ error: 'message and project required' });
  const safeProject = sanitizeProjectName(project);
  const safeMessage = sanitizeMessage(message);
  if (!safeProject || !safeMessage) return res.status(400).json({ error: 'Invalid input' });
  if (!checkRateLimit(req.user.email)) return res.status(429).json({ error: 'Rate limit exceeded. Max 30 requests/minute.' });

  // Track usage in SQLite
  db.prepare('INSERT INTO usage_queries (project, user_email) VALUES (?, ?)').run(safeProject, req.user.email);
  db.prepare('INSERT OR IGNORE INTO usage (project, user_email) VALUES (?, ?)').run(safeProject, req.user.email);

  const state = getState(safeProject);
  state.history.push({ role: 'user', content: safeMessage });

  let fullPrompt = '';

  // Role-based access control in prompt
  if (req.user.role !== 'admin') {
    fullPrompt += `USER ROLE: Client Team Member (restricted)\n\nACCESS RULES:\n- READ-ONLY actions ALLOWED freely: describe, list, get, check status, view logs\n- WRITE/MODIFY actions REQUIRE APPROVAL: create, delete, modify, update, restart, stop, terminate\n- For any write action: show plan first, only execute on explicit approval\n\n`;
  }

  const kbFile = path.join(PROJECTS_DIR, safeProject, 'knowledge_base.txt');
  if (fs.existsSync(kbFile)) {
    const kb = fs.readFileSync(kbFile, 'utf8').trim();
    if (kb) {
      const entries = kb.split(/^---\s*\[/m).filter(e => e.trim());
      const queryLower = safeMessage.toLowerCase();
      const keywords = queryLower.split(/\s+/).filter(w => w.length > 2 && !['the','and','for','what','how','can','you','this','that','with','from','are','was','have','does','will'].includes(w));

      // Score each entry by relevance
      const scored = entries.map(entry => {
        const lower = entry.toLowerCase();
        let score = 0;

        // Exact phrase match (highest value)
        if (keywords.length > 1 && lower.includes(keywords.join(' '))) score += 10;

        // Individual keyword matches (weighted by frequency)
        for (const k of keywords) {
          const matches = (lower.match(new RegExp(k, 'g')) || []).length;
          if (matches > 0) score += Math.min(matches, 3);
        }

        // Boost recent entries (entries start with date like "2026-05-20]")
        const dateMatch = entry.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          const daysAgo = (Date.now() - new Date(dateMatch[1]).getTime()) / 86400000;
          if (daysAgo < 7) score += 3;
          else if (daysAgo < 30) score += 1;
        }

        // Boost entries with AWS resource IDs if query mentions resources
        if (queryLower.match(/instance|server|ec2|rds|vpc|subnet|security|bucket|lambda/) && lower.match(/\b(i-|sg-|vpc-|subnet-|arn:aws|db-)/)) score += 2;

        return { entry, score };
      });

      const relevant = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map(s => s.entry);
      if (relevant.length > 0) fullPrompt += `RELEVANT KNOWLEDGE:\n---[${relevant.join('\n---[')}\n\n`;
    }
  }

  // Smart history — keep last 6 messages in full, summarize older ones better
  if (state.history.length > 1) {
    const recent = state.history.slice(-7, -1);
    const older = state.history.slice(0, -7);
    if (older.length > 0) {
      // Group older messages into task summaries
      const tasks = [];
      for (let i = 0; i < older.length; i += 2) {
        const userMsg = older[i];
        const agentMsg = older[i + 1];
        if (userMsg) {
          let summary = userMsg.content.slice(0, 100);
          if (agentMsg && agentMsg.content.match(/✅|Created|configured|deployed|modified/)) summary += ' → Done';
          tasks.push(summary);
        }
      }
      fullPrompt += `EARLIER IN THIS SESSION:\n${tasks.join('\n')}\n\n`;
    }
    if (recent.length > 0) {
      fullPrompt += 'RECENT CONVERSATION:\n';
      for (const msg of recent) fullPrompt += `[${msg.role.toUpperCase()}]: ${(msg.role === 'agent' ? msg.content.slice(0, 800) : msg.content)}\n\n`;
    }
    fullPrompt += `[USER]: ${safeMessage}`;
    if (/^(yes|y|proceed|do it|go ahead|approve)$/i.test(safeMessage.trim())) {
      fullPrompt += '\n\nIMPORTANT: User approved. Execute the plan from your previous response NOW.';
    }
  } else {
    fullPrompt += safeMessage;
  }

  const projectDir = path.join(PROJECTS_DIR, safeProject);

  // Point 6: Role-based tool restriction — non-admin gets restricted tools
  const trustFlag = req.user.role === 'admin' ? '--trust-all-tools' : '--trust-tools=fs_read,grep,glob,knowledge,use_aws';
  const args = ['chat', '--no-interactive', trustFlag, '--agent', safeProject, fullPrompt];

  const proc = spawn('kiro-cli', args, {
    cwd: projectDir, env: { ...process.env, ...state.awsEnv }, timeout: 300000
  });

  let stdout = '', stderr = '';
  const progressKey = safeProject;
  const progress = { status: 'thinking', lastAction: '' };
  if (!global.chatProgress) global.chatProgress = {};
  global.chatProgress[progressKey] = progress;

  proc.stdout.on('data', d => {
    stdout += d;
    const chunk = d.toString().replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\[[\d;]*m/g, '').replace(/\r/g, '');
    const lines = chunk.split('\n').map(l => l.trim()).filter(l => l.length > 2 && l.length < 200);
    for (const l of lines) {
      if (l.match(/^(Running |Service name:|Operation name:|Label:|● Running|Reading |Writing |Searching |✓ |Completed)/)) {
        progress.status = 'executing'; progress.lastAction = l;
      } else if (l.startsWith('> ')) { progress.status = 'responding'; }
    }
  });
  proc.stderr.on('data', d => { stderr += d; });

  const timeout = setTimeout(() => { proc.kill(); }, 300000);

  proc.on('close', () => {
    clearTimeout(timeout);
    delete global.chatProgress[progressKey];
    let clean = stdout.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\[\?25[hl]/g, '').replace(/\x1B\[[\d;]*m/g, '').replace(/\r/g, '').replace(/\[\?25[hl]/g, '').trim();
    const lines = clean.split('\n');
    const result = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('All tools are now trusted') || t.startsWith('Agents can sometimes') || t.startsWith('Learn more at') || t.startsWith('Agent for') || t === '⋮' || t === '▸' || t.match(/^▸ Time:/) || t.match(/^\[?\d*G/) || t === '(!)') continue;
      if (t.match(/^(● Running|Running |Service name:|Operation name:|Parameters:|Region:|Label:|↓ |╰ |\(using tool|Completed in| - Completed|Reading |Writing |Searching )/)) continue;
      if (t.startsWith('> ')) { result.push(t.slice(2)); }
      else if (t.startsWith('● Execution failed')) { result.push('⚠️ ' + t.replace('● ', '')); }
      else if (t.match(/^An error occurred|^Error:|^AccessDenied|^AuthFailure/)) { result.push(t); }
      else if (t.startsWith('● ')) { result.push(t.replace('● ', '')); }
      else if (result.length > 0 || t.match(/^(I'll |I will |Here|Your |The |This |✅|⚠️|No |Found |Checking )/i)) { result.push(t); }
    }
    const response = result.filter(l => l.trim() !== '').join('\n').replace(/\n\n+/g, '\n').trim() || `Error: ${stderr || 'No response'}`;

    if (stderr.includes('token') || stderr.includes('expired') || stderr.includes('unauthorized')) {
      return res.json({ response: '⚠️ Kiro CLI authentication expired. Please re-authenticate on the server.' });
    }

    state.history.push({ role: 'agent', content: response });
    if (state.history.length > 20) state.history = state.history.slice(-20);
    saveHistory(safeProject);

    // Auto-save significant actions to knowledge base
    const lastUserMsg = state.history.filter(m => m.role === 'user').slice(-1)[0];
    if (lastUserMsg && (response.includes('✅') || response.includes('Created') || response.includes('configured') || response.includes('deployed') || response.includes('modified') || /\b(sg-|i-|vpc-|subnet-|arn:aws)\b/.test(response))) {
      // Categorize the entry
      let category = 'General';
      const respLower = response.toLowerCase();
      if (respLower.match(/ec2|instance|server|ami/)) category = 'Compute';
      else if (respLower.match(/rds|database|aurora|dynamo/)) category = 'Database';
      else if (respLower.match(/vpc|subnet|security group|route|nat|igw/)) category = 'Networking';
      else if (respLower.match(/s3|bucket|storage|ebs/)) category = 'Storage';
      else if (respLower.match(/iam|role|policy|permission|user/)) category = 'Security';
      else if (respLower.match(/lambda|ecs|eks|fargate/)) category = 'Compute';
      else if (respLower.match(/cloudfront|route53|domain|dns|cert|ssl/)) category = 'DNS & CDN';
      else if (respLower.match(/deploy|pipeline|codebuild|codedeploy/)) category = 'CI/CD';

      const entry = `--- [${new Date().toISOString().split('T')[0]}] [${category}] ---\nTask: ${lastUserMsg.content}\nResult:\n${response.slice(0, 2000)}\n\n`;
      fs.appendFileSync(kbFile, entry);
    }

    logger.info({ project: safeProject, user: req.user.email, responseLen: response.length }, 'Chat response');
    res.json({ response });
  });

  proc.on('error', err => {
    clearTimeout(timeout);
    logger.error(err, 'kiro-cli spawn error');
    if (err.message.includes('ENOENT')) res.json({ response: '⚠️ kiro-cli not found. Install it on the server.' });
    else res.json({ response: `Failed: ${err.message}` });
  });
});


// --- Progress Polling ---
app.get('/api/progress/:key', (req, res) => {
  const p = (global.chatProgress || {})[req.params.key];
  res.json(p || { status: 'done', lastAction: '' });
});

// --- Knowledge ---
app.get('/api/knowledge/:project', (req, res) => {
  const kbFile = path.join(PROJECTS_DIR, sanitizeProjectName(req.params.project), 'knowledge_base.txt');
  if (!fs.existsSync(kbFile)) return res.json({ knowledge: '' });
  res.json({ knowledge: fs.readFileSync(kbFile, 'utf8') });
});

app.get('/api/knowledge/:project/export', (req, res) => {
  const project = sanitizeProjectName(req.params.project);
  const kbFile = path.join(PROJECTS_DIR, project, 'knowledge_base.txt');
  if (!fs.existsSync(kbFile)) return res.status(404).json({ error: 'No knowledge base' });
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="${project}-knowledge.md"`);
  res.send(`# ${project} — Knowledge Base\n\nExported: ${new Date().toISOString()}\n\n${fs.readFileSync(kbFile, 'utf8')}`);
});

// --- Usage Stats ---
app.get('/api/usage/:project', (req, res) => {
  const project = sanitizeProjectName(req.params.project);
  const rows = db.prepare('SELECT date, COUNT(*) as queries FROM usage_queries WHERE project = ? GROUP BY date ORDER BY date DESC LIMIT 30').all(project);
  const usage = {};
  for (const r of rows) usage[r.date] = { queries: r.queries };
  res.json({ usage });
});

// --- History & Reset ---
app.get('/api/history/:project', (req, res) => {
  const state = getState(sanitizeProjectName(req.params.project));
  res.json({ history: state.history });
});

app.post('/api/reset', (req, res) => {
  const { project } = req.body;
  const safe = sanitizeProjectName(project || '');
  if (safe && projectState[safe]) { projectState[safe].history = []; saveHistory(safe); }
  res.json({ success: true });
});

// --- Credentials ---
app.post('/api/credentials', (req, res) => {
  const { type, project, accessKey, secretKey, sessionToken, region, ssoUrl, ssoRegion, accountId, roleName, profile } = req.body;
  const safe = sanitizeProjectName(project || '');
  if (!safe) return res.json({ success: false, error: 'Invalid project' });
  const state = getState(safe);

  if (type === 'iam') {
    if (!accessKey || !secretKey) return res.json({ success: false, error: 'Access Key and Secret Key required' });
    state.awsEnv = { AWS_ACCESS_KEY_ID: accessKey, AWS_SECRET_ACCESS_KEY: secretKey, AWS_DEFAULT_REGION: region || 'us-east-1' };
    if (sessionToken) state.awsEnv.AWS_SESSION_TOKEN = sessionToken;
    const verify = spawn('aws', ['sts', 'get-caller-identity'], { env: { ...process.env, ...state.awsEnv } });
    let out = '';
    verify.stdout.on('data', d => out += d);
    verify.on('close', code => {
      if (code === 0) { saveAwsEnv(safe, state.awsEnv); try { res.json({ success: true, identity: JSON.parse(out).Arn }); } catch { res.json({ success: true, identity: 'connected' }); } }
      else { state.awsEnv = {}; res.json({ success: false, error: 'Invalid credentials' }); }
    });
  } else if (type === 'sso') {
    if (!ssoUrl || !accountId || !roleName) return res.json({ success: false, error: 'SSO URL, Account ID, and Role required' });
    const profileName = `sso-${accountId}`;
    const ssoReg = ssoRegion || 'us-east-1';
    const cmds = [
      `aws configure set sso_start_url "${ssoUrl}" --profile ${profileName}`,
      `aws configure set sso_region "${ssoReg}" --profile ${profileName}`,
      `aws configure set sso_account_id "${accountId}" --profile ${profileName}`,
      `aws configure set sso_role_name "${roleName}" --profile ${profileName}`,
      `aws configure set region "${ssoReg}" --profile ${profileName}`
    ];
    const setup = spawn('bash', ['-c', cmds.join(' && ')], { env: { ...process.env } });
    setup.on('close', (code) => {
      if (code !== 0) return res.json({ success: false, error: 'Failed to configure SSO profile' });
      const login = spawn('aws', ['sso', 'login', '--profile', profileName, '--no-browser'], { env: { ...process.env } });
      let output = '';
      login.stdout.on('data', d => output += d.toString());
      login.stderr.on('data', d => output += d.toString());
      setTimeout(() => {
        const urlMatch = output.match(/(https:\/\/[^\s]+)/);
        const codeMatch = output.match(/([A-Z]{4}-[A-Z]{4})/);
        state.awsEnv = { AWS_PROFILE: profileName, AWS_DEFAULT_REGION: ssoReg };
        saveAwsEnv(safe, state.awsEnv);
        res.json({ success: true, ssoAuth: true, authUrl: urlMatch ? urlMatch[1] : '', userCode: codeMatch ? codeMatch[1] : '', identity: `SSO: ${roleName}@${accountId}`, profile: profileName });
      }, 5000);
    });
  } else if (type === 'profile') {
    state.awsEnv = { AWS_PROFILE: profile || 'default' };
    saveAwsEnv(safe, state.awsEnv);
    res.json({ success: true, identity: `profile: ${profile}` });
  } else res.json({ success: false, error: 'Unknown type' });
});

app.get('/api/credentials/:project', (req, res) => {
  const state = getState(sanitizeProjectName(req.params.project));
  if (state.awsEnv && state.awsEnv.AWS_ACCESS_KEY_ID) {
    const key = state.awsEnv.AWS_ACCESS_KEY_ID;
    res.json({ configured: true, type: 'iam', accessKey: key.slice(0, 4) + '...' + key.slice(-4), region: state.awsEnv.AWS_DEFAULT_REGION });
  } else if (state.awsEnv && state.awsEnv.AWS_PROFILE) {
    res.json({ configured: true, type: 'profile', profile: state.awsEnv.AWS_PROFILE, region: state.awsEnv.AWS_DEFAULT_REGION });
  } else { res.json({ configured: false }); }
});

app.delete('/api/credentials/:project/disconnect', (req, res) => {
  const safe = sanitizeProjectName(req.params.project);
  const state = getState(safe);
  state.awsEnv = {};
  const credFile = path.join(PROJECTS_DIR, safe, '.aws-env.json');
  if (fs.existsSync(credFile)) fs.unlinkSync(credFile);
  res.json({ success: true });
});

// --- Health ---
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// --- Admin APIs ---
app.get('/api/me', (req, res) => {
  res.json({ email: req.user.email, name: req.user.name, role: req.user.role });
});

app.get('/api/admin/users', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const rows = db.prepare('SELECT email, name, role, projects, created_at FROM users').all();
  const users = {};
  for (const r of rows) users[r.email] = { name: r.name, role: r.role, projects: JSON.parse(r.projects), createdAt: r.created_at };
  res.json({ users });
});

app.post('/api/admin/users', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { email, password, role, projects } = req.body;
  if (!email || !password) return res.json({ success: false, error: 'Email and password required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ success: false, error: 'Invalid email' });

  const existing = db.prepare('SELECT email FROM users WHERE email = ?').get(email);
  if (existing) return res.json({ success: false, error: 'User already exists' });

  const { hash, salt } = hashPw(password);
  db.prepare('INSERT INTO users (email, name, password_hash, salt, role, projects) VALUES (?, ?, ?, ?, ?, ?)').run(email, email.split('@')[0], hash, salt, role || 'user', JSON.stringify(projects || []));

  // Send credentials via email
  if (process.env.SMTP_USER) {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: parseInt(process.env.SMTP_PORT || '587'), secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER, to: email,
      subject: 'Your Vira Account',
      html: `<h2>Welcome to Vira</h2><p><b>URL:</b> <a href="${appUrl}">${appUrl}</a></p><p><b>Email:</b> ${email}</p><p><b>Password:</b> ${password}</p><p>Change your password after first login.</p>`
    }).catch(err => logger.error(err, 'Welcome email failed'));
  }
  logger.info({ admin: req.user.email, newUser: email }, 'User created');
  res.json({ success: true, emailSent: !!process.env.SMTP_USER });
});

app.delete('/api/admin/users/:email', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const email = decodeURIComponent(req.params.email);
  db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
  db.prepare('DELETE FROM users WHERE email = ?').run(email);
  logger.info({ admin: req.user.email, deleted: email }, 'User deleted');
  res.json({ success: true });
});

app.post('/api/admin/users/:email/projects', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const email = decodeURIComponent(req.params.email);
  const user = db.prepare('SELECT projects, name FROM users WHERE email = ?').get(email);
  if (!user) return res.json({ success: false, error: 'User not found' });
  const projects = JSON.parse(user.projects);
  const { project } = req.body;
  if (!projects.includes(project)) projects.push(project);
  db.prepare('UPDATE users SET projects = ? WHERE email = ?').run(JSON.stringify(projects), email);

  if (process.env.SMTP_USER) {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: parseInt(process.env.SMTP_PORT || '587'), secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER, to: email,
      subject: `You've been added to project: ${project}`,
      html: `<h2>Project Access Granted</h2><p>Hi ${user.name},</p><p>You now have access to the <strong>${project}</strong> project on Vira.</p><p><a href="${appUrl}">Open Vira</a></p>`
    }).catch(err => logger.error(err, 'Project assign email failed'));
  }

  res.json({ success: true });
});

app.delete('/api/admin/users/:email/projects/:project', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const email = decodeURIComponent(req.params.email);
  const user = db.prepare('SELECT projects FROM users WHERE email = ?').get(email);
  if (!user) return res.json({ success: false, error: 'User not found' });
  const projects = JSON.parse(user.projects).filter(p => p !== req.params.project);
  db.prepare('UPDATE users SET projects = ? WHERE email = ?').run(JSON.stringify(projects), email);
  res.json({ success: true });
});

// --- Start ---
app.listen(PORT, () => logger.info({ port: PORT }, '🚀 Vira running'));
