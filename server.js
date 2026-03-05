/**
 * Voltgo Support System V4.3 (Tickets + Customers UI)
 * - Multi-agent login via UI_USERS (user:pass,user2:pass2)
 * - Strict isolation (STRICT_AGENT_VIEW=1): agents only see Unassigned + Mine
 * - Ticketing: one WhatsApp wa_id can have multiple tickets (presales/aftersales)
 * - Auto routing by keyword OR menu (1/2)
 * - DB-backed (Postgres): auto-migrate tables
 *
 * Required env:
 *   DATABASE_URL
 *   VERIFY_TOKEN
 *   WA_TOKEN
 *   PHONE_NUMBER_ID
 *   UI_USERS=presales:111111,aftersales:222222
 *   PRESALES_ASSIGNEE=presales
 *   AFTERSALES_ASSIGNEE=aftersales
 *   SESSION_SECRET=...
 * Optional:
 *   PORT=8080
 *   STRICT_AGENT_VIEW=1
 *   ADMIN_USERS=admin,bruce
 */

require("dotenv").config();

console.log("✅ LOADED SERVER.JS: Voltgo Support System V4.3 (Tickets + Customers UI) (2026-03-04)");

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const session = require("express-session");
const { Pool } = require("pg");

// Optional sharp
let sharp = null;
try { sharp = require("sharp"); console.log("✅ sharp enabled: thumbnails will be generated"); }
catch { console.log("ℹ️ sharp not installed: thumbnails disabled"); }

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ------------------------ env & config ------------------------
function mustEnv(k) {
  const v = process.env[k];
  if (!v) {
    console.error("Missing .env variable:", k);
    process.exit(1);
  }
  return v;
}

const PORT = parseInt(process.env.PORT || "8080", 10);
const VERIFY_TOKEN = mustEnv("VERIFY_TOKEN");
const DATABASE_URL = mustEnv("DATABASE_URL");
const WA_TOKEN = mustEnv("WA_TOKEN");
const PHONE_NUMBER_ID = mustEnv("PHONE_NUMBER_ID");

const UI_USERS_RAW = (process.env.UI_USERS || "").trim();
const UI_USER_SINGLE = (process.env.UI_USER || "").trim();
const UI_PASS_SINGLE = (process.env.UI_PASS || "").trim();
const SESSION_SECRET = (process.env.SESSION_SECRET || "change_me_session_secret").trim();
const STRICT_AGENT_VIEW = (process.env.STRICT_AGENT_VIEW || "").trim() === "1";
const ADMIN_USERS = new Set(
  (process.env.ADMIN_USERS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

// Assignees
const PRESALES_ASSIGNEE = (process.env.PRESALES_ASSIGNEE || "presales").trim();
const AFTERSALES_ASSIGNEE = (process.env.AFTERSALES_ASSIGNEE || "aftersales").trim();

const VERSION_MARKER = "V4_3_STABLE_2026-03-04";

// Keyword routing
const PRESALES_KEYWORDS = ["price", "quote", "buy", "dealer", "wholesale", "distributor", "lead", "sales"];
const AFTERSALES_KEYWORDS = ["support", "warranty", "problem", "issue", "bms", "can", "return", "rma", "install", "trouble", "fault", "broken"];

// ------------------------ helpers ------------------------
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function nowISO() {
  return new Date().toISOString();
}

function isAdminUser(u) {
  if (!u) return false;
  if (ADMIN_USERS.has(u)) return true;
  if (u === "admin") return true;
  if (UI_USER_SINGLE && u === UI_USER_SINGLE) return true;
  return false;
}

function parseUiUsers() {
  const map = new Map();
  if (UI_USERS_RAW) {
    for (const pair of UI_USERS_RAW.split(",")) {
      const p = pair.trim();
      if (!p) continue;
      const idx = p.indexOf(":");
      if (idx <= 0) continue;
      const user = p.slice(0, idx).trim();
      const pass = p.slice(idx + 1).trim();
      if (user && pass) map.set(user, pass);
    }
  }
  if (UI_USER_SINGLE && UI_PASS_SINGLE) {
    map.set(UI_USER_SINGLE, UI_PASS_SINGLE);
  }
  return map;
}
const UI_USERS = parseUiUsers();

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect("/login");
}

// Very small event bus for SSE
const sseClients = new Set();
function sseBroadcast(event, dataObj) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* ignore */ }
  }
}

// ------------------------ storage paths ------------------------
const LOGS_DIR = path.join(process.cwd(), "logs");
const MEDIA_DIR = path.join(LOGS_DIR, "media");
const THUMBS_DIR = path.join(MEDIA_DIR, "__thumbs");
const UPLOADS_DIR = path.join(LOGS_DIR, "uploads");
for (const d of [LOGS_DIR, MEDIA_DIR, THUMBS_DIR, UPLOADS_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
}
const upload = multer({ dest: UPLOADS_DIR }); // reserved for future uploads

// ------------------------ DB ------------------------
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function dbPing() {
  await pool.query("SELECT 1 as ok");
}

async function dbInit() {
  // customers: include meta for pending choice
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      wa_id TEXT PRIMARY KEY,
      name TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      meta JSONB DEFAULT '{}'::jsonb
    )
  `);

  // tickets
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      wa_id TEXT NOT NULL,
      department TEXT NOT NULL,
      assigned_to TEXT,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      last_message TEXT,
      last_time TIMESTAMP,
      unread_count INT DEFAULT 0,
      meta JSONB DEFAULT '{}'::jsonb
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_wa_status ON tickets(wa_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assigned_to)`);

  // messages: add ticket_id if missing
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS ticket_id INT`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id, id)`);

  console.log("✅ DB connected");
  console.log("✅ tables ready");
}

