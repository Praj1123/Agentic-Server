const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const BASE_DIR = path.resolve(__dirname, '../../');
const os = require('os');
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(
    process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'infra-agent')
        : path.join(os.homedir(), '.infra-agent'),
    'projects'
);

// Ensure projects directory exists
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// Per-project state
const projectState = {}; // { projectName: { history: [], awsEnv: {} } }

function getState(project) {
    if (!projectState[project]) {
        projectState[project] = { history: [], awsEnv: {} };
        // Load saved history from disk
        const historyFile = path.join(PROJECTS_DIR, project, 'chat-history.json');
        if (fs.existsSync(historyFile)) {
            try { projectState[project].history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch {}
        }
        // Load saved AWS credentials from disk
        const credFile = path.join(PROJECTS_DIR, project, '.aws-env.json');
        if (fs.existsSync(credFile)) {
            try { projectState[project].awsEnv = JSON.parse(fs.readFileSync(credFile, 'utf8')); } catch {}
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
    try { fs.writeFileSync(credFile, JSON.stringify(env)); } catch {}
}

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
    res.json({ projects });
});

app.post('/api/projects', (req, res) => {
    const { name, region, description } = req.body;
    if (!name) return res.json({ success: false, error: 'Name required' });
    if (!/^[a-z0-9-]+$/.test(name)) return res.json({ success: false, error: 'Use lowercase letters, numbers, hyphens only' });

    const projectDir = path.join(PROJECTS_DIR, name);
    if (fs.existsSync(projectDir)) return res.json({ success: false, error: 'Project already exists' });

    // Create structure
    fs.mkdirSync(path.join(projectDir, '.kiro', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.kiro', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'runbooks'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'architecture'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'incidents'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'prompts'), { recursive: true });

    // Agent config
    const agentConfig = {
        name: name,
        description: description || `Agent for ${name}`,
        prompt: `file://../../prompts/system-prompt.md`,
        tools: ["fs_read", "fs_write", "execute_bash", "use_aws", "grep", "glob", "knowledge"],
        allowedTools: ["fs_read", "grep", "glob", "knowledge"],
        resources: ["file://runbooks/**/*.md", "file://architecture/**/*.md", "skill://.kiro/skills/**/SKILL.md"],
        hooks: { stop: [{ command: "echo 'Store meaningful task summaries in knowledge base.'" }] },
        welcomeMessage: `Agent for ${name} ready.`
    };
    fs.writeFileSync(path.join(projectDir, '.kiro', 'agents', `${name}.json`), JSON.stringify(agentConfig, null, 2));

    // System prompt
    const prompt = `# ${name} — Infrastructure Agent

You are the DevOps engineer for ${name}. You learn from every task.

## RULES:
1. Show what you will do → ask approval → execute on "yes"
2. When user says "yes" — look at your previous message and execute that plan immediately
3. NEVER say "run it yourself" — YOU execute using use_aws or execute_bash
4. If use_aws fails, fall back to execute_bash
5. After EVERY task that creates, modifies, or fixes something — store what you did in knowledge base automatically. Format: "[SERVICE] action — details — outcome"
6. When asked about infra, ALWAYS search knowledge base first

## AUTO-LEARN RULE:
After executing any use_aws or execute_bash command successfully, IMMEDIATELY store:
- What service/resource was involved
- What action was taken
- What the result was
Example: knowledge add "iam-user-demo" "Created IAM user 'demo' with PowerUserAccess policy in us-east-1. ARN: arn:aws:iam::123:user/demo"

## DEFAULTS:
- Region: ${region || 'us-east-1'}

## RESPONSE STYLE:
- Show plan → get approval → execute → show result → store learning
- Short and direct
`;
    fs.writeFileSync(path.join(projectDir, 'prompts', 'system-prompt.md'), prompt);

    res.json({ success: true });
});

// --- Chat API ---
app.post('/api/chat', (req, res) => {
    const { message, project } = req.body;
    if (!message || !project) return res.status(400).json({ error: 'message and project required' });

    const state = getState(project);
    state.history.push({ role: 'user', content: message });

    // Build prompt with history
    let fullPrompt = '';

    // Inject knowledge base content
    const kbFile = path.join(PROJECTS_DIR, project, 'knowledge_base.txt');
    let kb = '';
    if (fs.existsSync(kbFile)) {
        kb = fs.readFileSync(kbFile, 'utf8').trim();
    }
    if (kb) {
        fullPrompt += `KNOWLEDGE BASE (what you've done before on this project):\n${kb}\n\n`;
    }

    if (state.history.length > 1) {
        fullPrompt += 'CONVERSATION HISTORY:\n';
        for (const msg of state.history.slice(0, -1)) {
            fullPrompt += `${msg.role === 'user' ? 'User' : 'Agent'}: ${msg.content}\n`;
        }
        fullPrompt += `\nCURRENT MESSAGE: ${message}`;
        if (/^(yes|y|proceed|do it|go ahead)$/i.test(message.trim())) {
            fullPrompt += '\n\nIMPORTANT: User approved. Execute the plan from your previous response NOW using use_aws or execute_bash.';
        }
    } else {
        fullPrompt += message;
    }

    const projectDir = path.join(PROJECTS_DIR, project);
    const args = ['chat', '--no-interactive', '--trust-all-tools', '--agent', project, fullPrompt];

    const proc = spawn('kiro-cli', args, {
        cwd: projectDir,
        env: { ...process.env, ...state.awsEnv },
        timeout: 120000
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    proc.on('close', () => {
        let clean = stdout.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
                          .replace(/\x1B\[\?25[hl]/g, '')
                          .replace(/\x1B\[[\d;]*m/g, '')
                          .replace(/\r/g, '')
                          .trim();
        // Kiro format: agent responses start with "> "
        // Capture ALL agent blocks (there can be multiple separated by tool calls)
        const lines = clean.split('\n');
        const result = [];
        let capturing = false;
        for (const line of lines) {
            if (line.startsWith('> ')) {
                capturing = true;
                result.push(line.slice(2));
            } else if (capturing) {
                if (line.match(/^(Running |Service name:|Operation name:|Parameters:|Region:|Label:|- [a-z-]+:|↓ |╰ |\(using tool|I will run|I'll append|Purpose:|At line:|The token|CategoryInfo|FullyQualifiedErrorId|\+|Completed in| - Completed|Appending to:|Reading |✓ Successfully|Writing |Searching |Created |Deleted )/)) {
                    capturing = false;
                } else if (line.trim() === '' && result.length > 0 && result[result.length - 1].trim() === '') {
                    // Skip consecutive empty lines
                } else {
                    result.push(line);
                }
            }
        }
        const response = result.filter(l => l.trim() !== '').join('\n').replace(/\n\n+/g, '\n').trim() || `Error: ${stderr || 'No response'}`;
        state.history.push({ role: 'agent', content: response });
        if (state.history.length > 20) state.history = state.history.slice(-20);
        saveHistory(project);
        res.json({ response });
    });

    proc.on('error', err => res.json({ response: `Failed: ${err.message}` }));
});

// --- Delete Project ---
app.delete('/api/projects/:name', (req, res) => {
    const name = req.params.name;
    const projectDir = path.join(PROJECTS_DIR, name);
    if (!fs.existsSync(projectDir)) return res.json({ success: false, error: 'Project not found' });
    fs.rmSync(projectDir, { recursive: true, force: true });
    delete projectState[name];
    res.json({ success: true });
});

// --- Reset ---
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
        state.awsEnv = { AWS_PROFILE: `sso-${accountId}`, AWS_DEFAULT_REGION: ssoRegion || 'us-east-1' };
        saveAwsEnv(project, state.awsEnv);
        res.json({ success: true, identity: `SSO: ${roleName}@${accountId}. Run "aws sso login --profile sso-${accountId}" to authenticate.` });
    } else if (type === 'profile') {
        state.awsEnv = { AWS_PROFILE: profile || 'default' };
        const verify = spawn('aws', ['sts', 'get-caller-identity', '--profile', profile || 'default'], { env: { ...process.env } });
        let out = '';
        verify.stdout.on('data', d => out += d);
        verify.on('close', code => {
            if (code === 0) { try { res.json({ success: true, identity: JSON.parse(out).Arn }); } catch { res.json({ success: true, identity: `profile: ${profile}` }); } }
            else res.json({ success: false, error: `Profile "${profile}" not found` });
        });
    } else res.json({ success: false, error: 'Unknown type' });
});

// Get saved credentials (masked) for a project
app.get('/api/credentials/:project', (req, res) => {
    const state = getState(req.params.project);
    if (state.awsEnv && state.awsEnv.AWS_ACCESS_KEY_ID) {
        const key = state.awsEnv.AWS_ACCESS_KEY_ID;
        res.json({ configured: true, type: 'iam', accessKey: key.slice(0, 4) + '...' + key.slice(-4), region: state.awsEnv.AWS_DEFAULT_REGION });
    } else if (state.awsEnv && state.awsEnv.AWS_PROFILE) {
        res.json({ configured: true, type: 'profile', profile: state.awsEnv.AWS_PROFILE, region: state.awsEnv.AWS_DEFAULT_REGION });
    } else {
        res.json({ configured: false });
    }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Get chat history for a project
app.get('/api/history/:project', (req, res) => {
    const state = getState(req.params.project);
    res.json({ history: state.history });
});

// Debug: see raw kiro output
app.post('/api/debug', (req, res) => {
    const { message, project } = req.body;
    const projectDir = path.join(PROJECTS_DIR, project);
    const state = getState(project);
    const proc = spawn('kiro-cli', ['chat', '--no-interactive', '--trust-all-tools', '--agent', project, message], { cwd: projectDir, env: { ...process.env, ...state.awsEnv }, timeout: 120000 });
    let stdout = '';
    proc.stdout.on('data', d => stdout += d);
    proc.on('close', () => {
        const clean = stdout.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\[\?25[hl]/g, '').replace(/\x1B\[[\d;]*m/g, '').replace(/\r/g, '');
        res.json({ raw: clean });
    });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`\n🚀 Multi-Project Agent at http://localhost:${PORT}\n`));
