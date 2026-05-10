const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

const sessions = {};

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
    res.json({ success: true, token, name: user.name, role: user.role });
});

app.post('/api/logout', (req, res) => {
    const token = req.headers['authorization'];
    if (token) delete sessions[token];
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

    const prompt = `# ${name} — Infrastructure Agent\nYou are the DevOps engineer for ${name}. You learn from every task.\n\n## RULES:\n1. ALWAYS check knowledge base first\n2. Show plan → ask approval → execute on "yes"\n3. When user says "yes" — execute immediately\n4. NEVER say "run it yourself"\n5. After tasks, store summary in knowledge base\n6. Present data in TABLES, not bullet lists\n\n## DEFAULTS:\n- Region: ${region || 'us-east-1'}\n- If use_aws fails, fall back to execute_bash\n\n## RESPONSE FORMAT:\n- Use markdown tables for plans and results\n- Short and direct\n`;
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
    const kbFile = path.join(PROJECTS_DIR, project, 'knowledge_base.txt');
    if (fs.existsSync(kbFile)) {
        const kb = fs.readFileSync(kbFile, 'utf8').trim();
        if (kb) fullPrompt += `KNOWLEDGE BASE:\n${kb}\n\n`;
    }

    if (state.history.length > 1) {
        fullPrompt += 'CONVERSATION HISTORY:\n';
        for (const msg of state.history.slice(-10, -1)) {
            fullPrompt += `${msg.role === 'user' ? 'User' : 'Agent'}: ${msg.content}\n`;
        }
        fullPrompt += `\nCURRENT MESSAGE: ${message}`;
        if (/^(yes|y|proceed|do it|go ahead)$/i.test(message.trim())) {
            fullPrompt += '\n\nIMPORTANT: User approved. Execute the plan from your previous response NOW.';
        }
    } else {
        fullPrompt += message;
    }

    const projectDir = path.join(PROJECTS_DIR, project);
    const proc = spawn('kiro-cli', ['chat', '--no-interactive', '--trust-all-tools', '--agent', project, fullPrompt], {
        cwd: projectDir, env: { ...process.env, ...state.awsEnv }, timeout: 120000
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    // Timeout handling
    const timeout = setTimeout(() => { proc.kill(); }, 90000);

    proc.on('close', () => {
        clearTimeout(timeout);
        let clean = stdout.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\[\?25[hl]/g, '').replace(/\x1B\[[\d;]*m/g, '').replace(/\r/g, '').trim();
        const lines = clean.split('\n');
        const result = [];
        let capturing = false;
        for (const line of lines) {
            if (line.startsWith('> ')) { capturing = true; result.push(line.slice(2)); }
            else if (capturing) {
                if (line.match(/^(Running |Service name:|Operation name:|Parameters:|Region:|Label:|- [a-z-]+:|↓ |╰ |\(using tool|I will run|I'll append|Purpose:|At line:|The token|CategoryInfo|FullyQualifiedErrorId|\+|Completed in| - Completed|Appending to:|Reading |✓ Successfully|Writing |Searching |Created |Deleted )/)) { capturing = false; }
                else if (line.trim() === '' && result.length > 0 && result[result.length - 1].trim() === '') {}
                else { result.push(line); }
            }
        }
        const response = result.filter(l => l.trim() !== '').join('\n').replace(/\n\n+/g, '\n').trim() || `Error: ${stderr || 'No response'}`;

        // Check for auth expiry
        if (stderr.includes('token') || stderr.includes('expired') || stderr.includes('unauthorized')) {
            return res.json({ response: '⚠️ Kiro CLI authentication expired. Please re-authenticate on the server: `kiro-cli login --use-device-flow`' });
        }

        state.history.push({ role: 'agent', content: response });
        if (state.history.length > 20) state.history = state.history.slice(-20);
        saveHistory(project);

        // Auto-store meaningful interactions in knowledge base
        const lastUserMsg = state.history.filter(m => m.role === 'user').slice(-1)[0];
        if (lastUserMsg && response.includes('✅')) {
            const kbFile = path.join(PROJECTS_DIR, project, 'knowledge_base.txt');
            const entry = `[${new Date().toISOString().split('T')[0]}] Q: ${lastUserMsg.content}\nA: ${response.slice(0, 300)}\n\n`;
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`\n🚀 Multi-Project Agent at http://localhost:${PORT}\n   Default login: admin / admin\n`));