async function upsertCustomer(wa_id) {
  await pool.query(
    `INSERT INTO customers(wa_id) VALUES($1)
     ON CONFLICT (wa_id) DO NOTHING`,
    [wa_id]
  );
}

async function setCustomerMeta(wa_id, patchObj) {
  await pool.query(
    `UPDATE customers
     SET meta = COALESCE(meta,'{}'::jsonb) || $2::jsonb
     WHERE wa_id = $1`,
    [wa_id, JSON.stringify(patchObj)]
  );
}

async function getCustomerMeta(wa_id) {
  const r = await pool.query(`SELECT meta FROM customers WHERE wa_id=$1`, [wa_id]);
  return (r.rows[0] && r.rows[0].meta) ? r.rows[0].meta : {};
}

function classifyDepartment(text) {
  const t = String(text || "").toLowerCase();
  const hitPre = PRESALES_KEYWORDS.some(k => t.includes(k));
  const hitAfter = AFTERSALES_KEYWORDS.some(k => t.includes(k));
  if (hitPre && !hitAfter) return "presales";
  if (hitAfter && !hitPre) return "aftersales";
  if (hitAfter && hitPre) return "aftersales";
  return "";
}

function defaultAssigneeForDept(dept) {
  if (dept === "presales") return PRESALES_ASSIGNEE;
  if (dept === "aftersales") return AFTERSALES_ASSIGNEE;
  return "";
}

async function getOrCreateOpenTicket(wa_id, dept) {
  const r = await pool.query(
    `SELECT id, assigned_to FROM tickets
     WHERE wa_id=$1 AND department=$2 AND status='open'
     ORDER BY id DESC
     LIMIT 1`,
    [wa_id, dept]
  );
  if (r.rows.length) return r.rows[0];

  const assignee = defaultAssigneeForDept(dept) || null;
  const ins = await pool.query(
    `INSERT INTO tickets(wa_id, department, assigned_to, status, created_at, updated_at)
     VALUES($1,$2,$3,'open',NOW(),NOW())
     RETURNING id, assigned_to`,
    [wa_id, dept, assignee]
  );
  return ins.rows[0];
}

async function addMessage({ conversation_id, wa_id, direction, msg_type, text, caption, tags, wa_message_id, ticket_id }) {
  await pool.query(
    `INSERT INTO messages(conversation_id, wa_id, direction, msg_type, text, caption, tags, wa_message_id, ticket_id, created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
    [
      conversation_id,
      wa_id,
      direction,
      msg_type,
      text || null,
      caption || null,
      JSON.stringify(tags || []),
      wa_message_id || null,
      ticket_id || null,
    ]
  );
}

async function touchTicket(ticket_id, last_message, isIncoming) {
  if (isIncoming) {
    await pool.query(
      `UPDATE tickets
       SET last_message=$2, last_time=NOW(), updated_at=NOW(),
           unread_count = COALESCE(unread_count,0) + 1
       WHERE id=$1`,
      [ticket_id, last_message || null]
    );
  } else {
    await pool.query(
      `UPDATE tickets
       SET last_message=$2, last_time=NOW(), updated_at=NOW()
       WHERE id=$1`,
      [ticket_id, last_message || null]
    );
  }
}

async function markTicketRead(ticket_id) {
  await pool.query(`UPDATE tickets SET unread_count=0, updated_at=NOW() WHERE id=$1`, [ticket_id]);
}

async function closeTicket(ticket_id) {
  // If your tickets table doesn't have closed_at yet, ignore (no ALTER here).
  await pool.query(`UPDATE tickets SET status='closed', updated_at=NOW() WHERE id=$1`, [ticket_id]);
}

async function assignTicket(ticket_id, assignee) {
  await pool.query(`UPDATE tickets SET assigned_to=$2, updated_at=NOW() WHERE id=$1`, [ticket_id, assignee]);
}

// ------------------------ WhatsApp API ------------------------
async function waSendText(toWaId, bodyText) {
  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(PHONE_NUMBER_ID)}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: String(toWaId),
    type: "text",
    text: { body: String(bodyText) },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = `WA send failed: ${resp.status} ${JSON.stringify(data)}`;
    throw new Error(msg);
  }
  return data;
}

function menuText() {
  return [
    "Hi! Please choose:",
    "1) Pre-Sales (price/quote/dealer)",
    "2) After-Sales (support/warranty/problem)",
    "",
    "Reply with 1 or 2.",
  ].join("\n");
}

// ------------------------ Webhook ------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body || {};
    const entry = body.entry && body.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = changes && changes.value;
    const messages = value && value.messages;

    if (!messages || !messages.length) return;

    const msg = messages[0];
    const from = msg.from; // wa_id
    const msgId = msg.id || null;
    const text = (msg.text && msg.text.body) ? msg.text.body : "";
    const msgType = msg.type || "text";

    if (!from) return;

    await upsertCustomer(from);

    const meta = await getCustomerMeta(from);
    const pending = meta && meta.pending_choice;

    let dept = "";
    const trimmed = String(text || "").trim();

    if (pending) {
      if (trimmed === "1") dept = "presales";
      else if (trimmed === "2") dept = "aftersales";
      await setCustomerMeta(from, { pending_choice: false });
    }

    if (!dept) dept = classifyDepartment(text);

    if (!dept) {
      await setCustomerMeta(from, { pending_choice: true });
      try {
        const data = await waSendText(from, menuText());
        await addMessage({
          conversation_id: from,
          wa_id: from,
          direction: "outgoing",
          msg_type: "text",
          text: menuText(),
          caption: null,
          tags: [],
          wa_message_id: (data.messages && data.messages[0] && data.messages[0].id) ? data.messages[0].id : null,
          ticket_id: null,
        });
      } catch (e) {
        console.error("❌ WA menu send failed:", e.message || e);
      }
      return;
    }

    const ticket = await getOrCreateOpenTicket(from, dept);

    await addMessage({
      conversation_id: from,
      wa_id: from,
      direction: "incoming",
      msg_type: msgType,
      text: text || null,
      caption: null,
      tags: [],
      wa_message_id: msgId,
      ticket_id: ticket.id,
    });

    await touchTicket(ticket.id, text, true);

    sseBroadcast("ticket_update", { wa_id: from, ticket_id: ticket.id, ts: nowISO() });
  } catch (e) {
    console.error("❌ webhook handler error:", e);
  }
});

// ------------------------ UI auth ------------------------
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 14 * 24 * 3600 * 1000 },
}));

app.get("/login", (req, res) => {
  const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Voltgo Support System - Login</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:40px;background:#f6f7fb;}
    .card{max-width:420px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:20px;box-shadow:0 10px 22px rgba(0,0,0,0.06);}
    h1{font-size:20px;margin:0 0 10px;}
    label{display:block;margin-top:12px;font-size:13px;color:#374151;}
    input{width:100%;padding:10px;border-radius:10px;border:1px solid #d1d5db;margin-top:6px;font-size:14px;}
    button{margin-top:16px;width:100%;padding:10px;border-radius:10px;border:0;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;}
    .hint{margin-top:10px;font-size:12px;color:#6b7280;}
  </style>
</head>
<body>
  <div class="card">
    <h1>Voltgo Support System</h1>
    <form method="POST" action="/login">
      <label>Username</label>
      <input name="username" autocomplete="username" />
      <label>Password</label>
      <input name="password" type="password" autocomplete="current-password" />
      <button type="submit">Login</button>
    </form>
    <div class="hint">V4.2 Tickets • ${esc(STRICT_AGENT_VIEW ? "Strict View ON" : "Strict View OFF")}</div>
  </div>
</body>
</html>`;
  res.status(200).send(html);
});

