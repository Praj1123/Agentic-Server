const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Load .env file
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) { fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => { const [k, ...v] = line.split('='); if (k && k.trim() && !k.startsWith('#')) process.env[k.trim()] = v.join('=').trim(); }); }

const app = express();
app.use(cors());
app.use(express.json());

// --- Config ---
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(
    process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'infra-agent')
        : path.join(os.homedir(), '.infra-agent'),
    'projects'
);
const DATA_DIR = path.dirname(PROJECTS_DIR);
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.createHash('sha256').update(os.hostname() + 'infra-agent-salt').digest();
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');

if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

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
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// --- Auth ---
function getUsers() {
    if (!fs.existsSync(USERS_FILE)) { fs.writeFileSync(USERS_FILE, '{}'); return {}; }
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function saveUsers(users) { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }

function hashPw(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return { hash, salt };
}

function verifyPw(password, hash, salt) {
    return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex') === hash;
}

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
let sessions = {};
if (fs.existsSync(SESSIONS_FILE)) { try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch {} }
function saveSessions() { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions)); }

function authMiddleware(req, res, next) {
    if (['/api/login', '/api/signup'].includes(req.path) || !req.path.startsWith('/api/')) return next();
    const token = req.headers['authorization'];
    if (!token || !sessions[token]) return res.status(401).json({ error: 'Unauthorized' });
    req.user = sessions[token];
    next();
}

app.post('/api/signup', (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password) return res.json({ success: false, error: 'Email and password required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ success: false, error: 'Invalid email' });
    if (password.length < 8) return res.json({ success: false, error: 'Password must be at least 8 characters' });

    const users = getUsers();
    // Only allow signup if no users exist (first admin setup)
    if (Object.keys(users).length > 0) return res.json({ success: false, error: 'Contact your admin to get an account.' });
    if (users[email]) return res.json({ success: false, error: 'Email already registered' });

    const { hash, salt } = hashPw(password);
    users[email] = { password: hash, salt, name: name || email.split('@')[0], role: 'admin', createdAt: new Date().toISOString() };
    saveUsers(users);

    const token = crypto.randomBytes(48).toString('hex');
    sessions[token] = { email, name: users[email].name, role: 'admin', loginAt: Date.now() };
    saveSessions();
    res.json({ success: true, token, name: users[email].name, role: 'admin' });
});

const otpStore = {}; // { email: { code, expiresAt } }

app.post('/api/login', (req, res) => {
    const { email, password, otp } = req.body;
    const users = getUsers();
    const user = users[email];

    if (!user) return res.json({ success: false, error: 'Email not found. Contact admin.' });
    if (!verifyPw(password || '', user.password, user.salt)) return res.json({ success: false, error: 'Incorrect password' });

    // Admin requires OTP
    if (user.role === 'admin') {
        if (!otp) {
            // Generate and send OTP
            const code = Math.floor(100000 + Math.random() * 900000).toString();
            otpStore[email] = { code, expiresAt: Date.now() + 5 * 60 * 1000 };

            if (process.env.SMTP_USER) {
                const nodemailer = require('nodemailer');
                const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: parseInt(process.env.SMTP_PORT || '587'), secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
                transporter.sendMail({
                    from: process.env.SMTP_FROM || process.env.SMTP_USER, to: email,
                    subject: 'Infra Agent — Login OTP',
                    html: `<h2>Your login code</h2><p style="font-size:32px;font-weight:bold;color:#6366f1;letter-spacing:4px">${code}</p><p>Expires in 5 minutes.</p>`
                }).catch(err => console.error('OTP email failed:', err.message));
            }
            return res.json({ success: false, otpSent: true, error: 'OTP sent to your email. Enter it to continue.' });
        }

        // Verify OTP
        const stored = otpStore[email];
        if (!stored || stored.code !== otp || Date.now() > stored.expiresAt) {
            return res.json({ success: false, error: 'Invalid or expired OTP' });
        }
        delete otpStore[email];
    }

    const token = crypto.randomBytes(48).toString('hex');
    sessions[token] = { email, name: user.name, role: user.role, loginAt: Date.now() };
    saveSessions();
    res.json({ success: true, token, name: user.name, role: user.role });
});

app.post('/api/logout', (req, res) => {
    const token = req.headers['authorization'];
    if (token) { delete sessions[token]; saveSessions(); }
    res.json({ success: true });
});

app.use(authMiddleware);

// --- Rate Limiting ---
const rateLimits = {};
const RATE_LIMIT = 30; // requests per minute
const RATE_WINDOW = 60000;

function checkRateLimit(user) {
    const now = Date.now();
    if (!rateLimits[user]) rateLimits[user] = [];
    rateLimits[user] = rateLimits[user].filter(t => now - t < RATE_WINDOW);
    if (rateLimits[user].length >= RATE_LIMIT) return false;
    rateLimits[user].push(now);
    return true;
}

// --- Usage Tracking ---
function trackUsage(project, user) {
    let usage = {};
    if (fs.existsSync(USAGE_FILE)) { try { usage = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch {} }
    const today = new Date().toISOString().split('T')[0];
    if (!usage[project]) usage[project] = {};
    if (!usage[project][today]) usage[project][today] = { queries: 0, users: [] };
    usage[project][today].queries++;
    if (!usage[project][today].users.includes(user)) usage[project][today].users.push(user);
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
}

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
    // Filter by user access (admin sees all)
    if (req.user.role === 'admin') return res.json({ projects });
    const users = getUsers();
    const userProjects = users[req.user.email]?.projects || [];
    res.json({ projects: projects.filter(p => userProjects.includes(p.name)) });
});

