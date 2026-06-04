import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import { join, dirname, resolve as pathResolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

// Compressão gzip/brotli — importado dinamicamente para não quebrar se ausente
let compression;
try { ({ default: compression } = await import('compression')); } catch { compression = null; }

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'orcamento-secret-key-mude-em-producao';
const USE_PG = !!process.env.DATABASE_URL;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ── Nodemailer (carregado dinamicamente) ──────────────────────
let mailerTransport = null;
async function getMailer() {
  if (mailerTransport) return mailerTransport;
  try {
    const { default: nodemailer } = await import('nodemailer');
    mailerTransport = nodemailer.createTransport({
      host:   process.env.SMTP_HOST || 'smtp.gmail.com',
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    return mailerTransport;
  } catch { return null; }
}

async function sendResetEmail(email, name, token) {
  const link = `${APP_URL}/?reset=${token}`;
  const mailer = await getMailer();
  if (!mailer || !process.env.SMTP_USER) {
    // Dev fallback: log no console
    console.log(`\n🔑 RESET LINK (dev): ${link}\n`);
    return;
  }
  await mailer.sendMail({
    from: `"Orçamento Pessoal" <${process.env.SMTP_USER}>`,
    to: email,
    subject: '🔑 Recuperação de senha — Orçamento Pessoal',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#2e7d32">Recuperar senha</h2>
        <p>Olá, <strong>${name}</strong>!</p>
        <p>Clique no botão abaixo para redefinir sua senha. O link expira em <strong>1 hora</strong>.</p>
        <a href="${link}" style="display:inline-block;margin:1rem 0;padding:.75rem 1.5rem;background:#2e7d32;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Redefinir senha</a>
        <p style="color:#666;font-size:.85rem">Se você não solicitou isso, ignore este e-mail.</p>
        <p style="color:#aaa;font-size:.8rem">Link: ${link}</p>
      </div>`,
  });
}

// ── Database adapter: PostgreSQL (produção) ou SQLite (local) ─
let pool, sqlite;

if (USE_PG) {
  const { default: pg } = await import('pg');
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  console.log('🐘 Usando PostgreSQL');
} else {
  const { DatabaseSync } = await import('node:sqlite');
  const DB_DIR  = process.env.DB_PATH ? dirname(process.env.DB_PATH) : __dirname;
  const DB_FILE = process.env.DB_PATH || join(__dirname, 'orcamento.db');
  try { mkdirSync(DB_DIR, { recursive: true }); } catch {}
  sqlite = new DatabaseSync(DB_FILE);
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  console.log(`🗄️  Usando SQLite: ${DB_FILE}`);
}

// ? → $1,$2... (só para PostgreSQL)
function pq(sql) { let i=0; return USE_PG ? sql.replace(/\?/g, ()=>`$${++i}`) : sql; }

// Unified DB helpers
async function dbGet(sql, p=[]) {
  if (USE_PG) { const r=await pool.query(pq(sql),p); return r.rows[0]||null; }
  return sqlite.prepare(sql).get(...p) || null;
}
async function dbAll(sql, p=[]) {
  if (USE_PG) { const r=await pool.query(pq(sql),p); return r.rows; }
  return sqlite.prepare(sql).all(...p);
}
async function dbRun(sql, p=[]) {
  if (USE_PG) return pool.query(pq(sql),p);
  return sqlite.prepare(sql).run(...p);
}
async function dbInsert(sql, p=[]) {
  if (USE_PG) {
    const s=pq(sql);
    const r=await pool.query(s.includes('RETURNING')?s:s+' RETURNING id',p);
    return { lastInsertRowid: r.rows[0]?.id };
  }
  const r=sqlite.prepare(sql).run(...p);
  return { lastInsertRowid: r.lastInsertRowid };
}
async function dbExec(sql) {
  if (USE_PG) {
    const stmts=sql.split(';').map(s=>s.trim()).filter(Boolean);
    for (const s of stmts) { try { await pool.query(s); } catch(e) { if(!e.message.includes('already exists')) throw e; } }
  } else {
    sqlite.exec(sql);
  }
}
// Raw query for dynamic SQL (PostgreSQL) or fallback to dbAll (SQLite with ? params)
async function rawQuery(sql, p=[]) {
  if (USE_PG) { const r=await pool.query(sql,p); return r.rows; }
  // For SQLite: sql already has ? placeholders
  return sqlite.prepare(sql).all(...p);
}
async function rawRun(sql, p=[]) {
  if (USE_PG) return pool.query(sql,p);
  return sqlite.prepare(sql).run(...p);
}

// ── effective month expression (adapts to DB engine) ─────────
const effMonth = (alias='') => {
  const f = alias ? alias+'.' : '';
  return USE_PG
    ? `COALESCE(${f}competence_month, to_char(${f}date::date,'YYYY-MM'))`
    : `COALESCE(${f}competence_month, strftime('%Y-%m',${f}date))`;
};

// ── Schema ────────────────────────────────────────────────────
const idType  = USE_PG ? 'SERIAL'  : 'INTEGER';
const idExtra = USE_PG ? ''        : ' AUTOINCREMENT';
const nowExpr = USE_PG ? "to_char(now(),'YYYY-MM-DD HH24:MI:SS')" : "(datetime('now'))";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS users (id ${idType} PRIMARY KEY${idExtra}, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, is_admin INT NOT NULL DEFAULT 0, must_change_password INT NOT NULL DEFAULT 0, is_active INT NOT NULL DEFAULT 1, created_at TEXT DEFAULT ${nowExpr})`,
  `CREATE TABLE IF NOT EXISTS payment_methods (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'credito', color TEXT NOT NULL DEFAULT '#2e7d32', created_at TEXT DEFAULT ${nowExpr}, UNIQUE(user_id,name))`,
  `CREATE TABLE IF NOT EXISTS recurring_templates (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, description TEXT NOT NULL, category TEXT NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, note TEXT DEFAULT '', payment_type TEXT DEFAULT 'dinheiro', payment_method_id INT REFERENCES payment_methods(id) ON DELETE SET NULL, active INT NOT NULL DEFAULT 1, start_month TEXT NOT NULL, created_at TEXT DEFAULT ${nowExpr})`,
  `CREATE TABLE IF NOT EXISTS recurring_skips (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, recurring_template_id INT NOT NULL REFERENCES recurring_templates(id) ON DELETE CASCADE, skip_month TEXT NOT NULL, created_at TEXT DEFAULT ${nowExpr}, UNIQUE(user_id,recurring_template_id,skip_month))`,
  `CREATE TABLE IF NOT EXISTS transactions (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, note TEXT DEFAULT '', payment_method_id INT REFERENCES payment_methods(id) ON DELETE SET NULL, payment_type TEXT DEFAULT 'dinheiro', installments INT DEFAULT 1, installment_number INT DEFAULT 1, group_id TEXT, recurring_template_id INT REFERENCES recurring_templates(id) ON DELETE SET NULL, competence_month TEXT, created_at TEXT DEFAULT ${nowExpr})`,
  `CREATE TABLE IF NOT EXISTS category_limits (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, category TEXT NOT NULL, limit_amount REAL NOT NULL DEFAULT 0, UNIQUE(user_id,category))`,
  `CREATE TABLE IF NOT EXISTS goals (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT DEFAULT '', target_amount REAL NOT NULL, saved_amount REAL NOT NULL DEFAULT 0, deadline TEXT, created_at TEXT DEFAULT ${nowExpr})`,
  `CREATE TABLE IF NOT EXISTS savings_accounts (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT DEFAULT '', color TEXT NOT NULL DEFAULT '#1b5e20', created_at TEXT DEFAULT ${nowExpr}, UNIQUE(user_id,name))`,
  `CREATE TABLE IF NOT EXISTS savings_deposits (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_id INT NOT NULL REFERENCES savings_accounts(id) ON DELETE CASCADE, amount REAL NOT NULL, date TEXT NOT NULL, note TEXT DEFAULT '', transaction_id INT REFERENCES transactions(id) ON DELETE SET NULL, created_at TEXT DEFAULT ${nowExpr})`,
  `CREATE TABLE IF NOT EXISTS password_reset_tokens (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used INT NOT NULL DEFAULT 0, created_at TEXT DEFAULT ${nowExpr})`,
  `CREATE TABLE IF NOT EXISTS reminders (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, remind_at TEXT NOT NULL, done INT NOT NULL DEFAULT 0, cancelled INT NOT NULL DEFAULT 0, created_at TEXT DEFAULT ${nowExpr})`,
  `CREATE TABLE IF NOT EXISTS shopping_items (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, month TEXT NOT NULL, name TEXT NOT NULL, quantity TEXT DEFAULT '', purchased INT NOT NULL DEFAULT 0, created_at TEXT DEFAULT ${nowExpr})`,
  `CREATE TABLE IF NOT EXISTS shopping_shares (id ${idType} PRIMARY KEY${idExtra}, owner_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, shared_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT DEFAULT ${nowExpr}, UNIQUE(owner_id,shared_user_id))`,
  `CREATE TABLE IF NOT EXISTS user_charges (id ${idType} PRIMARY KEY${idExtra}, requester_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, recipient_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, description TEXT NOT NULL, charge_type TEXT NOT NULL, amount REAL NOT NULL, due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', expense_transaction_id INT REFERENCES transactions(id) ON DELETE SET NULL, income_transaction_id INT REFERENCES transactions(id) ON DELETE SET NULL, responded_at TEXT, created_at TEXT DEFAULT ${nowExpr})`
];
for (const t of TABLES) await dbExec(t);

// ── Índices para acelerar queries frequentes ──────────────────
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_tx_user_month      ON transactions(user_id, competence_month, date)',
  'CREATE INDEX IF NOT EXISTS idx_tx_user_pm         ON transactions(user_id, payment_method_id)',
  'CREATE INDEX IF NOT EXISTS idx_tx_recurring       ON transactions(recurring_template_id, user_id)',
  'CREATE INDEX IF NOT EXISTS idx_tx_group           ON transactions(group_id)',
  'CREATE INDEX IF NOT EXISTS idx_pm_user            ON payment_methods(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_savings_user       ON savings_accounts(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_deposits_account   ON savings_deposits(account_id, user_id)',
  'CREATE INDEX IF NOT EXISTS idx_skips_template     ON recurring_skips(user_id, recurring_template_id, skip_month)',
  'CREATE INDEX IF NOT EXISTS idx_reset_token        ON password_reset_tokens(token)',
  'CREATE INDEX IF NOT EXISTS idx_shopping_user_month ON shopping_items(user_id, month, purchased)',
  'CREATE INDEX IF NOT EXISTS idx_shopping_shares_user ON shopping_shares(shared_user_id, owner_id)',
  'CREATE INDEX IF NOT EXISTS idx_charges_recipient_status ON user_charges(recipient_id, status, due_date)',
  'CREATE INDEX IF NOT EXISTS idx_charges_requester ON user_charges(requester_id, created_at)',
];
for (const idx of INDEXES) { try { await dbExec(idx); } catch { /* já existe */ } }

if (USE_PG) {
  await dbExec(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin INT NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password INT NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active INT NOT NULL DEFAULT 1;
  `);
}

// SQLite migrations for existing databases
if (!USE_PG) {
  const existingCols = sqlite.prepare("PRAGMA table_info(transactions)").all().map(c=>c.name);
  const migrations = [
    ['payment_method_id',    'ALTER TABLE transactions ADD COLUMN payment_method_id INT REFERENCES payment_methods(id) ON DELETE SET NULL'],
    ['payment_type',         'ALTER TABLE transactions ADD COLUMN payment_type TEXT DEFAULT "dinheiro"'],
    ['installments',         'ALTER TABLE transactions ADD COLUMN installments INT DEFAULT 1'],
    ['installment_number',   'ALTER TABLE transactions ADD COLUMN installment_number INT DEFAULT 1'],
    ['group_id',             'ALTER TABLE transactions ADD COLUMN group_id TEXT'],
    ['recurring_template_id','ALTER TABLE transactions ADD COLUMN recurring_template_id INT REFERENCES recurring_templates(id) ON DELETE SET NULL'],
    ['competence_month',     'ALTER TABLE transactions ADD COLUMN competence_month TEXT'],
  ];
  for (const [col,sql] of migrations) {
    if (!existingCols.includes(col)) { sqlite.exec(sql); console.log(`Migration: +${col}`); }
  }
  const userCols = sqlite.prepare("PRAGMA table_info(users)").all().map(c=>c.name);
  const userMigrations = [
    ['is_admin', 'ALTER TABLE users ADD COLUMN is_admin INT NOT NULL DEFAULT 0'],
    ['must_change_password', 'ALTER TABLE users ADD COLUMN must_change_password INT NOT NULL DEFAULT 0'],
    ['is_active', 'ALTER TABLE users ADD COLUMN is_active INT NOT NULL DEFAULT 1'],
  ];
  for (const [col,sql] of userMigrations) {
    if (!userCols.includes(col)) { sqlite.exec(sql); console.log(`Migration users: +${col}`); }
  }
}
const adminCount = await dbGet('SELECT COUNT(*) as total FROM users WHERE is_admin=1');
const userCount = await dbGet('SELECT COUNT(*) as total FROM users');
if (parseInt(userCount?.total || 0) > 0 && parseInt(adminCount?.total || 0) === 0) {
  const firstUser = await dbGet('SELECT id FROM users ORDER BY id LIMIT 1');
  if (firstUser) await dbRun('UPDATE users SET is_admin=1 WHERE id=?',[firstUser.id]);
}
console.log('✅ Schema pronto');

// ── Recurring helper ──────────────────────────────────────────
async function ensureRecurring(userId, month) {
  const templates = await dbAll(
    'SELECT * FROM recurring_templates WHERE user_id=? AND active=1 AND start_month<=?',
    [userId, month]
  );
  for (const t of templates) {
    const skipped = await dbGet(
      'SELECT id FROM recurring_skips WHERE user_id=? AND recurring_template_id=? AND skip_month=?',
      [userId, t.id, month]
    );
    if (skipped) continue;
    const ex = await dbGet(
      `SELECT id FROM transactions WHERE user_id=? AND recurring_template_id=? AND ${effMonth()}=?`,
      [userId, t.id, month]
    );
    if (!ex) await dbInsert(
      'INSERT INTO transactions (user_id,date,description,category,type,amount,note,payment_type,payment_method_id,installments,installment_number,recurring_template_id) VALUES (?,?,?,?,?,?,?,?,?,1,1,?)',
      [userId, month+'-01', t.description, t.category, t.type, t.amount, t.note||'', t.payment_type||'dinheiro', t.payment_method_id||null, t.id]
    );
  }
}

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
if (compression) app.use(compression()); // gzip todas as respostas
app.use(express.json());
// Cache longo para assets estáticos com hash (vendor/css/js)
app.use('/css',    express.static(join(__dirname,'public','css'),    { maxAge:'7d', etag:true }));
app.use('/js',     express.static(join(__dirname,'public','js'),     { maxAge:'1d', etag:true }));
app.use('/vendor', express.static(join(__dirname,'public','vendor'), { maxAge:'30d', etag:true }));
app.use(express.static(join(__dirname, 'public'), { etag:true }));

async function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error:'Token necessário' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    const user = await dbGet('SELECT is_active FROM users WHERE id=?',[req.user.id]);
    if (!user?.is_active) return res.status(403).json({error:'Usuário inativo. Procure o administrador.'});
    next();
  }
  catch { res.status(401).json({ error:'Token inválido' }); }
}
async function requireAdmin(req, res, next) {
  const user = await dbGet('SELECT is_admin,is_active FROM users WHERE id=?',[req.user.id]);
  if (!user?.is_admin || !user?.is_active) return res.status(403).json({error:'Acesso restrito ao administrador'});
  next();
}
function tempPassword() {
  return Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

// ── Auth ──────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body||{};
  if (!name||!email||!password) return res.status(400).json({ error:'Campos obrigatórios' });
  if (password.length<6) return res.status(400).json({ error:'Senha mínima: 6 caracteres' });
  try {
    const hash = bcrypt.hashSync(password,10);
    const count = await dbGet('SELECT COUNT(*) as total FROM users');
    const isAdmin = parseInt(count?.total || 0) === 0 ? 1 : 0;
    const r = await dbInsert('INSERT INTO users (name,email,password,is_admin) VALUES (?,?,?,?)', [name,email.toLowerCase(),hash,isAdmin]);
    const uid = r.lastInsertRowid;
    const cats = ['Moradia','Alimentação','Transporte','Saúde','Educação','Lazer','Vestuário','Contas','Outros'];
    const defs = [1200,600,300,350,200,200,150,300,150];
    for (let i=0;i<cats.length;i++)
      await dbRun('INSERT INTO category_limits (user_id,category,limit_amount) VALUES (?,?,?) ON CONFLICT DO NOTHING',[uid,cats[i],defs[i]]);
    const token = jwt.sign({id:uid,name,email:email.toLowerCase(),is_admin:isAdmin},JWT_SECRET,{expiresIn:'30d'});
    res.json({token,user:{id:uid,name,email:email.toLowerCase(),is_admin:isAdmin,must_change_password:0}});
  } catch(e) {
    if (e.code==='23505') return res.status(400).json({error:'E-mail já cadastrado'});
    console.error(e); res.status(500).json({error:'Erro interno'});
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body||{};
  const user = await dbGet('SELECT * FROM users WHERE email=?',[email?.toLowerCase()]);
  if (!user||!bcrypt.compareSync(password,user.password))
    return res.status(401).json({error:'E-mail ou senha incorretos'});
  if (!user.is_active) return res.status(403).json({error:'Usuário inativo. Procure o administrador.'});
  const token = jwt.sign({id:user.id,name:user.name,email:user.email,is_admin:user.is_admin},JWT_SECRET,{expiresIn:'30d'});
  res.json({token,user:{id:user.id,name:user.name,email:user.email,is_admin:user.is_admin,must_change_password:user.must_change_password}});
});

// ── Forgot / Reset password ───────────────────────────────────
app.post('/api/forgot-password', async (req,res) => {
  const { email } = req.body||{};
  if (!email) return res.status(400).json({error:'E-mail obrigatório'});
  const user = await dbGet('SELECT id,name,email FROM users WHERE email=? AND is_active=1',[email.toLowerCase()]);
  // Sempre retorna 200 para não revelar se o e-mail existe
  if (!user) return res.json({ok:true});
  // Gera token único (32 bytes hex)
  const { randomBytes } = await import('crypto');
  const token = randomBytes(32).toString('hex');
  // Expira em 1 hora
  const expiresAt = USE_PG
    ? `NOW() + INTERVAL '1 hour'`
    : `datetime('now','+1 hour')`;
  // Invalida tokens anteriores deste usuário
  await dbRun('DELETE FROM password_reset_tokens WHERE user_id=?',[user.id]);
  if (USE_PG) {
    await rawQuery(`INSERT INTO password_reset_tokens (user_id,token,expires_at) VALUES ($1,$2,${expiresAt})`,[user.id,token]);
  } else {
    await dbInsert(`INSERT INTO password_reset_tokens (user_id,token,expires_at) VALUES (?,?,${expiresAt})`,[user.id,token]);
  }
  try { await sendResetEmail(user.email, user.name, token); } catch(e) { console.error('Erro ao enviar e-mail:', e.message); }
  res.json({ok:true});
});

app.post('/api/reset-password', async (req,res) => {
  const {token, password} = req.body||{};
  if (!token||!password||password.length<6) return res.status(400).json({error:'Dados inválidos'});
  const nowExprCheck = USE_PG ? 'NOW()' : "datetime('now')";
  const row = USE_PG
    ? (await rawQuery(`SELECT prt.*,u.id as uid FROM password_reset_tokens prt JOIN users u ON u.id=prt.user_id WHERE prt.token=$1 AND prt.used=0 AND prt.expires_at > ${nowExprCheck}`, [token]))[0]
    : await dbGet(`SELECT prt.*,u.id as uid FROM password_reset_tokens prt JOIN users u ON u.id=prt.user_id WHERE prt.token=? AND prt.used=0 AND prt.expires_at > ${nowExprCheck}`, [token]);
  if (!row) return res.status(400).json({error:'Link inválido ou expirado'});
  const hash = bcrypt.hashSync(password,10);
  await dbRun('UPDATE users SET password=?,must_change_password=0 WHERE id=?',[hash,row.user_id||row.uid]);
  await dbRun('UPDATE password_reset_tokens SET used=1 WHERE token=?',[token]);
  res.json({ok:true});
});

app.get('/api/me', auth, async (req,res) => {
  const user = await dbGet('SELECT id,name,email,is_admin,must_change_password,created_at FROM users WHERE id=?',[req.user.id]);
  res.json(user);
});
app.put('/api/change-password', auth, async (req,res) => {
  const {current_password,new_password}=req.body||{};
  if (!new_password || new_password.length<6) return res.status(400).json({error:'Senha mínima: 6 caracteres'});
  const user = await dbGet('SELECT * FROM users WHERE id=?',[req.user.id]);
  if (!user) return res.status(404).json({error:'Usuário não encontrado'});
  if (!user.must_change_password && !bcrypt.compareSync(current_password||'',user.password))
    return res.status(401).json({error:'Senha atual incorreta'});
  const hash=bcrypt.hashSync(new_password,10);
  await dbRun('UPDATE users SET password=?,must_change_password=0 WHERE id=?',[hash,req.user.id]);
  res.json({ok:true});
});
app.get('/api/users', auth, requireAdmin, async (req,res) => {
  res.json(await dbAll('SELECT id,name,email,is_admin,must_change_password,is_active,created_at FROM users ORDER BY name'));
});
app.post('/api/users', auth, requireAdmin, async (req,res) => {
  const {name,email,is_admin}=req.body||{};
  if (!name||!email) return res.status(400).json({error:'Nome e e-mail obrigatórios'});
  const password=tempPassword();
  const hash=bcrypt.hashSync(password,10);
  try {
    const r=await dbInsert('INSERT INTO users (name,email,password,is_admin,must_change_password) VALUES (?,?,?,?,1)',[name,email.toLowerCase(),hash,is_admin?1:0]);
    res.json({id:r.lastInsertRowid,temp_password:password});
  } catch(e) {
    if (e.code==='23505') return res.status(400).json({error:'E-mail já cadastrado'});
    res.status(500).json({error:'Erro interno'});
  }
});
app.put('/api/users/:id/temp-password', auth, requireAdmin, async (req,res) => {
  const user = await dbGet('SELECT id FROM users WHERE id=?',[req.params.id]);
  if (!user) return res.status(404).json({error:'Usuário não encontrado'});
  const password=tempPassword();
  const hash=bcrypt.hashSync(password,10);
  await dbRun('UPDATE users SET password=?,must_change_password=1 WHERE id=?',[hash,req.params.id]);
  res.json({temp_password:password});
});
app.put('/api/users/:id/admin', auth, requireAdmin, async (req,res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({error:'Não altere seu próprio perfil de administrador'});
  await dbRun('UPDATE users SET is_admin=? WHERE id=?',[req.body?.is_admin?1:0,req.params.id]);
  res.json({ok:true});
});

// ── Payment Methods ───────────────────────────────────────────
app.get('/api/payment-methods', auth, async (req,res) => {
  res.json(await dbAll('SELECT * FROM payment_methods WHERE user_id=? ORDER BY name',[req.user.id]));
});
app.post('/api/payment-methods', auth, async (req,res) => {
  const {name,type,color}=req.body||{};
  if (!name) return res.status(400).json({error:'Nome obrigatório'});
  try {
    const r=await dbInsert('INSERT INTO payment_methods (user_id,name,type,color) VALUES (?,?,?,?)',[req.user.id,name,type||'credito',color||'#1565c8']);
    res.json({id:r.lastInsertRowid});
  } catch(e) {
    if(e.code==='23505') return res.status(400).json({error:'Já existe um cartão com esse nome'});
    res.status(500).json({error:'Erro interno'});
  }
});
app.put('/api/payment-methods/:id', auth, async (req,res) => {
  const pm=await dbGet('SELECT id FROM payment_methods WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!pm) return res.status(404).json({error:'Não encontrado'});
  const {name,type,color}=req.body||{};
  await dbRun('UPDATE payment_methods SET name=?,type=?,color=? WHERE id=?',[name,type,color,req.params.id]);
  res.json({ok:true});
});
app.delete('/api/payment-methods/:id', auth, async (req,res) => {
  const pm=await dbGet('SELECT id FROM payment_methods WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!pm) return res.status(404).json({error:'Não encontrado'});
  await dbRun('DELETE FROM payment_methods WHERE id=?',[req.params.id]);
  res.json({ok:true});
});
app.get('/api/payment-methods/totals', auth, async (req,res) => {
  const {month,kind}=req.query;
  const txType = kind === 'income' ? 'Receita' : 'Despesa';
  const pmTypeFilter = kind === 'income' ? "AND pm.type='receita'" : "AND pm.type IN ('credito','debito')";
  if (USE_PG) {
    const p=[req.user.id, month||null];
    const rows=await rawQuery(`SELECT pm.id,pm.name,pm.type,pm.color,COALESCE(SUM(t.amount),0) as total,COUNT(t.id) as count FROM payment_methods pm LEFT JOIN transactions t ON t.payment_method_id=pm.id AND t.type='${txType}' AND ($2::text IS NULL OR ${effMonth('t')}=$2) WHERE pm.user_id=$1 ${pmTypeFilter} GROUP BY pm.id ORDER BY total DESC`,p);
    return res.json(rows);
  }
  // SQLite
  const mf = month ? `AND ${effMonth('t')}='${month}'` : '';
  const rows=await rawQuery(`SELECT pm.id,pm.name,pm.type,pm.color,COALESCE(SUM(t.amount),0) as total,COUNT(t.id) as count FROM payment_methods pm LEFT JOIN transactions t ON t.payment_method_id=pm.id AND t.type='${txType}' ${mf} WHERE pm.user_id=? ${pmTypeFilter} GROUP BY pm.id ORDER BY total DESC`,[req.user.id]);
  res.json(rows);
});

// ── Transactions ──────────────────────────────────────────────
// Busca uma única transação por ID
app.get('/api/transactions/:id', auth, async (req,res) => {
  const sql = USE_PG
    ? `SELECT t.*, pm.name as pm_name, pm.color as pm_color, pm.type as pm_type FROM transactions t LEFT JOIN payment_methods pm ON pm.id=t.payment_method_id WHERE t.id=$1 AND t.user_id=$2`
    : `SELECT t.*, pm.name as pm_name, pm.color as pm_color, pm.type as pm_type FROM transactions t LEFT JOIN payment_methods pm ON pm.id=t.payment_method_id WHERE t.id=? AND t.user_id=?`;
  const row = await dbGet(sql, [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({error:'Não encontrado'});
  res.json(row);
});

app.get('/api/transactions', auth, async (req,res) => {
  const {month,payment_method_id}=req.query;
  if (month) await ensureRecurring(req.user.id,month);
  if (USE_PG) {
    const p=[req.user.id, month||null, payment_method_id ? parseInt(payment_method_id) : null];
    const rows=await rawQuery(`SELECT t.*, pm.name as pm_name, pm.color as pm_color, pm.type as pm_type, ${effMonth('t')} as effective_month FROM transactions t LEFT JOIN payment_methods pm ON pm.id=t.payment_method_id WHERE t.user_id=$1 AND ($2::text IS NULL OR ${effMonth('t')}=$2) AND ($3::int IS NULL OR t.payment_method_id=$3) ORDER BY t.date DESC, t.id DESC`,p);
    return res.json(rows);
  }
  // SQLite
  let sql=`SELECT t.*, pm.name as pm_name, pm.color as pm_color, pm.type as pm_type, ${effMonth('t')} as effective_month FROM transactions t LEFT JOIN payment_methods pm ON pm.id=t.payment_method_id WHERE t.user_id=?`;
  const p=[req.user.id];
  if (month) { sql+=` AND ${effMonth('t')}=?`; p.push(month); }
  if (payment_method_id) { sql+=` AND t.payment_method_id=?`; p.push(parseInt(payment_method_id)); }
  sql+=' ORDER BY t.date DESC, t.id DESC';
  res.json(await rawQuery(sql,p));
});

app.post('/api/transactions', auth, async (req,res) => {
  const {date,description,category,type,amount,note,
         payment_type,payment_method_id,installments,is_fixed,competence_month,amount_mode}=req.body||{};
  if (!date||!description||!category||!type||!amount)
    return res.status(400).json({error:'Campos obrigatórios'});
  const val=parseFloat(amount), nInst=Math.min(Math.max(parseInt(installments)||1,1),24);
  const pmId=payment_method_id||null, ptype=payment_type||'dinheiro';
  const month=date.slice(0,7);
  const comp=(competence_month&&competence_month!==month)?competence_month:null;

  if (is_fixed) {
    const tmpl=await dbInsert('INSERT INTO recurring_templates (user_id,description,category,type,amount,note,payment_type,payment_method_id,start_month) VALUES (?,?,?,?,?,?,?,?,?)',
      [req.user.id,description,category,type,val,note||'',ptype,pmId,month]);
    const r=await dbInsert('INSERT INTO transactions (user_id,date,description,category,type,amount,note,payment_type,payment_method_id,installments,installment_number,recurring_template_id,competence_month) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?)',
      [req.user.id,date,description,category,type,val,note||'',ptype,pmId,tmpl.lastInsertRowid,comp]);
    return res.json({id:r.lastInsertRowid,is_fixed:true,template_id:tmpl.lastInsertRowid});
  }
  if (nInst<=1) {
    const r=await dbInsert('INSERT INTO transactions (user_id,date,description,category,type,amount,note,payment_type,payment_method_id,installments,installment_number,competence_month) VALUES (?,?,?,?,?,?,?,?,?,1,1,?)',
      [req.user.id,date,description,category,type,val,note||'',ptype,pmId,comp]);
    return res.json({id:r.lastInsertRowid,installments:1});
  }
  const groupId=`grp-${req.user.id}-${Date.now()}`;
  const installAmt=amount_mode === 'parcel' ? Math.round(val*100)/100 : Math.round((val/nInst)*100)/100;
  const ids=[], [y,m2,d2]=date.split('-').map(Number);
  const [cy,cm]=(competence_month||month).split('-').map(Number);
  for (let i=0;i<nInst;i++) {
    const iDate=new Date(y,m2-1+i,d2).toISOString().slice(0,10);
    const iComp=new Date(cy,cm-1+i,1).toISOString().slice(0,7);
    const ic=iComp!==iDate.slice(0,7)?iComp:null;
    const r=await dbInsert('INSERT INTO transactions (user_id,date,description,category,type,amount,note,payment_type,payment_method_id,installments,installment_number,group_id,competence_month) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [req.user.id,iDate,`${description} (${i+1}/${nInst})`,category,type,installAmt,note||'',ptype,pmId,nInst,i+1,groupId,ic]);
    ids.push(r.lastInsertRowid);
  }
  res.json({ids,installments:nInst,group_id:groupId});
});

// Converte um lançamento avulso em fixo (recorrente)
app.post('/api/transactions/:id/make-fixed', auth, async (req,res) => {
  const t = await dbGet('SELECT * FROM transactions WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!t) return res.status(404).json({error:'Não encontrado'});
  if (t.recurring_template_id) return res.status(400).json({error:'Já é um lançamento fixo'});
  const startMonth = (t.competence_month || t.date.slice(0,7));
  const tmpl = await dbInsert(
    'INSERT INTO recurring_templates (user_id,description,category,type,amount,note,payment_type,payment_method_id,start_month) VALUES (?,?,?,?,?,?,?,?,?)',
    [req.user.id, t.description, t.category, t.type, t.amount, t.note||'', t.payment_type||'dinheiro', t.payment_method_id||null, startMonth]
  );
  const templateId = tmpl.lastInsertRowid;
  await dbRun('UPDATE transactions SET recurring_template_id=? WHERE id=?',[templateId, t.id]);
  res.json({ok:true, template_id: templateId});
});

app.put('/api/transactions/:id', auth, async (req,res) => {
  const t=await dbGet('SELECT * FROM transactions WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!t) return res.status(404).json({error:'Não encontrado'});
  const {date,description,category,type,amount,note,payment_type,payment_method_id,update_future,update_installments,competence_month}=req.body||{};
  const val=parseFloat(amount), ptype=payment_type||'dinheiro', pmId=payment_method_id||null;
  const month=(date||t.date).slice(0,7);
  const comp=(competence_month&&competence_month!==month)?competence_month:null;
  if (t.group_id && update_installments) {
    await dbRun(
      'UPDATE transactions SET category=?,type=?,amount=?,note=?,payment_type=?,payment_method_id=? WHERE group_id=? AND user_id=?',
      [category,type,val,note||'',ptype,pmId,t.group_id,req.user.id]
    );
    const groupRows = await dbAll('SELECT id,installment_number FROM transactions WHERE group_id=? AND user_id=? ORDER BY installment_number,id',[t.group_id,req.user.id]);
    const cleanDesc = (description||'').replace(/ \(\d+\/\d+\)$/,'');
    for (const row of groupRows) {
      await dbRun('UPDATE transactions SET description=? WHERE id=?',[`${cleanDesc} (${row.installment_number}/${groupRows.length})`,row.id]);
    }
    return res.json({ok:true,updated_group:true});
  }
  await dbRun('UPDATE transactions SET date=?,description=?,category=?,type=?,amount=?,note=?,payment_type=?,payment_method_id=?,competence_month=? WHERE id=?',
    [date,description,category,type,val,note||'',ptype,pmId,comp,req.params.id]);
  if (t.recurring_template_id&&update_future) {
    await dbRun('UPDATE recurring_templates SET description=?,category=?,type=?,amount=?,note=?,payment_type=?,payment_method_id=? WHERE id=? AND user_id=?',
      [description,category,type,val,note||'',ptype,pmId,t.recurring_template_id,req.user.id]);
    await dbRun(`UPDATE transactions SET description=?,category=?,type=?,amount=?,note=?,payment_type=?,payment_method_id=? WHERE recurring_template_id=? AND user_id=? AND ${effMonth()}>=?`,
      [description,category,type,val,note||'',ptype,pmId,t.recurring_template_id,req.user.id,month]);
  }
  res.json({ok:true});
});

app.delete('/api/transactions/:id', auth, async (req,res) => {
  const t=await dbGet('SELECT * FROM transactions WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!t) return res.status(404).json({error:'Não encontrado'});

  // Excluir todas as parcelas (parcelado)
  if (req.query.all_installments==='1' && t.group_id) {
    await dbRun('DELETE FROM transactions WHERE group_id=? AND user_id=?',[t.group_id,req.user.id]);
    return res.json({ok:true});
  }

  // Cancelar fixo: desativa template + exclui este e todos os futuros
  if (req.query.all_recurring==='1' && t.recurring_template_id) {
    const curMonth = (t.competence_month || t.date.slice(0,7));
    // Desativa o template para não gerar mais instâncias
    await dbRun('UPDATE recurring_templates SET active=0 WHERE id=? AND user_id=?',
      [t.recurring_template_id, req.user.id]);
    // Exclui este mês e todos os meses futuros
    await dbRun(
      `DELETE FROM transactions WHERE recurring_template_id=? AND user_id=? AND ${effMonth()}>=?`,
      [t.recurring_template_id, req.user.id, curMonth]
    );
    return res.json({ok:true, cancelled_from: curMonth});
  }

  if (t.recurring_template_id) {
    const curMonth = (t.competence_month || t.date.slice(0,7));
    await dbRun(
      'INSERT INTO recurring_skips (user_id,recurring_template_id,skip_month) VALUES (?,?,?) ON CONFLICT DO NOTHING',
      [req.user.id,t.recurring_template_id,curMonth]
    );
  }

  // Excluir só este lançamento
  await dbRun('DELETE FROM transactions WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// ── Summary ───────────────────────────────────────────────────
app.get('/api/summary', auth, async (req,res) => {
  const {month}=req.query;
  const mf  = month ? `AND ${effMonth()}=?` : '';
  const p   = month ? [req.user.id, month] : [req.user.id];
  const p1  = [req.user.id];
  const [income, expense, byCategory, limits, monthly] = await Promise.all([
    dbGet(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND type='Receita' ${mf}`,p),
    dbGet(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND type='Despesa' ${mf}`,p),
    dbAll(`SELECT category,SUM(amount) as total FROM transactions WHERE user_id=? AND type='Despesa' ${mf} GROUP BY category ORDER BY total DESC`,p),
    dbAll('SELECT category,limit_amount FROM category_limits WHERE user_id=?',p1),
    dbAll(`SELECT ${effMonth()} as month,SUM(CASE WHEN type='Receita' THEN amount ELSE 0 END) as income,SUM(CASE WHEN type='Despesa' THEN amount ELSE 0 END) as expense FROM transactions WHERE user_id=? GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,p1)
  ]);
  const inc=parseFloat(income?.total||0), exp=parseFloat(expense?.total||0);
  res.json({income:inc,expense:exp,balance:inc-exp,byCategory,limits,monthly});
});

// ── Limits ────────────────────────────────────────────────────
app.get('/api/limits', auth, async (req,res) =>
  res.json(await dbAll('SELECT * FROM category_limits WHERE user_id=? ORDER BY category',[req.user.id])));
app.put('/api/limits', auth, async (req,res) => {
  const {category,limit_amount}=req.body||{};
  await dbRun('INSERT INTO category_limits (user_id,category,limit_amount) VALUES (?,?,?) ON CONFLICT(user_id,category) DO UPDATE SET limit_amount=excluded.limit_amount',
    [req.user.id,category,parseFloat(limit_amount)]);
  res.json({ok:true});
});

// ── Goals ─────────────────────────────────────────────────────
app.get('/api/goals', auth, async (req,res) =>
  res.json(await dbAll('SELECT * FROM goals WHERE user_id=? ORDER BY deadline',[req.user.id])));
app.post('/api/goals', auth, async (req,res) => {
  const {name,description,target_amount,saved_amount,deadline}=req.body||{};
  const r=await dbInsert('INSERT INTO goals (user_id,name,description,target_amount,saved_amount,deadline) VALUES (?,?,?,?,?,?)',
    [req.user.id,name,description||'',parseFloat(target_amount),parseFloat(saved_amount||0),deadline||null]);
  res.json({id:r.lastInsertRowid});
});
app.put('/api/goals/:id', auth, async (req,res) => {
  const g=await dbGet('SELECT id FROM goals WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!g) return res.status(404).json({error:'Não encontrado'});
  const {name,description,target_amount,saved_amount,deadline}=req.body||{};
  await dbRun('UPDATE goals SET name=?,description=?,target_amount=?,saved_amount=?,deadline=? WHERE id=?',
    [name,description||'',parseFloat(target_amount),parseFloat(saved_amount||0),deadline||null,req.params.id]);
  res.json({ok:true});
});
app.delete('/api/goals/:id', auth, async (req,res) => {
  const g=await dbGet('SELECT id FROM goals WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!g) return res.status(404).json({error:'Não encontrado'});
  await dbRun('DELETE FROM goals WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// ── Recurring ─────────────────────────────────────────────────
app.get('/api/recurring', auth, async (req,res) =>
  res.json(await dbAll('SELECT * FROM recurring_templates WHERE user_id=? ORDER BY description',[req.user.id])));
app.delete('/api/recurring/:id', auth, async (req,res) => {
  const t=await dbGet('SELECT id FROM recurring_templates WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!t) return res.status(404).json({error:'Não encontrado'});
  await dbRun('UPDATE recurring_templates SET active=0 WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// ── Savings ───────────────────────────────────────────────────
app.get('/api/savings', auth, async (req,res) => {
  const accounts = await dbAll('SELECT * FROM savings_accounts WHERE user_id=? ORDER BY name',[req.user.id]);
  if (!accounts.length) return res.json([]);
  // Uma única query agrega saldo e último depósito — sem N+1
  const ids = accounts.map((_,i) => USE_PG ? `$${i+2}` : '?').join(',');
  const aggSql = USE_PG
    ? `SELECT account_id,
              COALESCE(SUM(amount),0) as total,
              MAX(date) as last_date,
              (array_agg(amount ORDER BY date DESC))[1] as last_amount
       FROM savings_deposits WHERE user_id=$1 AND account_id IN (${ids}) GROUP BY account_id`
    : `SELECT account_id,
              COALESCE(SUM(amount),0) as total,
              MAX(date) as last_date,
              (SELECT amount FROM savings_deposits sd2 WHERE sd2.account_id=sd.account_id ORDER BY sd2.date DESC LIMIT 1) as last_amount
       FROM savings_deposits sd WHERE user_id=? AND account_id IN (${ids}) GROUP BY account_id`;
  const rows = await dbAll(aggSql, [req.user.id, ...accounts.map(a=>a.id)]);
  const map  = Object.fromEntries(rows.map(r=>[r.account_id, r]));
  const result = accounts.map(acc => {
    const agg = map[acc.id];
    return {
      ...acc,
      balance: parseFloat(agg?.total||0),
      last_deposit: agg?.last_date ? { date: agg.last_date, amount: agg.last_amount } : null
    };
  });
  res.json(result);
});
app.post('/api/savings', auth, async (req,res) => {
  const {name,description,color}=req.body||{};
  if (!name) return res.status(400).json({error:'Nome obrigatório'});
  try {
    const r=await dbInsert('INSERT INTO savings_accounts (user_id,name,description,color) VALUES (?,?,?,?)',[req.user.id,name,description||'',color||'#1b5e20']);
    res.json({id:r.lastInsertRowid});
  } catch(e) {
    if(e.code==='23505') return res.status(400).json({error:'Já existe uma conta com esse nome'});
    res.status(500).json({error:'Erro interno'});
  }
});
app.put('/api/savings/:id', auth, async (req,res) => {
  const acc=await dbGet('SELECT id FROM savings_accounts WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!acc) return res.status(404).json({error:'Não encontrado'});
  const {name,description,color}=req.body||{};
  await dbRun('UPDATE savings_accounts SET name=?,description=?,color=? WHERE id=?',[name,description||'',color||'#1b5e20',req.params.id]);
  res.json({ok:true});
});
app.delete('/api/savings/:id', auth, async (req,res) => {
  const acc=await dbGet('SELECT id FROM savings_accounts WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!acc) return res.status(404).json({error:'Não encontrado'});
  await dbRun('DELETE FROM savings_accounts WHERE id=?',[req.params.id]);
  res.json({ok:true});
});
app.get('/api/savings/:id/deposits', auth, async (req,res) => {
  const acc=await dbGet('SELECT id FROM savings_accounts WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!acc) return res.status(404).json({error:'Não encontrado'});
  res.json(await dbAll('SELECT * FROM savings_deposits WHERE account_id=? ORDER BY date DESC',[req.params.id]));
});
app.post('/api/savings/:id/deposits', auth, async (req,res) => {
  const acc=await dbGet('SELECT * FROM savings_accounts WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!acc) return res.status(404).json({error:'Não encontrado'});
  const {amount,date,note,transaction_id,create_transaction,category}=req.body||{};
  if (!amount||!date) return res.status(400).json({error:'Valor e data obrigatórios'});
  let txId=transaction_id||null;
  if (create_transaction) {
    const r=await dbInsert('INSERT INTO transactions (user_id,date,description,category,type,amount,note,payment_type) VALUES (?,?,?,?,?,?,?,?)',
      [req.user.id,date,`Depósito: ${acc.name}`,category||'Outros','Despesa',parseFloat(amount),note||'','dinheiro']);
    txId=r.lastInsertRowid;
  }
  const r=await dbInsert('INSERT INTO savings_deposits (user_id,account_id,amount,date,note,transaction_id) VALUES (?,?,?,?,?,?)',
    [req.user.id,req.params.id,parseFloat(amount),date,note||'',txId]);
  res.json({id:r.lastInsertRowid,transaction_id:txId});
});
app.delete('/api/savings/deposits/:id', auth, async (req,res) => {
  const dep=await dbGet('SELECT * FROM savings_deposits WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!dep) return res.status(404).json({error:'Não encontrado'});
  await dbRun('DELETE FROM savings_deposits WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// ── Shopping list ─────────────────────────────────────────────
async function canAccessShoppingList(userId, ownerId) {
  if (Number(userId) === Number(ownerId)) return true;
  return !!await dbGet('SELECT id FROM shopping_shares WHERE owner_id=? AND shared_user_id=?',[ownerId,userId]);
}

app.get('/api/shopping-lists', auth, async (req,res) => {
  const shared = await dbAll(
    'SELECT u.id,u.name,u.email FROM shopping_shares s JOIN users u ON u.id=s.owner_id WHERE s.shared_user_id=? AND u.is_active=1 ORDER BY u.name',
    [req.user.id]
  );
  res.json([{id:req.user.id,name:req.user.name,email:req.user.email,is_owner:true}, ...shared.map(u => ({...u,is_owner:false}))]);
});

app.get('/api/shopping-share-candidates', auth, async (req,res) => {
  res.json(await dbAll(
    `SELECT u.id,u.name,u.email, CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS shared
     FROM users u LEFT JOIN shopping_shares s ON s.owner_id=? AND s.shared_user_id=u.id
     WHERE u.id<>? AND u.is_active=1 ORDER BY u.name,u.email`,
    [req.user.id,req.user.id]
  ));
});

app.put('/api/shopping-shares/:userId', auth, async (req,res) => {
  const target = await dbGet('SELECT id FROM users WHERE id=?',[req.params.userId]);
  if (!target || Number(target.id) === Number(req.user.id)) return res.status(404).json({error:'Usuário não encontrado'});
  if (req.body?.shared) {
    await dbRun('INSERT INTO shopping_shares (owner_id,shared_user_id) VALUES (?,?) ON CONFLICT DO NOTHING',[req.user.id,target.id]);
  } else {
    await dbRun('DELETE FROM shopping_shares WHERE owner_id=? AND shared_user_id=?',[req.user.id,target.id]);
  }
  res.json({ok:true});
});
app.put('/api/users/:id/active', auth, requireAdmin, async (req,res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({error:'Não é possível inativar seu próprio usuário'});
  const user = await dbGet('SELECT id FROM users WHERE id=?',[req.params.id]);
  if (!user) return res.status(404).json({error:'Usuário não encontrado'});
  await dbRun('UPDATE users SET is_active=? WHERE id=?',[req.body?.is_active?1:0,req.params.id]);
  res.json({ok:true});
});

app.get('/api/shopping-items', auth, async (req,res) => {
  const month = String(req.query.month || '');
  const ownerId = Number(req.query.owner_id || req.user.id);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({error:'Mês inválido'});
  if (!await canAccessShoppingList(req.user.id,ownerId)) return res.status(403).json({error:'Sem acesso a esta lista'});
  res.json(await dbAll('SELECT * FROM shopping_items WHERE user_id=? AND month=? ORDER BY purchased, id',[ownerId,month]));
});

app.post('/api/shopping-items', auth, async (req,res) => {
  const month = String(req.body?.month || '');
  const ownerId = Number(req.body?.owner_id || req.user.id);
  const name = String(req.body?.name || '').trim();
  const quantity = String(req.body?.quantity || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month) || !name) return res.status(400).json({error:'Mês e item são obrigatórios'});
  if (!await canAccessShoppingList(req.user.id,ownerId)) return res.status(403).json({error:'Sem acesso a esta lista'});
  const r = await dbInsert('INSERT INTO shopping_items (user_id,month,name,quantity) VALUES (?,?,?,?)',[ownerId,month,name.slice(0,120),quantity.slice(0,40)]);
  res.json({id:r.lastInsertRowid,month,name:name.slice(0,120),quantity:quantity.slice(0,40),purchased:0});
});

app.patch('/api/shopping-items/:id', auth, async (req,res) => {
  const item = await dbGet('SELECT id,user_id FROM shopping_items WHERE id=?',[req.params.id]);
  if (!item || !await canAccessShoppingList(req.user.id,item.user_id)) return res.status(404).json({error:'Item não encontrado'});
  if (req.body?.purchased === undefined) return res.status(400).json({error:'Status obrigatório'});
  await dbRun('UPDATE shopping_items SET purchased=? WHERE id=?',[req.body.purchased?1:0,req.params.id]);
  res.json({ok:true});
});

app.delete('/api/shopping-items/completed', auth, async (req,res) => {
  const month = String(req.query.month || '');
  const ownerId = Number(req.query.owner_id || req.user.id);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({error:'Mês inválido'});
  if (!await canAccessShoppingList(req.user.id,ownerId)) return res.status(403).json({error:'Sem acesso a esta lista'});
  await dbRun('DELETE FROM shopping_items WHERE user_id=? AND month=? AND purchased=1',[ownerId,month]);
  res.json({ok:true});
});

app.delete('/api/shopping-items/:id', auth, async (req,res) => {
  const item = await dbGet('SELECT id,user_id FROM shopping_items WHERE id=?',[req.params.id]);
  if (!item || !await canAccessShoppingList(req.user.id,item.user_id)) return res.status(404).json({error:'Item não encontrado'});
  await dbRun('DELETE FROM shopping_items WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// ── Charges between users ─────────────────────────────────────
app.get('/api/charge-users', auth, async (req,res) => {
  res.json(await dbAll('SELECT id,name,email FROM users WHERE id<>? AND is_active=1 ORDER BY name,email',[req.user.id]));
});

app.get('/api/charges', auth, async (req,res) => {
  const incoming = await dbAll(
    `SELECT c.*,u.name AS requester_name,u.email AS requester_email
     FROM user_charges c JOIN users u ON u.id=c.requester_id
     WHERE c.recipient_id=? ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END,c.due_date DESC,c.id DESC`,
    [req.user.id]
  );
  const outgoing = await dbAll(
    `SELECT c.*,u.name AS recipient_name,u.email AS recipient_email
     FROM user_charges c JOIN users u ON u.id=c.recipient_id
     WHERE c.requester_id=? ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END,c.due_date DESC,c.id DESC`,
    [req.user.id]
  );
  res.json({incoming,outgoing});
});

app.get('/api/charges/pending-count', auth, async (req,res) => {
  const row = await dbGet("SELECT COUNT(*) AS total FROM user_charges WHERE recipient_id=? AND status='pending'",[req.user.id]);
  res.json({total:parseInt(row?.total||0)});
});

app.post('/api/charges', auth, async (req,res) => {
  const recipientId = parseInt(req.body?.recipient_id);
  const description = String(req.body?.description||'').trim();
  const chargeType = String(req.body?.charge_type||'').trim();
  const amount = parseFloat(req.body?.amount);
  const dueDate = String(req.body?.due_date||'');
  const recipient = await dbGet('SELECT id FROM users WHERE id=? AND is_active=1',[recipientId]);
  if (!recipient || recipientId===req.user.id) return res.status(400).json({error:'Destinatário inválido'});
  if (!description || !chargeType || !(amount>0) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))
    return res.status(400).json({error:'Preencha destinatário, cobrança, tipo, valor e vencimento'});
  const r = await dbInsert(
    'INSERT INTO user_charges (requester_id,recipient_id,description,charge_type,amount,due_date) VALUES (?,?,?,?,?,?)',
    [req.user.id,recipientId,description.slice(0,120),chargeType.slice(0,80),amount,dueDate]
  );
  res.json({id:r.lastInsertRowid});
});

app.patch('/api/charges/:id/reject', auth, async (req,res) => {
  const charge = await dbGet("SELECT id FROM user_charges WHERE id=? AND recipient_id=? AND status='pending'",[req.params.id,req.user.id]);
  if (!charge) return res.status(404).json({error:'Cobrança pendente não encontrada'});
  await dbRun(`UPDATE user_charges SET status='rejected',responded_at=${nowExpr} WHERE id=?`,[charge.id]);
  res.json({ok:true});
});

app.post('/api/charges/:id/accept', auth, async (req,res) => {
  const charge = await dbGet(
    `SELECT c.*,requester.name AS requester_name,recipient.name AS recipient_name
     FROM user_charges c JOIN users requester ON requester.id=c.requester_id JOIN users recipient ON recipient.id=c.recipient_id
     WHERE c.id=? AND c.recipient_id=? AND c.status='pending'`,
    [req.params.id,req.user.id]
  );
  if (!charge) return res.status(404).json({error:'Cobrança pendente não encontrada'});
  const category = String(req.body?.category||'').trim();
  const date = String(req.body?.date||charge.due_date);
  const competence = String(req.body?.competence_month||date.slice(0,7));
  const paymentType = String(req.body?.payment_type||'dinheiro');
  const paymentMethodId = req.body?.payment_method_id||null;
  if (!category || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({error:'Data e categoria são obrigatórias'});
  if (paymentMethodId) {
    const pm = await dbGet('SELECT id FROM payment_methods WHERE id=? AND user_id=?',[paymentMethodId,req.user.id]);
    if (!pm) return res.status(400).json({error:'Forma de pagamento inválida'});
  }
  const comp = competence!==date.slice(0,7)?competence:null;
  const expenseDesc = `${charge.description} — cobrança de ${charge.requester_name}`;
  const incomeDesc = `${charge.description} — recebido de ${charge.recipient_name}`;
  const note = `Cobrança: ${charge.charge_type}`;
  let expenseId, incomeId;
  try {
    const lock = await dbRun("UPDATE user_charges SET status='processing' WHERE id=? AND recipient_id=? AND status='pending'",[charge.id,req.user.id]);
    if (Number(lock?.changes??lock?.rowCount??0)===0) return res.status(409).json({error:'Cobrança já respondida'});
    const expense = await dbInsert(
      'INSERT INTO transactions (user_id,date,description,category,type,amount,note,payment_type,payment_method_id,installments,installment_number,competence_month) VALUES (?,?,?,?,?,?,?,?,?,1,1,?)',
      [req.user.id,date,expenseDesc,category,'Despesa',charge.amount,note,paymentType,paymentMethodId,comp]
    );
    expenseId=expense.lastInsertRowid;
    const income = await dbInsert(
      'INSERT INTO transactions (user_id,date,description,category,type,amount,note,payment_type,installments,installment_number,competence_month) VALUES (?,?,?,?,?,?,?,?,1,1,?)',
      [charge.requester_id,date,incomeDesc,'Receita','Receita',charge.amount,note,'receita',comp]
    );
    incomeId=income.lastInsertRowid;
    await dbRun(`UPDATE user_charges SET status='accepted',expense_transaction_id=?,income_transaction_id=?,responded_at=${nowExpr} WHERE id=?`,[expenseId,incomeId,charge.id]);
    res.json({ok:true,expense_transaction_id:expenseId,income_transaction_id:incomeId});
  } catch(e) {
    if (expenseId) await dbRun('DELETE FROM transactions WHERE id=?',[expenseId]).catch(()=>{});
    if (incomeId) await dbRun('DELETE FROM transactions WHERE id=?',[incomeId]).catch(()=>{});
    await dbRun("UPDATE user_charges SET status='pending' WHERE id=? AND status='processing'",[charge.id]).catch(()=>{});
    console.error(e);
    res.status(500).json({error:'Não foi possível aceitar a cobrança'});
  }
});

// ── Reminders ─────────────────────────────────────────────────
app.get('/api/reminders', auth, async (req,res) =>
  res.json(await dbAll('SELECT * FROM reminders WHERE user_id=? AND cancelled=0 ORDER BY remind_at',[req.user.id])));

app.post('/api/reminders', auth, async (req,res) => {
  const {title,remind_at}=req.body||{};
  if (!title||!remind_at) return res.status(400).json({error:'Título e data/hora obrigatórios'});
  const r=await dbInsert('INSERT INTO reminders (user_id,title,remind_at) VALUES (?,?,?)',[req.user.id,title,remind_at]);
  res.json({id:r.lastInsertRowid});
});

app.patch('/api/reminders/:id', auth, async (req,res) => {
  const rem=await dbGet('SELECT id FROM reminders WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!rem) return res.status(404).json({error:'Não encontrado'});
  const {done,cancelled}=req.body||{};
  if (done!==undefined)      await dbRun('UPDATE reminders SET done=?      WHERE id=?',[done?1:0,      req.params.id]);
  if (cancelled!==undefined) await dbRun('UPDATE reminders SET cancelled=? WHERE id=?',[cancelled?1:0, req.params.id]);
  res.json({ok:true});
});

app.delete('/api/reminders/:id', auth, async (req,res) => {
  const rem=await dbGet('SELECT id FROM reminders WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!rem) return res.status(404).json({error:'Não encontrado'});
  await dbRun('DELETE FROM reminders WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// ── SPA ───────────────────────────────────────────────────────
app.get('*', (req,res) => res.sendFile(join(__dirname,'public','index.html')));

app.listen(PORT, () => console.log(`✅ Servidor rodando em http://localhost:${PORT}`));