app.post("/login", (req, res) => {
  const u = String(req.body.username || "").trim();
  const p = String(req.body.password || "").trim();
  if (!u || !p) return res.redirect("/login");
  const okPass = UI_USERS.get(u);
  if (okPass && okPass === p) {
    req.session.user = u;
    return res.redirect("/ui");
  }
  return res.redirect("/login");
});

app.get("/logout", (req, res) => {
  try { req.session.destroy(() => res.redirect("/login")); }
  catch { res.redirect("/login"); }
});

// ------------------------ SSE ------------------------
app.get("/events", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, ts: nowISO() })}\n\n`);
  sseClients.add(res);
  req.on("close", () => { sseClients.delete(res); });
});

// ------------------------ API ------------------------
app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: req.session.user, admin: isAdminUser(req.session.user), strict: STRICT_AGENT_VIEW });
});

app.get("/api/tickets", requireAuth, async (req, res) => {
  try {
    const user = req.session.user;

    const q = String(req.query.q || "").trim();
    const dept = String(req.query.dept || "").trim();
    const status = String(req.query.status || "").trim();
    const assigneeQ = String(req.query.assignee || "").trim();
    const unreadOnly = String(req.query.unread || "").trim() === "1";

    let sql = `SELECT id, wa_id, department, assigned_to, status, created_at, updated_at, last_message, last_time, unread_count
               FROM tickets
               WHERE 1=1`;
    const params = [];
    let i = 1;

    if (dept) { sql += ` AND department = $${i++}`; params.push(dept); }
    if (status) { sql += ` AND status = $${i++}`; params.push(status); }
    if (assigneeQ) { sql += ` AND assigned_to = $${i++}`; params.push(assigneeQ); }
    if (unreadOnly) { sql += ` AND COALESCE(unread_count,0) > 0`; }

    if (q) {
      sql += ` AND (wa_id ILIKE $${i++} OR COALESCE(last_message,'') ILIKE $${i++})`;
      params.push(`%${q}%`, `%${q}%`);
    }

    if (STRICT_AGENT_VIEW && !isAdminUser(user)) {
      sql += ` AND (COALESCE(NULLIF(assigned_to,''), '') = '' OR assigned_to = $${i++})`;
      params.push(user);
    }

    sql += ` ORDER BY COALESCE(last_time, created_at) DESC LIMIT 200`;

    const r = await pool.query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) {
    console.error("❌ /api/tickets error:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/tickets/:id/messages", requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const id = parseInt(req.params.id, 10);

    const t = await pool.query(`SELECT id, wa_id, assigned_to FROM tickets WHERE id=$1`, [id]);
    if (!t.rows.length) return res.status(404).json({ ok: false, error: "not found" });
    const ticket = t.rows[0];

    if (STRICT_AGENT_VIEW && !isAdminUser(user)) {
      const assignee = String(ticket.assigned_to || "");
      if (assignee && assignee !== user) return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const r = await pool.query(
      `SELECT id, conversation_id, wa_id, direction, msg_type, text, caption, tags, wa_message_id, created_at
       FROM messages
       WHERE ticket_id = $1
       ORDER BY id ASC
       LIMIT 500`,
      [id]
    );
    await markTicketRead(id);
    res.json({ ok: true, ticket, messages: r.rows });
  } catch (e) {
    console.error("❌ /api/ticket/messages error:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/tickets/:id/reply", requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const id = parseInt(req.params.id, 10);
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "empty" });

    const t = await pool.query(`SELECT id, wa_id, assigned_to FROM tickets WHERE id=$1`, [id]);
    if (!t.rows.length) return res.status(404).json({ ok: false, error: "not found" });
    const ticket = t.rows[0];

    if (STRICT_AGENT_VIEW && !isAdminUser(user)) {
      const assignee = String(ticket.assigned_to || "");
      if (assignee && assignee !== user) return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const wa = ticket.wa_id;
    const data = await waSendText(wa, text);

    await addMessage({
      conversation_id: wa,
      wa_id: wa,
      direction: "outgoing",
      msg_type: "text",
      text,
      caption: null,
      tags: [],
      wa_message_id: (data.messages && data.messages[0] && data.messages[0].id) ? data.messages[0].id : null,
      ticket_id: id,
    });
    await touchTicket(id, text, false);

    sseBroadcast("ticket_update", { ticket_id: id, ts: nowISO() });
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ /api/tickets/:id/reply error:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/tickets/:id/close", requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const id = parseInt(req.params.id, 10);

    const t = await pool.query(`SELECT id, assigned_to FROM tickets WHERE id=$1`, [id]);
    if (!t.rows.length) return res.status(404).json({ ok: false, error: "not found" });
    const ticket = t.rows[0];

    if (STRICT_AGENT_VIEW && !isAdminUser(user)) {
      const assignee = String(ticket.assigned_to || "");
      if (assignee && assignee !== user) return res.status(403).json({ ok: false, error: "forbidden" });
    }

    await closeTicket(id);
    sseBroadcast("ticket_update", { ticket_id: id, ts: nowISO() });
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ close ticket error:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/tickets/:id/assign", requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const id = parseInt(req.params.id, 10);
    const assignee = String(req.body.assignee || "").trim();

    if (STRICT_AGENT_VIEW && !isAdminUser(user)) {
      if (assignee && assignee !== user) return res.status(403).json({ ok: false, error: "forbidden" });
    }

    await assignTicket(id, assignee || null);
    sseBroadcast("ticket_update", { ticket_id: id, ts: nowISO() });
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ assign ticket error:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ------------------------ UI pages ------------------------
function uiLayout(title, user, bodyHtml, extraHead) {
  const topRight = `
    <div style="display:flex;gap:10px;align-items:center;justify-content:flex-end;">
      <span style="font-size:13px;color:#6b7280;">${esc(user)}${isAdminUser(user) ? " (admin)" : ""}</span>
      <a href="/logout" style="text-decoration:none;">
        <button class="btn">Logout</button>
      </a>
    </div>
  `;
  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${esc(title)}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:0;background:#f6f7fb;color:#0f172a;}
    .wrap{max-width:1200px;margin:0 auto;padding:28px;}
    .row{display:flex;gap:14px;align-items:center;flex-wrap:wrap;}
    .h1{font-size:28px;font-weight:800;letter-spacing:-0.02em;margin:0;}
    .sub{color:#6b7280;font-size:13px;margin-top:4px;}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 10px 22px rgba(0,0,0,0.06);}
    .pad{padding:16px;}
    .btn{padding:10px 14px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;cursor:pointer;font-weight:600;}
    .btn.primary{background:#2563eb;border-color:#2563eb;color:#fff;}
    .btn.danger{background:#ef4444;border-color:#ef4444;color:#fff;}
    .inp,.sel{padding:10px 12px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;font-size:14px;}
    table{width:100%;border-collapse:separate;border-spacing:0;}
    th,td{padding:12px 10px;border-bottom:1px solid #eef2f7;vertical-align:top;}
    th{font-size:12px;color:#64748b;letter-spacing:.02em;text-align:left;}
    td{font-size:14px;}
    .pill{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;border:1px solid #e5e7eb;background:#f8fafc;font-size:12px;color:#0f172a;}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;}
    .muted{color:#64748b;}
    .link{color:#2563eb;text-decoration:none;font-weight:700;}
    .badge{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 8px;border-radius:999px;background:#eef2ff;color:#3730a3;font-weight:800;font-size:12px;}
    .split{display:flex;gap:16px;flex-wrap:wrap;}
    .left{flex:1;min-width:320px;}
    .right{flex:1;min-width:320px;}
    textarea{width:100%;min-height:90px;border-radius:14px;border:1px solid #e5e7eb;padding:12px;font-size:14px;}
    .msg{padding:10px 12px;border-radius:14px;border:1px solid #e5e7eb;margin:8px 0;background:#fff;}
    .msg.in{background:#f1f5f9;}
    .msg .meta{display:flex;gap:10px;font-size:12px;color:#64748b;margin-bottom:6px;}
  </style>
  ${extraHead || ""}
</head>
<body>
  <div class="wrap">
    <div class="row" style="justify-content:space-between;">
      <div>
        <div class="h1">${esc(title)}</div>
        <div class="sub">DB-backed • Version: ${esc(VERSION_MARKER)} • ${esc(title)} • ${esc(STRICT_AGENT_VIEW ? "Strict Isolation ON" : "Strict Isolation OFF")}</div>
      </div>
      ${topRight}
    </div>
    <div class="row" style="margin-top:12px;">
      <a href="/ui" style="text-decoration:none;"><button class="btn ${title==="Tickets" ? "primary" : ""}">Tickets</button></a>
      <a href="/ui/customers" style="text-decoration:none;"><button class="btn ${title==="Customers" ? "primary" : ""}">Customers</button></a>
    </div>
    <div style="height:14px;"></div>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

app.get("/ui", requireAuth, async (req, res) => {
  const user = req.session.user;
  const html = `