app.post('/api/projects', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Only admin can create projects' });
    const { name, region, description } = req.body;
    if (!name) return res.json({ success: false, error: 'Name required' });
    if (!/^[a-z0-9-]+$/.test(name)) return res.json({ success: false, error: 'Use lowercase letters, numbers, hyphens only' });
    const projectDir = path.join(PROJECTS_DIR, name);
    if (fs.existsSync(projectDir)) return res.json({ success: false, error: 'Project already exists' });

    fs.mkdirSync(path.join(projectDir, '.kiro', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'prompts'), { recursive: true });

    const agentConfig = {
        name, description: description || `Agent for ${name}`,
        prompt: 'file://../../prompts/system-prompt.md',
        tools: ["fs_read", "fs_write", "execute_bash", "use_aws", "grep", "glob", "knowledge"],
        allowedTools: ["fs_read", "grep", "glob", "knowledge"],
        resources: ["file://runbooks/**/*.md", "file://architecture/**/*.md"],
        welcomeMessage: `Agent for ${name} ready.`
    };
    fs.writeFileSync(path.join(projectDir, '.kiro', 'agents', `${name}.json`), JSON.stringify(agentConfig, null, 2));

    const prompt = `# ${name} — Infrastructure Agent

You are the infrastructure expert for the "${name}" project on AWS (region: ${region || 'us-east-1'}).

## WHO YOU ARE:
- You migrated this workload to AWS and know every detail about it
- You are the team's go-to person for understanding, debugging, and managing this infrastructure
- You have full AWS expertise but explain things in SIMPLE terms — assume the user has ZERO AWS knowledge

## HOW TO ANSWER:
- ALWAYS check the knowledge base first for project-specific details (resources, decisions, architecture)
- When explaining AWS concepts, use analogies and plain language (e.g., "Security Group = firewall rules for your server")
- When referencing resources, include the actual resource names/IDs from this project's knowledge base
- If the user asks "why" something was set up a certain way, explain the reasoning (cost, performance, security, availability)
- If you don't have project-specific info in the knowledge base, say so and offer to look it up via AWS

## RULES:
1. Check knowledge base FIRST before making any AWS API calls
2. Show plan → ask approval → execute on "yes"
3. When user says "yes" — execute immediately, no re-confirmation
4. NEVER say "run it yourself" — you execute everything
5. After completing tasks, store a detailed summary in knowledge base (what was done, why, how to troubleshoot)
6. Present data in TABLES, not bullet lists

## RESPONSE STYLE:
- Short, direct, no jargon unless explained
- Use markdown tables for resource lists and plans
- When showing architecture, describe the flow simply: "Request comes in → hits load balancer → goes to your app server → talks to database"
- For troubleshooting, give step-by-step with expected output at each step

## DEFAULTS:
- Region: ${region || 'us-east-1'}
- If use_aws fails, fall back to execute_bash with AWS CLI
`;
    fs.writeFileSync(path.join(projectDir, 'prompts', 'system-prompt.md'), prompt);
    res.json({ success: true });
});

