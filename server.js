// گره‌گشا - بک‌اند (Node.js + Express + SQLite)
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
// شماره‌هایی که ادمین (شهرداری) حساب می‌شوند، با کاما جدا شوند
const ADMINS = (process.env.ADMIN_PHONES || '09120000000').split(',');

const STATUSES = ['submitted', 'reviewing', 'fixing', 'resolved'];
const CATEGORIES = ['pothole', 'light', 'garbage', 'water', 'other'];

fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
const db = new Database(path.join(__dirname, 'gereh.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  points INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS issues(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  photo TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  status TEXT DEFAULT 'submitted',
  admin_note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS votes(
  issue_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY(issue_id, user_id)
);
`);

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (req, file, cb) =>
      cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(file.originalname || '.jpg')),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ---------- احراز هویت ----------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    const data = jwt.verify(h.replace('Bearer ', ''), SECRET);
    req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(data.id);
    if (!req.user) throw new Error('no user');
    next();
  } catch (e) {
    res.status(401).json({ error: 'ابتدا وارد شوید' });
  }
}
const adminOnly = (req, res, next) =>
  req.user.is_admin ? next() : res.status(403).json({ error: 'دسترسی ندارید' });

// ورود/ثبت‌نام ساده با نام و شماره موبایل (برای MVP؛ در نسخه نهایی OTP پیامکی)
app.post('/api/auth/login', (req, res) => {
  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  if (name.length < 2 || !/^09\d{9}$/.test(phone))
    return res.status(400).json({ error: 'نام یا شماره موبایل نامعتبر است' });
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) {
    const info = db
      .prepare('INSERT INTO users(name, phone, is_admin) VALUES (?,?,?)')
      .run(name, phone, ADMINS.includes(phone) ? 1 : 0);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: '30d' });
  res.json({ token, name: user.name, is_admin: !!user.is_admin, points: user.points });
});

// ---------- گزارش‌ها ----------
const ISSUE_SQL = `
SELECT i.*, u.name AS reporter,
  (SELECT COUNT(*) FROM votes v WHERE v.issue_id = i.id) AS votes,
  EXISTS(SELECT 1 FROM votes v WHERE v.issue_id = i.id AND v.user_id = ?) AS voted
FROM issues i JOIN users u ON u.id = i.user_id
`;

app.get('/api/issues', auth, (req, res) => {
  const { status, category } = req.query;
  let sql = ISSUE_SQL + ' WHERE 1=1';
  const params = [req.user.id];
  if (status) { sql += ' AND i.status = ?'; params.push(status); }
  if (category) { sql += ' AND i.category = ?'; params.push(category); }
  sql += ' ORDER BY i.id DESC LIMIT 200';
  res.json(db.prepare(sql).all(...params).map((r) => ({ ...r, voted: !!r.voted })));
});

app.post('/api/issues', auth, upload.single('photo'), (req, res) => {
  const { category, description } = req.body;
  const lat = parseFloat(req.body.lat);
  const lng = parseFloat(req.body.lng);
  if (!CATEGORIES.includes(category) || isNaN(lat) || isNaN(lng))
    return res.status(400).json({ error: 'اطلاعات گزارش ناقص است' });
  const info = db
    .prepare('INSERT INTO issues(user_id, category, description, photo, lat, lng) VALUES (?,?,?,?,?,?)')
    .run(req.user.id, category, description || '', req.file ? req.file.filename : null, lat, lng);
  db.prepare('UPDATE users SET points = points + 10 WHERE id = ?').run(req.user.id);
  res.status(201).json({ id: info.lastInsertRowid });
});

// «من هم همین مشکل را دیدم»
app.post('/api/issues/:id/vote', auth, (req, res) => {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'پیدا نشد' });
  if (issue.user_id === req.user.id)
    return res.status(400).json({ error: 'برای گزارش خودتان نمی‌توانید رأی بدهید' });
  const r = db.prepare('INSERT OR IGNORE INTO votes(issue_id, user_id) VALUES (?,?)').run(issue.id, req.user.id);
  if (r.changes) db.prepare('UPDATE users SET points = points + 2 WHERE id = ?').run(issue.user_id);
  const votes = db.prepare('SELECT COUNT(*) c FROM votes WHERE issue_id = ?').get(issue.id).c;
  res.json({ votes });
});

// تغییر وضعیت توسط شهرداری/ادمین
app.patch('/api/issues/:id/status', auth, adminOnly, (req, res) => {
  const { status, note } = req.body;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'وضعیت نامعتبر' });
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'پیدا نشد' });
  db.prepare('UPDATE issues SET status = ?, admin_note = ? WHERE id = ?').run(status, note || issue.admin_note, issue.id);
  if (status === 'resolved' && issue.status !== 'resolved')
    db.prepare('UPDATE users SET points = points + 20 WHERE id = ?').run(issue.user_id);
  res.json({ ok: true });
});

// ---------- رتبه‌بندی و آمار ----------
app.get('/api/leaderboard', auth, (req, res) => {
  res.json(db.prepare('SELECT name, points FROM users ORDER BY points DESC LIMIT 20').all());
});

app.get('/api/stats', auth, (req, res) => {
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM issues GROUP BY status').all();
  const byCategory = db.prepare('SELECT category, COUNT(*) c FROM issues GROUP BY category').all();
  res.json({ byStatus, byCategory });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Gereh backend running on port ${PORT}`));