<div class="card pad">
  <div class="row">
    <input id="q" class="inp" placeholder="Search wa_id / last message" style="flex:1;min-width:240px;" />
    <select id="dept" class="sel">
      <option value="">All depts</option>
      <option value="presales">Pre-Sales</option>
      <option value="aftersales">After-Sales</option>
    </select>
    <select id="status" class="sel">
      <option value="">All status</option>
      <option value="open">open</option>
      <option value="closed">closed</option>
    </select>
    <select id="assignee" class="sel">
      <option value="">All assignees</option>
      <option value="${esc(PRESALES_ASSIGNEE)}">${esc(PRESALES_ASSIGNEE)}</option>
      <option value="${esc(AFTERSALES_ASSIGNEE)}">${esc(AFTERSALES_ASSIGNEE)}</option>
      <option value="${esc(user)}">Mine</option>
      <option value="__unassigned__">Unassigned</option>
    </select>
    <label class="pill"><input id="unread" type="checkbox" style="margin-right:8px;" />Unread only</label>
    <button class="btn primary" onclick="applyFilters()">Apply</button>
    <button class="btn" onclick="clearFilters()">Clear</button>
  </div>
</div>

<div style="height:14px;"></div>

<div class="card">
  <div class="pad">
    <table>
      <thead>
        <tr>
          <th>Ticket</th>
          <th>wa_id</th>
          <th>Dept</th>
          <th>Status</th>
          <th>Assignee</th>
          <th>Last time</th>
          <th>Last message</th>
        </tr>
      </thead>
      <tbody id="tbody">
        <tr><td colspan="7" class="muted">Loading…</td></tr>
      </tbody>
    </table>
  </div>