app.delete('/api/projects/:name', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Only admin can delete projects' });
    const projectDir = path.join(PROJECTS_DIR, req.params.name);
    if (!fs.existsSync(projectDir)) return res.json({ success: false, error: 'Not found' });
    fs.rmSync(projectDir, { recursive: true, force: true });
    delete projectState[req.params.name];
    res.json({ success: true });
});

// --- Chat API ---
app.post('/api/chat', (req, res) => {
    const { message, project } = req.body;
    if (!message || !project) return res.status(400).json({ error: 'message and project required' });
    if (!checkRateLimit(req.user.email)) return res.status(429).json({ error: 'Rate limit exceeded. Max 30 requests/minute.' });

    trackUsage(project, req.user.email);
    const state = getState(project);
    state.history.push({ role: 'user', content: message });

    let fullPrompt = '';

    // Role-based access control instructions
    if (req.user.role !== 'admin') {
        fullPrompt += `USER ROLE: Client Team Member (restricted)

ACCESS RULES FOR THIS USER:
- READ-ONLY actions are ALLOWED freely: describe, list, get, check status, view logs, explain architecture
- WRITE/MODIFY actions REQUIRE APPROVAL: create, delete, modify, update, restart, stop, terminate, scale, deploy
- For any write action: ALWAYS show a detailed plan first with what will change and potential impact
- ONLY execute write actions when user explicitly says "yes", "approve", "proceed", "do it", or "go ahead"
- If user asks to do something destructive (delete, terminate), warn about consequences and ask for confirmation TWICE
- Always explain what each action does in simple terms before asking for approval
- After execution, explain what happened and how to verify it worked

`;
    }

    const kbFile = path.join(PROJECTS_DIR, project, 'knowledge_base.txt');
    // Smart KB: only send relevant entries based on current query
    if (fs.existsSync(kbFile)) {
        const kb = fs.readFileSync(kbFile, 'utf8').trim();
        if (kb) {
            const entries = kb.split(/^---\s*\[/m).filter(e => e.trim());
            const keywords = message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            const relevant = entries.filter(entry => {
                const lower = entry.toLowerCase();
                return keywords.some(k => lower.includes(k));
            }).slice(0, 5); // max 5 relevant entries
            if (relevant.length > 0) {
                fullPrompt += `RELEVANT KNOWLEDGE:\n---[${relevant.join('\n---[')}\n\n`;
            }
        }
    }

    // Smart history: summarize older messages, keep recent 4 in full
    if (state.history.length > 1) {
        const recent = state.history.slice(-5, -1);
        const older = state.history.slice(0, -5);
        if (older.length > 0) {
            const summary = older.map(m => `${m.role === 'user' ? 'User asked' : 'Agent answered'}: ${m.content.slice(0, 80)}`).join('; ');
            fullPrompt += `EARLIER CONTEXT (summary): ${summary}\n\n`;
        }
        if (recent.length > 0) {
            fullPrompt += 'RECENT CONVERSATION:\n';
            for (const msg of recent) {
                const content = msg.role === 'agent' ? msg.content.slice(0, 500) : msg.content;
                fullPrompt += `[${msg.role.toUpperCase()}]: ${content}\n\n`;
            }
        }
        fullPrompt += `[USER]: ${message}`;
        if (/^(yes|y|proceed|do it|go ahead|approve)$/i.test(message.trim())) {
            fullPrompt += '\n\nIMPORTANT: User approved. Execute the plan from your previous response NOW.';
        }
    } else {
        fullPrompt += message;
    }

    const projectDir = path.join(PROJECTS_DIR, project);
    const proc = spawn('kiro-cli', ['chat', '--no-interactive', '--trust-all-tools', '--agent', project, fullPrompt], {
        cwd: projectDir, env: { ...process.env, ...state.awsEnv }, timeout: 300000
    });

    let stdout = '', stderr = '';
    const progressKey = project;
    const progress = { status: 'thinking', lastAction: '' };
    if (!global.chatProgress) global.chatProgress = {};
    global.chatProgress[progressKey] = progress;

    proc.stdout.on('data', d => {
        stdout += d;
        const chunk = d.toString().replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\[[\d;]*m/g, '').replace(/\r/g, '');
        const lines = chunk.split('\n').map(l => l.trim()).filter(l => l.length > 2 && l.length < 200);
        for (const l of lines) {
            if (l.match(/^(Running |Service name:|Operation name:|Label:|● Running|Reading |Writing |Searching |✓ |Completed)/)) {
                progress.status = 'executing';
                progress.lastAction = l;
            } else if (l.startsWith('> ')) {
                progress.status = 'responding';
            }
        }
    });
    proc.stderr.on('data', d => { stderr += d; });

    const timeout = setTimeout(() => { proc.kill(); }, 300000);

    proc.on('close', () => {
        clearTimeout(timeout);
        delete global.chatProgress[progressKey];
        let clean = stdout.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\[\?25[hl]/g, '').replace(/\x1B\[[\d;]*m/g, '').replace(/\r/g, '').replace(/\[\?25[hl]/g, '').trim();
        // Debug: log raw output to file
        fs.writeFileSync(path.join(PROJECTS_DIR, project, 'last_raw_output.txt'), clean);
        const lines = clean.split('\n');
        const result = [];
        for (const line of lines) {
            const t = line.trim();
            // Skip noise lines
            if (!t || t.startsWith('All tools are now trusted') || t.startsWith('Agents can sometimes') || t.startsWith('Learn more at') || t.startsWith('Agent for') || t === '⋮' || t === '▸' || t.match(/^▸ Time:/) || t.match(/^\[?\d*G/) || t === '(!)') continue;
            // Action lines - skip
            if (t.match(/^(● Running|Running |Service name:|Operation name:|Parameters:|Region:|Label:|↓ |╰ |\(using tool|Completed in| - Completed|Reading |Writing |Searching )/)) continue;
            // Response/error content
            if (t.startsWith('> ')) { result.push(t.slice(2)); }
            else if (t.startsWith('● Execution failed')) { result.push('⚠️ ' + t.replace('● ', '')); }
            else if (t.match(/^An error occurred|^Error:|^AccessDenied|^AuthFailure/)) { result.push(t); }
            else if (t.startsWith('● ')) { result.push(t.replace('● ', '')); }
            else if (result.length > 0 || t.match(/^(I'll |I will |Here|Your |The |This |✅|⚠️|No |Found |Checking )/i)) { result.push(t); }
        }
        const response = result.filter(l => l.trim() !== '').join('\n').replace(/\n\n+/g, '\n').trim() || `Error: ${stderr || 'No response'}`;

        if (stderr.includes('token') || stderr.includes('expired') || stderr.includes('unauthorized')) {
            return res.json({ response: '⚠️ Kiro CLI authentication expired. Please re-authenticate on the server: `kiro-cli login --use-device-flow`' });
        }

        state.history.push({ role: 'agent', content: response });
        if (state.history.length > 20) state.history = state.history.slice(-20);
        saveHistory(project);

        const lastUserMsg = state.history.filter(m => m.role === 'user').slice(-1)[0];
        if (lastUserMsg && (response.includes('✅') || response.includes('Created') || response.includes('configured') || response.includes('deployed') || response.includes('modified') || /\b(sg-|i-|vpc-|subnet-|arn:aws)\b/.test(response))) {
            const kbFile = path.join(PROJECTS_DIR, project, 'knowledge_base.txt');
            const entry = `--- [${new Date().toISOString().split('T')[0]}] ---\nTask: ${lastUserMsg.content}\nResult:\n${response}\n\n`;
            fs.appendFileSync(kbFile, entry);
        }

        res.json({ response });
    });

    proc.on('error', err => {
        clearTimeout(timeout);
        if (err.message.includes('ENOENT')) res.json({ response: '⚠️ kiro-cli not found. Install it on the server.' });
        else res.json({ response: `Failed: ${err.message}` });
    });
});

// --- Progress Polling ---
app.get('/api/progress/:key', (req, res) => {
    const p = (global.chatProgress || {})[req.params.key];
    res.json(p || { status: 'done', lastAction: '' });
});

// --- Knowledge Export ---
app.get('/api/knowledge/:project', (req, res) => {
    const kbFile = path.join(PROJECTS_DIR, req.params.project, 'knowledge_base.txt');
    if (!fs.existsSync(kbFile)) return res.json({ knowledge: '' });
    res.json({ knowledge: fs.readFileSync(kbFile, 'utf8') });
});

app.get('/api/knowledge/:project/export', (req, res) => {
    const kbFile = path.join(PROJECTS_DIR, req.params.project, 'knowledge_base.txt');
    if (!fs.existsSync(kbFile)) return res.status(404).json({ error: 'No knowledge base' });
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.project}-knowledge.md"`);
    res.send(`# ${req.params.project} — Knowledge Base\n\nExported: ${new Date().toISOString()}\n\n${fs.readFileSync(kbFile, 'utf8')}`);
});

// --- Usage Stats ---
app.get('/api/usage/:project', (req, res) => {
    if (!fs.existsSync(USAGE_FILE)) return res.json({ usage: {} });
    const usage = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    res.json({ usage: usage[req.params.project] || {} });
});

// --- History & Reset ---
app.get('/api/history/:project', (req, res) => {
    const state = getState(req.params.project);
    res.json({ history: state.history });
});

app.post('/api/reset', (req, res) => {
    const { project } = req.body;
    if (project && projectState[project]) { projectState[project].history = []; saveHistory(project); }
    res.json({ success: true });
});

// --- Credentials ---
app.post('/api/credentials', (req, res) => {
    const { type, project, accessKey, secretKey, sessionToken, region, ssoUrl, ssoRegion, accountId, roleName, profile } = req.body;
    const state = getState(project);
    if (type === 'iam') {
        if (!accessKey || !secretKey) return res.json({ success: false, error: 'Access Key and Secret Key required' });
        state.awsEnv = { AWS_ACCESS_KEY_ID: accessKey, AWS_SECRET_ACCESS_KEY: secretKey, AWS_DEFAULT_REGION: region || 'us-east-1' };
        if (sessionToken) state.awsEnv.AWS_SESSION_TOKEN = sessionToken;
        const verify = spawn('aws', ['sts', 'get-caller-identity'], { env: { ...process.env, ...state.awsEnv } });
        let out = '';
        verify.stdout.on('data', d => out += d);
        verify.on('close', code => {
            if (code === 0) { saveAwsEnv(project, state.awsEnv); try { res.json({ success: true, identity: JSON.parse(out).Arn }); } catch { res.json({ success: true, identity: 'connected' }); } }
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
                saveAwsEnv(project, state.awsEnv);
                res.json({ success: true, ssoAuth: true, authUrl: urlMatch ? urlMatch[1] : '', userCode: codeMatch ? codeMatch[1] : '', identity: `SSO: ${roleName}@${accountId}`, profile: profileName });
            }, 5000);
        });
    } else if (type === 'profile') {
        state.awsEnv = { AWS_PROFILE: profile || 'default' };
        saveAwsEnv(project, state.awsEnv);
        res.json({ success: true, identity: `profile: ${profile}` });
    } else res.json({ success: false, error: 'Unknown type' });
});

app.get('/api/credentials/:project', (req, res) => {
    const state = getState(req.params.project);
    if (state.awsEnv && state.awsEnv.AWS_ACCESS_KEY_ID) {
        const key = state.awsEnv.AWS_ACCESS_KEY_ID;
        res.json({ configured: true, type: 'iam', accessKey: key.slice(0, 4) + '...' + key.slice(-4), region: state.awsEnv.AWS_DEFAULT_REGION });
    } else if (state.awsEnv && state.awsEnv.AWS_PROFILE) {
        res.json({ configured: true, type: 'profile', profile: state.awsEnv.AWS_PROFILE, region: state.awsEnv.AWS_DEFAULT_REGION });
    } else { res.json({ configured: false }); }
});

app.delete('/api/credentials/:project/disconnect', (req, res) => {
    const state = getState(req.params.project);
    state.awsEnv = {};
    const credFile = path.join(PROJECTS_DIR, req.params.project, '.aws-env.json');
    if (fs.existsSync(credFile)) fs.unlinkSync(credFile);
    res.json({ success: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// --- Admin APIs ---
app.get('/api/me', (req, res) => {
    res.json({ email: req.user.email, name: req.user.name, role: req.user.role });
});

app.get('/api/admin/users', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const users = getUsers();
    const safe = {};
    Object.entries(users).forEach(([email, u]) => { safe[email] = { name: u.name, role: u.role, projects: u.projects || [], createdAt: u.createdAt }; });
    res.json({ users: safe });
});

app.post('/api/admin/users', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { email, password, role, projects } = req.body;
    if (!email || !password) return res.json({ success: false, error: 'Email and password required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ success: false, error: 'Invalid email' });
    const users = getUsers();
    if (users[email]) return res.json({ success: false, error: 'User already exists' });
    const { hash, salt } = hashPw(password);
    users[email] = { password: hash, salt, name: email.split('@')[0], role: role || 'user', projects: projects || [], createdAt: new Date().toISOString() };
    saveUsers(users);

    // Send credentials via email
    const nodemailer = require('nodemailer');
    if (process.env.SMTP_USER) {
        const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: parseInt(process.env.SMTP_PORT || '587'), secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
        const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
        transporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER, to: email,
            subject: 'Your Infra Agent Account',
            html: `<h2>Welcome to Infra Agent</h2><p>Your account:</p><table><tr><td><b>URL:</b></td><td><a href="${appUrl}">${appUrl}</a></td></tr><tr><td><b>Email:</b></td><td>${email}</td></tr><tr><td><b>Password:</b></td><td>${password}</td></tr><tr><td><b>Projects:</b></td><td>${(projects || []).join(', ') || 'None yet'}</td></tr></table><p style="color:#666">Change your password after first login.</p>`
        }).catch(err => console.error('Email failed:', err.message));
    }
    res.json({ success: true, emailSent: !!process.env.SMTP_USER });
});

app.delete('/api/admin/users/:email', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const users = getUsers();
    delete users[decodeURIComponent(req.params.email)];
    saveUsers(users);
    res.json({ success: true });
});

app.post('/api/admin/users/:email/projects', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const users = getUsers();
    const email = decodeURIComponent(req.params.email);
    if (!users[email]) return res.json({ success: false, error: 'User not found' });
    if (!users[email].projects) users[email].projects = [];
    const { project } = req.body;
    if (!users[email].projects.includes(project)) users[email].projects.push(project);
    saveUsers(users);
    res.json({ success: true });
});

app.delete('/api/admin/users/:email/projects/:project', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const users = getUsers();
    const email = decodeURIComponent(req.params.email);
    if (!users[email]) return res.json({ success: false, error: 'User not found' });
    users[email].projects = (users[email].projects || []).filter(p => p !== req.params.project);
    saveUsers(users);
    res.json({ success: true });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`\n🚀 Multi-Project Agent at http://localhost:${PORT}\n   Default login: admin / admin\n`));
