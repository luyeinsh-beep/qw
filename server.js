const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3456;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY = '7d';

// ── Database ──────────────────────────────────────────
// Use Railway volume path if available, otherwise local
const DB_DIR = fs.existsSync('/data') ? '/data' : __dirname;
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS merchants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT,
    address TEXT,
    contact TEXT,
    phone TEXT,
    scale TEXT,
    revenue TEXT,
    note TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    overall_score REAL,
    grade TEXT,
    evaluator_name TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_evaluations_merchant ON evaluations(merchant_id);
  CREATE INDEX IF NOT EXISTS idx_merchants_created_by ON merchants(created_by);
`);

// ── Middleware ────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: '请求过于频繁，请稍后再试' } });
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 200, message: { error: '请求过于频繁' } });

// ── Auth Middleware ───────────────────────────────────
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// ── Auth Routes ───────────────────────────────────────
app.post('/api/auth/register', authLimiter, (req, res) => {
  const { username, password, display_name } = req.body;
  if (!username || !password || !display_name) {
    return res.status(400).json({ error: '用户名、密码和昵称不能为空' });
  }
  if (username.length < 2 || username.length > 30) {
    return res.status(400).json({ error: '用户名需要2-30个字符' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: '密码至少4个字符' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: '用户名已被注册' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)').run(username, hash, display_name);

  const token = jwt.sign({ id: result.lastInsertRowid, username, display_name, role: 'user' }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.json({ token, user: { id: result.lastInsertRowid, username, display_name, role: 'user' } });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  const user = db.prepare('SELECT id, username, display_name, role, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ user });
});

// ── Merchant Routes ───────────────────────────────────
app.get('/api/merchants', authRequired, apiLimiter, (req, res) => {
  const { search, type, status } = req.query;
  let query = 'SELECT m.*, u.display_name as creator_name FROM merchants m LEFT JOIN users u ON m.created_by = u.id WHERE 1=1';
  const params = [];

  if (search) { query += ' AND (m.name LIKE ? OR m.address LIKE ? OR m.contact LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (type) { query += ' AND m.type = ?'; params.push(type); }
  if (status === 'evaluated') { query += ' AND m.id IN (SELECT DISTINCT merchant_id FROM evaluations)'; }
  if (status === 'pending') { query += ' AND m.id NOT IN (SELECT DISTINCT merchant_id FROM evaluations)'; }

  query += ' ORDER BY m.updated_at DESC';
  const merchants = db.prepare(query).all(...params);

  // Attach latest evaluation for each merchant
  const result = merchants.map(m => {
    const eval_ = db.prepare('SELECT * FROM evaluations WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 1').get(m.id);
    return {
      ...m,
      latestEval: eval_ ? {
        id: eval_.id,
        overallScore: eval_.overall_score,
        grade: eval_.grade,
        evaluatorName: eval_.evaluator_name,
        date: eval_.created_at?.split(' ')[0],
        data: JSON.parse(eval_.data)
      } : null
    };
  });

  res.json({ merchants: result });
});

app.post('/api/merchants', authRequired, (req, res) => {
  const { name, type, address, contact, phone, scale, revenue, note } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '商户名称不能为空' });

  const id = 'm_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
  db.prepare(`INSERT INTO merchants (id, name, type, address, contact, phone, scale, revenue, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name.trim(), type || '', address || '', contact || '', phone || '', scale || '', revenue || '', note || '', req.user.id);

  const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(id);
  res.json({ merchant });
});