</div>

<script>
  function qs(k){ return new URLSearchParams(location.search).get(k) || ""; }
  function setEl(id, v){ const el=document.getElementById(id); if(!el) return; if(el.type==="checkbox"){ el.checked = (v==="1"); } else { el.value=v; } }

  setEl("q", qs("q"));
  setEl("dept", qs("dept"));
  setEl("status", qs("status"));
  setEl("assignee", qs("assignee"));
  setEl("unread", qs("unread"));

  function applyFilters(){
    const q = document.getElementById("q").value.trim();
    const dept = document.getElementById("dept").value;
    const status = document.getElementById("status").value;
    let assignee = document.getElementById("assignee").value;
    const unread = document.getElementById("unread").checked ? "1" : "";
    const p = new URLSearchParams();
    if(q) p.set("q", q);
    if(dept) p.set("dept", dept);
    if(status) p.set("status", status);
    if(assignee === "__unassigned__") { p.set("assignee", ""); p.set("only_unassigned","1"); }
    else if(assignee) p.set("assignee", assignee);
    if(unread) p.set("unread", unread);
    location.search = p.toString();
  }
  function clearFilters(){ location.search=""; }

  async function load(){
    const p = new URLSearchParams(location.search);
    let url = "/api/tickets";
    if(p.toString()) url += "?" + p.toString();
    const r = await fetch(url);
    const j = await r.json();
    const tbody = document.getElementById("tbody");
    if(!j.ok){
      tbody.innerHTML = '<tr><td colspan="7" class="muted">Error: '+(j.error||'')+'</td></tr>';
      return;
    }
    const rows = j.data || [];
    if(!rows.length){
      tbody.innerHTML = '<tr><td colspan="7" class="muted">No tickets yet. Send a WhatsApp message to create a ticket.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(t=>{
      const badge = (t.unread_count && t.unread_count>0) ? '<span class="badge">'+t.unread_count+'</span>' : '';
      const ass = t.assigned_to ? '<span class="pill">'+escapeHtml(t.assigned_to)+'</span>' : '<span class="pill">unassigned</span>';
      const lastTime = t.last_time ? new Date(t.last_time).toLocaleString() : '';
      return '<tr>'
        + '<td class="mono"><a class="link" href="/ui/ticket/'+t.id+'">#'+t.id+'</a> '+badge+'</td>'
        + '<td class="mono">'+escapeHtml(t.wa_id)+'</td>'
        + '<td><span class="pill">'+escapeHtml(t.department)+'</span></td>'
        + '<td><span class="pill">'+escapeHtml(t.status)+'</span></td>'
        + '<td>'+ass+'</td>'
        + '<td>'+escapeHtml(lastTime)+'</td>'
        + '<td>'+escapeHtml((t.last_message||'').slice(0,120))+'</td>'
        + '</tr>';
    }).join("");
  }

  function escapeHtml(s){
    return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
  }

  load();

  const es = new EventSource("/events");
  es.addEventListener("ticket_update", (ev) => { load(); });
</script>
`;
  res.status(200).send(uiLayout("Tickets", user, html));
});

app.get("/ui/ticket/:id", requireAuth, async (req, res) => {
  const user = req.session.user;
  const id = parseInt(req.params.id, 10);

  const t = await pool.query(`SELECT * FROM tickets WHERE id=$1`, [id]);
  if (!t.rows.length) return res.status(404).send("Not found");
  const ticket = t.rows[0];

  if (STRICT_AGENT_VIEW && !isAdminUser(user)) {
    const assignee = String(ticket.assigned_to || "");
    if (assignee && assignee !== user) return res.status(403).send("Forbidden");
  }

  const body = `
