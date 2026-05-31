import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import { join, dirname, resolve as pathResolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'orcamento-secret-key-mude-em-producao';
const USE_PG = !!process.env.DATABASE_URL;

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
  `CREATE TABLE IF NOT EXISTS users (id ${idType} PRIMARY KEY${idExtra}, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, is_admin INT NOT NULL DEFAULT 0, must_change_password INT NOT NULL DEFAULT 0, created_at TEXT DEFAULT ${nowExpr})`,
  `CREATE TABLE IF NOT EXISTS payment_methods (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'credito', color TEXT NOT NULL DEFAULT '#2e7d32', created_at TEXT DEFAULT ${nowExpr}, UNIQUE(user_id,name))`,
  `CREATE TABLE IF NOT EXISTS recurring_templates (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, description TEXT NOT NULL, category TEXT NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, note TEXT DEFAULT '', payment_type TEXT DEFAULT 'dinheiro', payment_method_id INT REFERENCES payment_methods(id) ON DELETE SET NULL, active INT NOT NULL DEFAULT 1, start_month TEXT NOT NULL, created_at TEXT DEFAULT ${nowExpr})`,
  `CREATE TABLE IF NOT EXISTS recurring_skips (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, recurring_template_id INT NOT NULL REFERENCES recurring_templates(id) ON DELETE CASCADE, skip_month TEXT NOT NULL, created_at TEXT DEFAULT ${nowExpr}, UNIQUE(user_id,recurring_template_id,skip_month))`,
  `CREATE TABLE IF NOT EXISTS transactions (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, note TEXT DEFAULT '', payment_method_id INT REFERENCES payment_methods(id) ON DELETE SET NULL, payment_type TEXT DEFAULT 'dinheiro', installments INT DEFAULT 1, installment_number INT DEFAULT 1, group_id TEXT, recurring_template_id INT REFERENCES recurring_templates(id) ON DELETE SET NULL, competence_month TEXT, created_at TEXT DEFAULT ${nowExpr})`,
  `CREATE TABLE IF NOT EXISTS category_limits (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, category TEXT NOT NULL, limit_amount REAL NOT NULL DEFAULT 0, UNIQUE(user_id,category))`,
  `CREATE TABLE IF NOT EXISTS goals (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT DEFAULT '', target_amount REAL NOT NULL, saved_amount REAL NOT NULL DEFAULT 0, deadline TEXT, created_at TEXT DEFAULT ${nowExpr})`,
  `CREATE TABLE IF NOT EXISTS savings_accounts (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT DEFAULT '', color TEXT NOT NULL DEFAULT '#1b5e20', created_at TEXT DEFAULT ${nowExpr}, UNIQUE(user_id,name))`,
  `CREATE TABLE IF NOT EXISTS savings_deposits (id ${idType} PRIMARY KEY${idExtra}, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_id INT NOT NULL REFERENCES savings_accounts(id) ON DELETE CASCADE, amount REAL NOT NULL, date TEXT NOT NULL, note TEXT DEFAULT '', transaction_id INT REFERENCES transactions(id) ON DELETE SET NULL, created_at TEXT DEFAULT ${nowExpr})`
];
for (const t of TABLES) await dbExec(t);
if (USE_PG) {
  await dbExec(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin INT NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password INT NOT NULL DEFAULT 0;
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
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error:'Token necessário' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error:'Token inválido' }); }
}
async function requireAdmin(req, res, next) {
  const user = await dbGet('SELECT is_admin FROM users WHERE id=?',[req.user.id]);
  if (!user?.is_admin) return res.status(403).json({error:'Acesso restrito ao administrador'});
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
  const token = jwt.sign({id:user.id,name:user.name,email:user.email,is_admin:user.is_admin},JWT_SECRET,{expiresIn:'30d'});
  res.json({token,user:{id:user.id,name:user.name,email:user.email,is_admin:user.is_admin,must_change_password:user.must_change_password}});
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
  res.json(await dbAll('SELECT id,name,email,is_admin,must_change_password,created_at FROM users ORDER BY name'));
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
  const accounts=await dbAll('SELECT * FROM savings_accounts WHERE user_id=? ORDER BY name',[req.user.id]);
  const result=await Promise.all(accounts.map(async acc => {
    const bal=await dbGet('SELECT COALESCE(SUM(amount),0) as total FROM savings_deposits WHERE account_id=? AND user_id=?',[acc.id,req.user.id]);
    const last=await dbGet('SELECT date,amount FROM savings_deposits WHERE account_id=? AND user_id=? ORDER BY date DESC LIMIT 1',[acc.id,req.user.id]);
    return {...acc,balance:parseFloat(bal?.total||0),last_deposit:last};
  }));
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

// ── SPA ───────────────────────────────────────────────────────
app.get('*', (req,res) => res.sendFile(join(__dirname,'public','index.html')));

app.listen(PORT, () => console.log(`✅ Servidor rodando em http://localhost:${PORT}`));
