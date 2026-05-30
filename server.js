import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'orcamento-secret-key-mude-em-producao';

// ── PostgreSQL ────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ? → $1,$2... converter
function pq(sql) { let i=0; return sql.replace(/\?/g, ()=>`$${++i}`); }

const dbGet    = (sql,p=[]) => pool.query(pq(sql),p).then(r=>r.rows[0]||null);
const dbAll    = (sql,p=[]) => pool.query(pq(sql),p).then(r=>r.rows);
const dbRun    = (sql,p=[]) => pool.query(pq(sql),p);
const dbInsert = async (sql,p=[]) => {
  const s = pq(sql);
  const r = await pool.query(s.includes('RETURNING')?s:s+' RETURNING id', p);
  return { lastInsertRowid: r.rows[0]?.id };
};

// ── Schema ────────────────────────────────────────────────────
const TABLES = [`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
    created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`,`
  CREATE TABLE IF NOT EXISTS payment_methods (
    id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'credito',
    color TEXT NOT NULL DEFAULT '#2e7d32',
    created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
    UNIQUE(user_id,name))`,`
  CREATE TABLE IF NOT EXISTS recurring_templates (
    id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    description TEXT NOT NULL, category TEXT NOT NULL, type TEXT NOT NULL,
    amount REAL NOT NULL, note TEXT DEFAULT '', payment_type TEXT DEFAULT 'dinheiro',
    payment_method_id INT REFERENCES payment_methods(id) ON DELETE SET NULL,
    active INT NOT NULL DEFAULT 1, start_month TEXT NOT NULL,
    created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`,`
  CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
    type TEXT NOT NULL, amount REAL NOT NULL, note TEXT DEFAULT '',
    payment_method_id INT REFERENCES payment_methods(id) ON DELETE SET NULL,
    payment_type TEXT DEFAULT 'dinheiro', installments INT DEFAULT 1,
    installment_number INT DEFAULT 1, group_id TEXT,
    recurring_template_id INT REFERENCES recurring_templates(id) ON DELETE SET NULL,
    competence_month TEXT,
    created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`,`
  CREATE TABLE IF NOT EXISTS category_limits (
    id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL, limit_amount REAL NOT NULL DEFAULT 0,
    UNIQUE(user_id,category))`,`
  CREATE TABLE IF NOT EXISTS goals (
    id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT DEFAULT '', target_amount REAL NOT NULL,
    saved_amount REAL NOT NULL DEFAULT 0, deadline TEXT,
    created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`,`
  CREATE TABLE IF NOT EXISTS savings_accounts (
    id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT DEFAULT '', color TEXT NOT NULL DEFAULT '#1b5e20',
    created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
    UNIQUE(user_id,name))`,`
  CREATE TABLE IF NOT EXISTS savings_deposits (
    id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id INT NOT NULL REFERENCES savings_accounts(id) ON DELETE CASCADE,
    amount REAL NOT NULL, date TEXT NOT NULL, note TEXT DEFAULT '',
    transaction_id INT REFERENCES transactions(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`
];
for (const t of TABLES) await pool.query(t);
console.log('✅ Schema pronto');

// effective month helper (SQLite → PostgreSQL)
const effMonth = (alias='') => {
  const t = alias ? alias+'.' : '';
  return `COALESCE(${t}competence_month, to_char(${t}date::date,'YYYY-MM'))`;
};