<div class="split">
  <div class="left">
    <div class="card pad">
      <div class="row" style="justify-content:space-between;">
        <div>
          <div style="font-size:18px;font-weight:800;">Ticket #${esc(ticket.id)} <span class="pill">${esc(ticket.department)}</span></div>
          <div class="sub">wa_id: <span class="mono">${esc(ticket.wa_id)}</span></div>
        </div>
        <div class="row">
          <span class="pill">Status: ${esc(ticket.status)}</span>
          <span class="pill">Assignee: ${esc(ticket.assigned_to || "unassigned")}</span>
        </div>
      </div>

      <div style="height:10px;"></div>

      <div class="row">
        <button class="btn" onclick="selfAssign()">Take</button>
        <button class="btn danger" onclick="closeTicket()">Close</button>
        <a href="/ui" class="link" style="margin-left:auto;">← Back</a>
      </div>
    </div>

    <div style="height:14px;"></div>

    <div class="card pad">
      <div id="msgs" class="muted">Loading…</div>
    </div>
  </div>

  <div class="right">
    <div class="card pad">
      <div style="font-weight:800;margin-bottom:8px;">Reply</div>
      <textarea id="reply" placeholder="Type message to WhatsApp…"></textarea>
      <div style="height:10px;"></div>
      <div class="row">
        <button class="btn primary" onclick="sendReply()">Send</button>
        <span class="muted" id="hint"></span>
      </div>
    </div>
  </div>
</div>

<script>
  const ticketId = ${JSON.stringify(ticket.id)};
  const me = ${JSON.stringify({ user, admin: isAdminUser(user), strict: STRICT_AGENT_VIEW })};

  function escapeHtml(s){
    return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
  }

  async function load(){
    const r = await fetch("/api/tickets/"+ticketId+"/messages");
    const j = await r.json();
    const box = document.getElementById("msgs");
    if(!j.ok){
      box.innerHTML = '<div class="muted">Error: '+escapeHtml(j.error||'')+'</div>';
      return;
    }
    const msgs = j.messages || [];
    if(!msgs.length){
      box.innerHTML = '<div class="muted">No messages yet.</div>';
      return;
    }
    box.innerHTML = msgs.map(m=>{
      const cls = m.direction === "incoming" ? "msg in" : "msg";
      const ts = m.created_at ? new Date(m.created_at).toLocaleString() : "";
      return '<div class="'+cls+'">'
        + '<div class="meta"><span class="pill">'+escapeHtml(m.direction)+'</span><span>'+escapeHtml(ts)+'</span></div>'
        + '<div>'+escapeHtml(m.text || "")+'</div>'
        + '</div>';
    }).join("");
  }

  async function sendReply(){
    const txt = document.getElementById("reply").value.trim();
    if(!txt) return;
    document.getElementById("hint").textContent = "Sending…";
    const r = await fetch("/api/tickets/"+ticketId+"/reply", {
      method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body: "text="+encodeURIComponent(txt)
    });
    const j = await r.json();
    if(!j.ok){
      document.getElementById("hint").textContent = "Error: " + (j.error||"");
      return;
    }
    document.getElementById("reply").value = "";
    document.getElementById("hint").textContent = "Sent";
    load();
  }

  async function closeTicket(){
    if(!confirm("Close this ticket?")) return;
    const r = await fetch("/api/tickets/"+ticketId+"/close", { method:"POST" });
    const j = await r.json();
    if(!j.ok) alert("Error: "+(j.error||""));
    else location.href="/ui";
  }

  async function selfAssign(){
    const r = await fetch("/api/tickets/"+ticketId+"/assign", {
      method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body: "assignee="+encodeURIComponent(me.user)
    });
    const j = await r.json();
    if(!j.ok) alert("Error: "+(j.error||""));
    else location.reload();
  }

  load();
  const es = new EventSource("/events");
  es.addEventListener("ticket_update", (ev)=>{ load(); });