app.put('/api/merchants/:id', authRequired, (req, res) => {
  const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.params.id);
  if (!merchant) return res.status(404).json({ error: '商户不存在' });

  const { name, type, address, contact, phone, scale, revenue, note } = req.body;
  db.prepare(`UPDATE merchants SET name=?, type=?, address=?, contact=?, phone=?, scale=?, revenue=?, note=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(name || merchant.name, type !== undefined ? type : merchant.type, address !== undefined ? address : merchant.address,
         contact !== undefined ? contact : merchant.contact, phone !== undefined ? phone : merchant.phone,
         scale !== undefined ? scale : merchant.scale, revenue !== undefined ? revenue : merchant.revenue,
         note !== undefined ? note : merchant.note, req.params.id);

  const updated = db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.params.id);
  res.json({ merchant: updated });
});

app.delete('/api/merchants/:id', authRequired, (req, res) => {
  const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.params.id);
  if (!merchant) return res.status(404).json({ error: '商户不存在' });

  db.prepare('DELETE FROM evaluations WHERE merchant_id = ?').run(req.params.id);
  db.prepare('DELETE FROM merchants WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Evaluation Routes ─────────────────────────────────
app.post('/api/merchants/:id/evaluations', authRequired, (req, res) => {
  const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.params.id);
  if (!merchant) return res.status(404).json({ error: '商户不存在' });

  const { data: evalData, overallScore, grade, evaluatorName } = req.body;
  if (!evalData) return res.status(400).json({ error: '评估数据不能为空' });

  const evalId = 'ev_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
  db.prepare(`INSERT INTO evaluations (id, merchant_id, user_id, data, overall_score, grade, evaluator_name) VALUES (?,?,?,?,?,?,?)`)
    .run(evalId, req.params.id, req.user.id, JSON.stringify(evalData), overallScore || 0, grade || '', evaluatorName || req.user.display_name);

  // Update merchant's updated_at
  db.prepare("UPDATE merchants SET updated_at=datetime('now','localtime') WHERE id=?").run(req.params.id);

  const evaluation = db.prepare('SELECT * FROM evaluations WHERE id = ?').get(evalId);
  res.json({
    evaluation: {
      ...evaluation,
      data: JSON.parse(evaluation.data),
      overallScore: evaluation.overall_score,
      evaluatorName: evaluation.evaluator_name
    }
  });
});

app.get('/api/merchants/:id/evaluations', authRequired, (req, res) => {
  const evals = db.prepare('SELECT e.*, u.display_name as user_name FROM evaluations e LEFT JOIN users u ON e.user_id = u.id WHERE e.merchant_id = ? ORDER BY e.created_at DESC').all(req.params.id);
  res.json({
    evaluations: evals.map(e => ({
      ...e,
      data: JSON.parse(e.data),
      overallScore: e.overall_score,
      evaluatorName: e.evaluator_name
    }))
  });
});

app.get('/api/evaluations/:id', authRequired, (req, res) => {
  const eval_ = db.prepare('SELECT e.*, u.display_name as user_name FROM evaluations e LEFT JOIN users u ON e.user_id = u.id WHERE e.id = ?').get(req.params.id);
  if (!eval_) return res.status(404).json({ error: '评估不存在' });
  res.json({
    evaluation: {
      ...eval_,
      data: JSON.parse(eval_.data),
      overallScore: eval_.overall_score,
      evaluatorName: eval_.evaluator_name
    }
  });
});

// ── Stats Route ───────────────────────────────────────
app.get('/api/stats', authRequired, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM merchants').get().count;
  const evaluated = db.prepare('SELECT COUNT(DISTINCT merchant_id) as count FROM evaluations').get().count;
  const avgScore = db.prepare(`
    SELECT AVG(e.overall_score) as avg_score FROM evaluations e
    WHERE e.id IN (SELECT MAX(id) FROM evaluations GROUP BY merchant_id) AND e.overall_score > 0
  `).get().avg_score;
  const users = db.prepare('SELECT COUNT(*) as count FROM users').get().count;

  res.json({ total, evaluated, pending: total - evaluated, avgScore: avgScore ? Math.round(avgScore * 10) / 10 : null, users });
});

// ── Scrape Route ──────────────────────────────────────
app.post('/api/scrape-notes', authRequired, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '请提供话题链接' });

  const topicMatch = url.match(/topicid=(\d+)/);
  if (!topicMatch) return res.status(400).json({ error: '无法识别话题ID，请确认链接格式' });
  const topicId = topicMatch[1];

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 390, height: 844 });

    let topicInfo = null;
    let commentData = null;

    page.on('response', async (response) => {
      const rurl = response.url();
      try {
        if (rurl.includes('topicinfo.bin') && rurl.includes(`topicId=${topicId}`)) {
          topicInfo = await response.json();
        }
        if (rurl.includes('topiccomment.bin') && rurl.includes(`topicId=${topicId}`)) {
          commentData = await response.json();
        }
      } catch {}
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(800);
    }

    if (!topicInfo || !topicInfo.topicInfo) {
      return res.status(500).json({ error: '未能获取话题信息，请确认链接可正常访问' });
    }

    const topic = topicInfo.topicInfo;
    const posts = (commentData?.data?.topicContentList || []).map(item => ({
      platform: '大众点评',
      title: item.summary || '',
      coverUrl: (item.picUrl || '').replace(/%(40|90|750)w_\d+h[^.]*/, ''),
      views: 0,
      likes: item.likeCount || 0,
      comments: 0,
      shares: 0,
      publishDate: '',
      authorName: item.authorName || '',
      authorAvatar: item.authorAvatar || '',
      jumpUrl: item.jumpUrl || '',
      sourceId: String(item.mainId || '')
    }));

    res.json({
      success: true,
      topicName: topic.title || '',
      topicViews: parseInt(topic.visitCount) || 0,
      totalPosts: parseInt(topic.reviewCount) || posts.length,
      topicCover: topic.picUrl || '',
      notes: posts
    });

  } catch (e) {
    console.error('Scrape error:', e.message);
    res.status(500).json({ error: '抓取失败: ' + e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ── SPA fallback ──────────────────────────────────────
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('*', (req, res) => {
  // If it's not an API route and not a static file, serve index.html (login)
  if (!req.path.startsWith('/api/')) {
    // Check if the path matches a static file
    const ext = path.extname(req.path);
    if (!ext && req.path !== '/') {
      return res.sendFile(path.join(__dirname, 'public', 'app.html'));
    }
    return res.status(404).send('Not Found');
  }
  res.status(404).json({ error: 'API endpoint not found' });
});

// ── Start ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🍽️  餐饮评估工作台已启动`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   JWT Secret: ${JWT_SECRET.slice(0, 12)}...\n`);
});