// ── Recurring helper ──────────────────────────────────────────
async function ensureRecurring(userId, month) {
  const templates = await dbAll(
    'SELECT * FROM recurring_templates WHERE user_id=? AND active=1 AND start_month<=?',
    [userId, month]
  );
  for (const t of templates) {
    const ex = await dbGet(
      `SELECT id FROM transactions WHERE user_id=? AND recurring_template_id=? AND to_char(date::date,'YYYY-MM')=?`,
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

// ── Auth ──────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body||{};
  if (!name||!email||!password) return res.status(400).json({ error:'Campos obrigatórios' });
  if (password.length<6) return res.status(400).json({ error:'Senha mínima: 6 caracteres' });
  try {
    const hash = bcrypt.hashSync(password,10);
    const r = await dbInsert('INSERT INTO users (name,email,password) VALUES (?,?,?)', [name,email.toLowerCase(),hash]);
    const uid = r.lastInsertRowid;
    const cats = ['Moradia','Alimentação','Transporte','Saúde','Educação','Lazer','Vestuário','Contas','Outros'];
    const defs = [1200,600,300,350,200,200,150,300,150];
    for (let i=0;i<cats.length;i++)
      await dbRun('INSERT INTO category_limits (user_id,category,limit_amount) VALUES (?,?,?) ON CONFLICT DO NOTHING',[uid,cats[i],defs[i]]);
    const token = jwt.sign({id:uid,name,email:email.toLowerCase()},JWT_SECRET,{expiresIn:'30d'});
    res.json({token,user:{id:uid,name,email:email.toLowerCase()}});
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
  const token = jwt.sign({id:user.id,name:user.name,email:user.email},JWT_SECRET,{expiresIn:'30d'});
  res.json({token,user:{id:user.id,name:user.name,email:user.email}});
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
  const {month}=req.query;
  const p=[req.user.id, month||null];
  const rows=await pool.query(`
    SELECT pm.id,pm.name,pm.type,pm.color,
           COALESCE(SUM(t.amount),0) as total, COUNT(t.id) as count
    FROM payment_methods pm
    LEFT JOIN transactions t ON t.payment_method_id=pm.id AND t.type='Despesa'
      AND ($2::text IS NULL OR ${effMonth('t')}=$2)
    WHERE pm.user_id=$1
    GROUP BY pm.id ORDER BY total DESC
  `,p);
  res.json(rows.rows);
});

// ── Transactions ──────────────────────────────────────────────
app.get('/api/transactions', auth, async (req,res) => {
  const {month,payment_method_id}=req.query;
  if (month) await ensureRecurring(req.user.id,month);
  const p=[req.user.id, month||null, payment_method_id||null];
  const rows=await pool.query(`
    SELECT t.*, pm.name as pm_name, pm.color as pm_color, pm.type as pm_type,
           ${effMonth('t')} as effective_month
    FROM transactions t
    LEFT JOIN payment_methods pm ON pm.id=t.payment_method_id
    WHERE t.user_id=$1
      AND ($2::text IS NULL OR ${effMonth('t')}=$2)
      AND ($3::int IS NULL OR t.payment_method_id=$3)
    ORDER BY t.date DESC, t.id DESC
  `,p);
  res.json(rows.rows);
});

app.post('/api/transactions', auth, async (req,res) => {
  const {date,description,category,type,amount,note,
         payment_type,payment_method_id,installments,is_fixed,competence_month}=req.body||{};
  if (!date||!description||!category||!type||!amount)
    return res.status(400).json({error:'Campos obrigatórios'});
  const val=parseFloat(amount), nInst=parseInt(installments)||1;
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
  const installAmt=Math.round((val/nInst)*100)/100;
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
  const {date,description,category,type,amount,note,payment_type,payment_method_id,update_future,competence_month}=req.body||{};
  const val=parseFloat(amount), ptype=payment_type||'dinheiro', pmId=payment_method_id||null;
  const month=(date||t.date).slice(0,7);
  const comp=(competence_month&&competence_month!==month)?competence_month:null;
  await dbRun('UPDATE transactions SET date=?,description=?,category=?,type=?,amount=?,note=?,payment_type=?,payment_method_id=?,competence_month=? WHERE id=?',
    [date,description,category,type,val,note||'',ptype,pmId,comp,req.params.id]);
  if (t.recurring_template_id&&update_future) {
    await dbRun('UPDATE recurring_templates SET description=?,category=?,type=?,amount=?,note=?,payment_type=?,payment_method_id=? WHERE id=? AND user_id=?',
      [description,category,type,val,note||'',ptype,pmId,t.recurring_template_id,req.user.id]);
    await pool.query(`UPDATE transactions SET description=$1,category=$2,type=$3,amount=$4,note=$5,payment_type=$6,payment_method_id=$7 WHERE recurring_template_id=$8 AND user_id=$9 AND ${effMonth()}>=$10`,
      [description,category,type,val,note||'',ptype,pmId,t.recurring_template_id,req.user.id,month]);
  }
  res.json({ok:true});
});

app.delete('/api/transactions/:id', auth, async (req,res) => {
  const t=await dbGet('SELECT * FROM transactions WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  if (!t) return res.status(404).json({error:'Não encontrado'});
  if (req.query.all_installments==='1'&&t.group_id)
    await dbRun('DELETE FROM transactions WHERE group_id=? AND user_id=?',[t.group_id,req.user.id]);
  else await dbRun('DELETE FROM transactions WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// ── Summary ───────────────────────────────────────────────────
app.get('/api/summary', auth, async (req,res) => {
  const {month}=req.query;
  const p=[req.user.id, month||null];
  const mf=`AND ($2::text IS NULL OR ${effMonth()}=$2)`;
  const [ir,er,cr,lr,mr]=await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=$1 AND type='Receita' ${mf}`,p),
    pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=$1 AND type='Despesa' ${mf}`,p),
    pool.query(`SELECT category,SUM(amount) as total FROM transactions WHERE user_id=$1 AND type='Despesa' ${mf} GROUP BY category ORDER BY total DESC`,p),
    pool.query('SELECT category,limit_amount FROM category_limits WHERE user_id=$1',[req.user.id]),
    pool.query(`SELECT ${effMonth()} as month,SUM(CASE WHEN type='Receita' THEN amount ELSE 0 END) as income,SUM(CASE WHEN type='Despesa' THEN amount ELSE 0 END) as expense FROM transactions WHERE user_id=$1 GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,[req.user.id])
  ]);
  const income=parseFloat(ir.rows[0]?.total||0), expense=parseFloat(er.rows[0]?.total||0);
  res.json({income,expense,balance:income-expense,byCategory:cr.rows,limits:lr.rows,monthly:mr.rows});
});

// ── Limits ────────────────────────────────────────────────────
app.get('/api/limits', auth, async (req,res) =>
  res.json(await dbAll('SELECT * FROM category_limits WHERE user_id=? ORDER BY category',[req.user.id])));
app.put('/api/limits', auth, async (req,res) => {
  const {category,limit_amount}=req.body||{};
  await dbRun('INSERT INTO category_limits (user_id,category,limit_amount) VALUES (?,?,?) ON CONFLICT(user_id,category) DO UPDATE SET limit_amount=EXCLUDED.limit_amount',
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