</script>
`;
  res.status(200).send(uiLayout("Ticket Detail", user, body));
});

// ------------------------ root ------------------------
app.get("/", (req, res) => {
  res.redirect("/ui");
});

// ------------------------ start ------------------------
(async () => {
  try {
    await dbPing();
    await dbInit();

    console.log("=================================");
    console.log("🚀 Server running");
    console.log("NODE VERSION:", process.version);
    console.log("PORT:", PORT);
    console.log("VERIFY_TOKEN SET:", !!process.env.VERIFY_TOKEN);
    console.log("UI_USERS SET:", !!process.env.UI_USERS || (!!UI_USER_SINGLE && !!UI_PASS_SINGLE));
    console.log("SESSION_SECRET SET:", !!process.env.SESSION_SECRET);
    console.log("WA_TOKEN SET:", !!process.env.WA_TOKEN);
    console.log("PHONE_NUMBER_ID SET:", !!process.env.PHONE_NUMBER_ID);
    console.log("DATABASE_URL SET:", !!process.env.DATABASE_URL);
    console.log("STRICT_AGENT_VIEW:", STRICT_AGENT_VIEW);
    console.log("MEDIA DIR:", MEDIA_DIR);
    console.log("THUMBS DIR:", THUMBS_DIR);
    console.log("UPLOADS DIR:", UPLOADS_DIR);
    console.log("VERSION MARKER:", "V4_2_STABLE_2026-03-04");
    console.log("SHARP ENABLED:", !!sharp);
    console.log("=================================");

    app.listen(PORT, () => {
      console.log("✅ Server running on port", PORT);
    });
  } catch (e) {
    console.error("❌ DB init failed:", e);
    app.listen(PORT, () => console.log("⚠️ Server running WITHOUT DB on port", PORT));
  }
})();
// ------------------------ Customers aggregate API ------------------------
app.get("/api/customers", requireAuth, async (req, res) => {
  try {
    const user = req.session.user;

    const q = String(req.query.q || "").trim();
    const dept = String(req.query.dept || "").trim();
    const status = String(req.query.status || "").trim();
    const assigneeQ = String(req.query.assignee || "").trim();
    const unreadOnly = String(req.query.unread || "").trim() === "1";

    // Build a filtered tickets CTE, then aggregate by wa_id
    let where = "WHERE 1=1";
    const params = [];
    let i = 1;

    if (dept) { where += ` AND department = $${i++}`; params.push(dept); }
    if (status) { where += ` AND status = $${i++}`; params.push(status); }
    if (assigneeQ) { where += ` AND assigned_to = $${i++}`; params.push(assigneeQ); }
    if (unreadOnly) { where += ` AND COALESCE(unread_count,0) > 0`; }

    if (q) {
      where += ` AND (wa_id ILIKE $${i++} OR COALESCE(last_message,'') ILIKE $${i++})`;
      params.push(`%${q}%`, `%${q}%`);
    }

    if (STRICT_AGENT_VIEW && !isAdminUser(user)) {
      where += ` AND (COALESCE(NULLIF(assigned_to,''), '') = '' OR assigned_to = $${i++})`;
      params.push(user);
    }

    const sql = `
      WITH ft AS (
        SELECT id, wa_id, department, assigned_to, status, created_at, last_message, last_time, unread_count
        FROM tickets
        ${where}
      ),
      latest AS (
        SELECT DISTINCT ON (wa_id)
          wa_id,
          department AS last_dept,
          assigned_to AS last_assignee,
          status AS last_status,
          last_message,
          last_time,
          unread_count,
          created_at
        FROM ft
        ORDER BY wa_id, COALESCE(last_time, created_at) DESC, id DESC
      ),
      agg AS (
        SELECT
          wa_id,
          COUNT(*)::int AS ticket_count,
          SUM(CASE WHEN status='open' THEN 1 ELSE 0 END)::int AS open_count,
          SUM(COALESCE(unread_count,0))::int AS unread_total
        FROM ft
        GROUP BY wa_id
      )
      SELECT
        a.wa_id,
        a.ticket_count,
        a.open_count,
        a.unread_total,
        l.last_dept,
        l.last_assignee,
        l.last_status,
        l.last_time,
        l.last_message
      FROM agg a
      JOIN latest l USING (wa_id)
      ORDER BY COALESCE(l.last_time, l.created_at) DESC
      LIMIT 500
    `;

    const r = await pool.query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) {
    console.error("❌ /customers api error:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ------------------------ Customers UI ------------------------
app.get("/ui/customers", requireAuth, async (req, res) => {
  const user = req.session.user;
  const html = `
<div class="card pad">
  <div class="row">
    <input id="q" class="inp" placeholder="Search wa_id / last message" style="flex:1;min-width:240px;" />
    <select id="dept" class="sel">
      <option value="">All depts</option>
      <option value="presales">Pre-Sales</option>
      <option value="aftersales">After-Sales</option>
    </select>
    <select id="status" class="sel">
      <option value="">All status</option>
      <option value="open">open</option>
      <option value="closed">closed</option>
    </select>
    <select id="assignee" class="sel">
      <option value="">All assignees</option>
      <option value="${esc(PRESALES_ASSIGNEE)}">${esc(PRESALES_ASSIGNEE)}</option>
      <option value="${esc(AFTERSALES_ASSIGNEE)}">${esc(AFTERSALES_ASSIGNEE)}</option>
      <option value="${esc(user)}">Mine</option>
      <option value="__unassigned__">Unassigned</option>
    </select>
    <label class="pill"><input id="unread" type="checkbox" style="margin-right:8px;" />Unread only</label>
    <button class="btn primary" onclick="applyFilters()">Apply</button>
    <button class="btn" onclick="clearFilters()">Clear</button>
  </div>
</div>

<div style="height:14px;"></div>

<div class="card">
  <div class="pad">
    <table>
      <thead>
        <tr>
          <th>wa_id</th>
          <th>Open</th>
          <th>Tickets</th>
          <th>Last dept</th>
          <th>Last status</th>
          <th>Last assignee</th>
          <th>Last time</th>
          <th>Last message</th>
        </tr>
      </thead>
      <tbody id="rows">
        <tr><td class="muted" colspan="8">Loading...</td></tr>
      </tbody>
    </table>
  </div>
</div>

<script>
  function qs(id){ return document.getElementById(id); }
  function escapeHtml(s){ return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;"); }

  function readFilters(){
    const q = qs("q").value.trim();
    const dept = qs("dept").value.trim();
    const status = qs("status").value.trim();
    const assignee = qs("assignee").value.trim();
    const unread = qs("unread").checked ? "1" : "";
    return { q, dept, status, assignee, unread };
  }

  function setFiltersFromUrl(){
    const u = new URL(location.href);
    qs("q").value = u.searchParams.get("q") || "";
    qs("dept").value = u.searchParams.get("dept") || "";
    qs("status").value = u.searchParams.get("status") || "";
    qs("assignee").value = u.searchParams.get("assignee") || "";
    qs("unread").checked = (u.searchParams.get("unread")||"") === "1";
  }

  function applyFilters(){
    const f = readFilters();
    const u = new URL(location.href);
    Object.entries(f).forEach(([k,v]) => { if(v) u.searchParams.set(k,v); else u.searchParams.delete(k); });
    history.replaceState({}, "", u.toString());
    load();
  }
  function clearFilters(){
    qs("q").value=""; qs("dept").value=""; qs("status").value=""; qs("assignee").value=""; qs("unread").checked=false;
    const u = new URL(location.href);
    ["q","dept","status","assignee","unread"].forEach(k=>u.searchParams.delete(k));
    history.replaceState({}, "", u.toString());
    load();
  }

  async function load(){
    const f = readFilters();
    const params = new URLSearchParams();
    Object.entries(f).forEach(([k,v])=>{ if(v) params.set(k,v); });
    const r = await fetch("/api/customers?"+params.toString(), { credentials: "include" });
    const j = await r.json();
    const rowsEl = qs("rows");
    if(!j.ok){
      rowsEl.innerHTML = '<tr><td class="muted" colspan="8">'+escapeHtml(j.error||"error")+'</td></tr>';
      return;
    }
    const data = j.data || [];
    if(!data.length){
      rowsEl.innerHTML = '<tr><td class="muted" colspan="8">No customers yet.</td></tr>';
      return;
    }
    rowsEl.innerHTML = data.map(c=>{
      const lastTime = c.last_time ? new Date(c.last_time).toLocaleString() : "";
      const wa = escapeHtml(c.wa_id);
      return '<tr>'
        + '<td class="mono"><a class="link" href="/ui/customer/'+encodeURIComponent(c.wa_id)+'">'+wa+'</a></td>'
        + '<td><span class="badge">'+escapeHtml(c.open_count)+'</span></td>'
        + '<td>'+escapeHtml(c.ticket_count)+'</td>'
        + '<td><span class="pill">'+escapeHtml(c.last_dept||"")+'</span></td>'
        + '<td><span class="pill">'+escapeHtml(c.last_status||"")+'</span></td>'
        + '<td>'+(c.last_assignee?('<span class="pill">'+escapeHtml(c.last_assignee)+'</span>'):'<span class="pill">unassigned</span>')+'</td>'
        + '<td>'+escapeHtml(lastTime)+'</td>'
        + '<td>'+escapeHtml((c.last_message||"").slice(0,140))+'</td>'
        + '</tr>';
    }).join("");
  }

  setFiltersFromUrl();
  load();

  // realtime refresh via SSE (same stream as tickets)
  const es = new EventSource("/events");
  es.onmessage = (ev) => {
    try{
      const msg = JSON.parse(ev.data||"{}");
      if(msg && (msg.type==="ticket_update" || msg.type==="message")){
        load();
      }
    }catch{}
  };
</script>
`;
  res.status(200).send(uiLayout("Customers", user, html));
});

// Customer detail page: list tickets for one wa_id (filtered by strict view)
app.get("/ui/customer/:wa", requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const wa = String(req.params.wa || "").trim();
    if (!wa) return res.status(400).send("Bad wa_id");

    let sql = `SELECT id, wa_id, department, assigned_to, status, created_at, last_message, last_time, unread_count
               FROM tickets WHERE wa_id = $1`;
    const params = [wa];
    let i = 2;

    if (STRICT_AGENT_VIEW && !isAdminUser(user)) {
      sql += ` AND (COALESCE(NULLIF(assigned_to,''), '') = '' OR assigned_to = $${i++})`;
      params.push(user);
    }

    sql += ` ORDER BY COALESCE(last_time, created_at) DESC, id DESC`;

    const r = await pool.query(sql, params);

    const rows = (r.rows || []).map(t => {
      const badge = (t.unread_count || 0) > 0 ? `<span class="badge">${esc(t.unread_count)}</span>` : "";
      const ass = t.assigned_to ? `<span class="pill">${esc(t.assigned_to)}</span>` : `<span class="pill">unassigned</span>`;
      const lastTime = t.last_time ? new Date(t.last_time).toLocaleString() : "";
      return `<tr>
        <td class="mono"><a class="link" href="/ui/ticket/${t.id}">#${t.id}</a> ${badge}</td>
        <td><span class="pill">${esc(t.department)}</span></td>
        <td><span class="pill">${esc(t.status)}</span></td>
        <td>${ass}</td>
        <td>${esc(lastTime)}</td>
        <td>${esc((t.last_message||"").slice(0,140))}</td>
      </tr>`;
    }).join("");

    const html = `
<div class="card pad">
  <div class="row" style="justify-content:space-between;">
    <div>
      <div class="h1" style="font-size:20px;">Customer: <span class="mono">${esc(wa)}</span></div>
      <div class="sub">Tickets for this customer</div>
    </div>
    <a href="/ui/customers" style="text-decoration:none;"><button class="btn">← Back</button></a>
  </div>
</div>

<div style="height:14px;"></div>

<div class="card">
  <div class="pad">
    <table>
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Dept</th>
          <th>Status</th>
          <th>Assignee</th>
          <th>Last time</th>
          <th>Last message</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td class="muted" colspan="6">No tickets visible for this customer.</td></tr>`}
      </tbody>
    </table>
  </div>
</div>

<script>
  // simple live refresh on events
  const es = new EventSource("/events");
  es.onmessage = () => { location.reload(); };
</script>
`;
    res.status(200).send(uiLayout("Customers", user, html));
  } catch (e) {
    console.error("❌ /ui/customer error:", e);
    res.status(500).send("Internal error");
  }
});

