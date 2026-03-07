#!/usr/bin/env node
/**
 * Voltgo Support System V4.7.0 (Railway + PostgreSQL + WhatsApp Cloud API)
 * Light UI + Customer Profile + Ticket Notes + Ticket Auto-Reopen
 */
require("dotenv").config();
const APP_VERSION = "V4.8.7_CUSTOMERS_SSE_BADGE";
console.log("✅ LOADED SERVER.JS: " + APP_VERSION + " (2026-03-06)");

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const multer = require("multer");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");

// Optional OpenAI
let OpenAI = null;
let openai = null;
if (process.env.OPENAI_API_KEY) {
  try {
    OpenAI = require("openai");
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log("✅ OpenAI enabled for routing");
  } catch (e) {
    console.warn("⚠️ OPENAI_API_KEY set but 'openai' package missing. Run: npm i openai");
  }
}

// Optional sharp
let sharp = null;
try {
  sharp = require("sharp");
  console.log("✅ sharp enabled: thumbnails will be generated");
} catch (e) {
  console.log("ℹ️ sharp not installed: thumbnails disabled (ok)");
}

// Optional form-data
let FormDataPkg = null;
try {
  FormDataPkg = require("form-data");
  console.log("✅ form-data enabled: media upload uses streams");
} catch (e) {
  console.log("ℹ️ form-data not installed: will try native FormData fallback");
}

const app = express();
app.set("trust proxy", 1);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// -------- env helpers --------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error("Missing .env variable:", name);
    process.exit(1);
  }
  return v;
}

const VERIFY_TOKEN = requireEnv("VERIFY_TOKEN");
const WA_TOKEN = requireEnv("WA_TOKEN");
const PHONE_NUMBER_ID = requireEnv("PHONE_NUMBER_ID");
const DATABASE_URL = requireEnv("DATABASE_URL");

const SESSION_SECRET = process.env.SESSION_SECRET || "voltgo_super_secret_key";
const UI_USER_FALLBACK = process.env.UI_USER || "admin";
const UI_PASS_FALLBACK = process.env.UI_PASS || "voltgo123";
const PRESALES_ASSIGNEE = process.env.PRESALES_ASSIGNEE || "presales";
const AFTERSALES_ASSIGNEE = process.env.AFTERSALES_ASSIGNEE || "aftersales";
const STRICT_AGENT_VIEW = String(process.env.STRICT_AGENT_VIEW || "1") === "1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "1") === "1";

// -------- dirs --------
const LOGS_DIR = path.join(process.cwd(), "logs");
const UPLOADS_DIR = path.join(LOGS_DIR, "uploads");
const MEDIA_DIR = path.join(LOGS_DIR, "media");
const THUMBS_DIR = path.join(MEDIA_DIR, "__thumbs");
for (const d of [LOGS_DIR, UPLOADS_DIR, MEDIA_DIR, THUMBS_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 40 * 1024 * 1024 } });

app.use("/media", express.static(MEDIA_DIR, { fallthrough: true }));

function todayFolder() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function safeExtFromMime(mime, fallback = "") {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "." + m.split("/")[1].replace("jpeg","jpg");
  if (m.startsWith("video/")) return "." + m.split("/")[1];
  if (m.startsWith("audio/")) return "." + m.split("/")[1];
  if (m === "application/pdf") return ".pdf";
  return fallback || "";
}
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// -------- DB --------
const pool = new Pool({ connectionString: DATABASE_URL });

async function dbPing() {
  const c = await pool.connect();
  try { await c.query("SELECT 1"); } finally { c.release(); }
}

async function columnExists(table, column) {
  const r = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1",
    [table, column]
  );
  return r.rows.length > 0;
}

// ---- schema compatibility flags (support older V4.6 DB) ----
let SCHEMA = {
  messages_has_conversation_id: false,
  tickets_has_conversation_id: false,
  has_conversations_table: false
};

async function tableExists(table) {
  const r = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1",
    [table]
  );
  return r.rows.length > 0;
}

async function detectSchema() {
  try {
    SCHEMA.has_conversations_table = await tableExists("conversations");
  } catch (_) {}
  try {
    SCHEMA.messages_has_conversation_id = await columnExists("messages", "conversation_id");
  } catch (_) {}
  try {
    SCHEMA.tickets_has_conversation_id = await columnExists("tickets", "conversation_id");
  } catch (_) {}
  console.log("🧩 Schema detect:", SCHEMA);

// Determine tickets department column name (legacy DBs may use 'department' instead of 'dept')
async function getTicketsDeptColumn() {
  if (await columnExists("tickets", "dept").catch(()=>false)) return "dept";
  if (await columnExists("tickets", "department").catch(()=>false)) return "department";
  return "dept";
}
}

async function addColumnIfMissing(table, column, ddl) {
  const ok = await columnExists(table, column);
  if (ok) return false;
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
  return true;
}

async function ensureBaseTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      wa_id TEXT PRIMARY KEY,
      name TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id BIGSERIAL PRIMARY KEY,
      wa_id TEXT NOT NULL REFERENCES customers(wa_id) ON DELETE CASCADE,
      dept TEXT,
      status TEXT,
      assignee TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      last_message_at TIMESTAMP,
      last_message TEXT,
      unread_count INT DEFAULT 0,
      tags TEXT[] DEFAULT ARRAY[]::TEXT[]
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      wa_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      msg_type TEXT NOT NULL DEFAULT 'text',
      text TEXT,
      caption TEXT,
      media_path TEXT,
      thumb_path TEXT,
      wa_message_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id BIGSERIAL PRIMARY KEY,
      wa_id TEXT NOT NULL REFERENCES customers(wa_id) ON DELETE CASCADE,
      dept TEXT,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      last_message_at TIMESTAMP,
      last_message TEXT,
      unread_count INT DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_notes (
      id BIGSERIAL PRIMARY KEY,
      ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      author TEXT,
      note TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function migrateSchema() {
  await addColumnIfMissing("customers", "name", "name TEXT");
  await addColumnIfMissing("customers", "notes", "notes TEXT");
  await addColumnIfMissing("customers", "created_at", "created_at TIMESTAMP DEFAULT NOW()");
  await addColumnIfMissing("customers", "updated_at", "updated_at TIMESTAMP DEFAULT NOW()");

  await addColumnIfMissing("tickets", "dept", "dept TEXT");
  await addColumnIfMissing("tickets", "status", "status TEXT DEFAULT 'open'");
  await addColumnIfMissing("tickets", "assignee", "assignee TEXT");
  await addColumnIfMissing("tickets", "created_at", "created_at TIMESTAMP DEFAULT NOW()");
  await addColumnIfMissing("tickets", "updated_at", "updated_at TIMESTAMP DEFAULT NOW()");
  await addColumnIfMissing("tickets", "last_message_at", "last_message_at TIMESTAMP");
  await addColumnIfMissing("tickets", "last_message", "last_message TEXT");
  await addColumnIfMissing("tickets", "unread_count", "unread_count INT DEFAULT 0");
  await addColumnIfMissing("tickets", "tags", "tags TEXT[] DEFAULT ARRAY[]::TEXT[]");
  await addColumnIfMissing("tickets", "conversation_id", "conversation_id BIGINT");

    await addColumnIfMissing("messages", "conversation_id", "conversation_id BIGINT");
await addColumnIfMissing("messages", "msg_type", "msg_type TEXT DEFAULT 'text'");
  await addColumnIfMissing("messages", "caption", "caption TEXT");
  await addColumnIfMissing("messages", "media_path", "media_path TEXT");
  await addColumnIfMissing("messages", "thumb_path", "thumb_path TEXT");
  await addColumnIfMissing("messages", "wa_message_id", "wa_message_id TEXT");
  await addColumnIfMissing("messages", "created_at", "created_at TIMESTAMP DEFAULT NOW()");
  // conversations table compatibility (legacy V4.6 DBs may have a minimal conversations table)
  try { await pool.query("CREATE TABLE IF NOT EXISTS conversations (id BIGSERIAL PRIMARY KEY, wa_id TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())"); } catch (_) {}
  await addColumnIfMissing("conversations", "wa_id", "wa_id TEXT");
  await addColumnIfMissing("conversations", "dept", "dept TEXT");
  await addColumnIfMissing("conversations", "status", "status TEXT DEFAULT 'open'");
  await addColumnIfMissing("conversations", "created_at", "created_at TIMESTAMP DEFAULT NOW()");
  await addColumnIfMissing("conversations", "updated_at", "updated_at TIMESTAMP DEFAULT NOW()");
  await addColumnIfMissing("conversations", "last_message_at", "last_message_at TIMESTAMP");
  await addColumnIfMissing("conversations", "last_message", "last_message TEXT");
  await addColumnIfMissing("conversations", "unread_count", "unread_count INT DEFAULT 0");

  await pool.query(
    "UPDATE tickets SET dept = CASE " +
      "WHEN dept IS NOT NULL AND dept<>'' THEN dept " +
      "WHEN assignee=$1 THEN 'presales' " +
      "WHEN assignee=$2 THEN 'aftersales' " +
      "ELSE 'presales' END " +
    "WHERE dept IS NULL OR dept='';",
    [PRESALES_ASSIGNEE, AFTERSALES_ASSIGNEE]
  );

  await pool.query("UPDATE tickets SET status='open' WHERE status IS NULL OR status='';");
  await pool.query("UPDATE tickets SET status='open' WHERE status NOT IN ('open','pending','closed');");

  await pool.query("UPDATE messages SET direction='incoming' WHERE direction IS NULL OR direction='';");
  await pool.query("UPDATE messages SET direction='incoming' WHERE direction NOT IN ('incoming','outgoing');");

  try { await pool.query("ALTER TABLE tickets ADD CONSTRAINT tickets_dept_check CHECK (dept IN ('presales','aftersales'));"); } catch (_) {}
  try { await pool.query("ALTER TABLE tickets ADD CONSTRAINT tickets_status_check CHECK (status IN ('open','pending','closed'));"); } catch (_) {}
  try { await pool.query("ALTER TABLE messages ADD CONSTRAINT messages_direction_check CHECK (direction IN ('incoming','outgoing'));"); } catch (_) {}
  await addColumnIfMissing("tickets", "dept", "dept TEXT");
  await addColumnIfMissing("tickets", "department", "department TEXT");

}

async function ensureSessionTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    );
  `);
  try { await pool.query(`ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid");`); } catch (_) {}
  try { await pool.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");`); } catch (_) {}
}

async function ensureIndexes() {
  try { await pool.query("CREATE INDEX IF NOT EXISTS idx_tickets_wa_id ON tickets(wa_id);"); } catch (_) {}
  try { await pool.query("CREATE INDEX IF NOT EXISTS idx_tickets_dept ON tickets(dept);"); } catch (_) {}
  try { await pool.query("CREATE INDEX IF NOT EXISTS idx_messages_ticket_id ON messages(ticket_id);"); } catch (_) {}
  try { await pool.query("CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);"); } catch (_) {}
  try { await pool.query("CREATE INDEX IF NOT EXISTS idx_ticket_notes_ticket_id ON ticket_notes(ticket_id);"); } catch (_) {}
  try { await pool.query("CREATE INDEX IF NOT EXISTS idx_ticket_notes_created_at ON ticket_notes(created_at);"); } catch (_) {}

  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_wa_message_id
      ON messages(wa_message_id)
      WHERE wa_message_id IS NOT NULL AND wa_message_id <> '';
    `);
  } catch (_) {}

  // ---- WA message de-dup (needs a UNIQUE index for ON CONFLICT (wa_message_id)) ----
  // 1) Clean duplicates if any (keep the smallest id per wa_message_id)
  try {
    await pool.query(`
      WITH dups AS (
        SELECT wa_message_id, MIN(id) AS keep_id
        FROM messages
        WHERE wa_message_id IS NOT NULL AND wa_message_id <> ''
        GROUP BY wa_message_id
        HAVING COUNT(*) > 1
      )
      DELETE FROM messages m
      USING dups d
      WHERE m.wa_message_id = d.wa_message_id
        AND m.id <> d.keep_id;
    `);
  } catch (_) {}

  // 2) Create a normal UNIQUE index (Postgres allows multiple NULLs, so this is safe)
  //    This makes: INSERT ... ON CONFLICT (wa_message_id) DO NOTHING work.
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_wa_message_id_full
      ON messages(wa_message_id);
    `);
  } catch (_) {}

}

// -------- auth/users --------
function parseUiUsers() {
  const raw = (process.env.UI_USERS || "").trim();
  const map = {};
  if (!raw) return null;
  raw.split(",").map(x => x.trim()).filter(Boolean).forEach(pair => {
    const idx = pair.indexOf(":");
    if (idx > 0) {
      const u = pair.slice(0, idx).trim();
      const p = pair.slice(idx + 1).trim();
      if (u && p) map[u] = p;
    }
  });
  return Object.keys(map).length ? map : null;
}
const UI_USERS_MAP = parseUiUsers();

function getUser(req) {
  return (req.session && req.session.user) ? req.session.user : null;
}
function requireAuth(req, res, next) {
  if (!getUser(req)) return res.redirect("/login");
  return next();
}
function userDept(username) {
  if (!username) return null;
  if (username === PRESALES_ASSIGNEE) return "presales";
  if (username === AFTERSALES_ASSIGNEE) return "aftersales";
  return null;
}

// -------- session (PG store) --------
app.use(
  session({
    store: new pgSession({ pool: pool, tableName: "session" }),
    name: "vltgo.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: COOKIE_SECURE, maxAge: 1000 * 60 * 60 * 24 * 7 }
  })
);

// -------- SSE --------
const sseClients = new Set();
function sseSend(type, payload) {
  const data = JSON.stringify({ type, payload, ts: new Date().toISOString() });
  for (const c of sseClients) {
    try {
      c.res.write("event: " + type + "\n");
      c.res.write("data: " + data + "\n\n");
    } catch (_) {}
  }
}
app.get("/sse", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const client = { res, user: getUser(req) };
  sseClients.add(client);
  res.write("event: hello\n");
  res.write("data: " + JSON.stringify({ ok: true, user: client.user, ts: new Date().toISOString() }) + "\n\n");
  req.on("close", () => sseClients.delete(client));
});
function broadcastCustomersUpdate(wa_id = null) {
  sseSend("customers", {
    changed: true,
    wa_id: wa_id || null,
    version: APP_VERSION,
    ts: Date.now()
  });
}

// -------- WhatsApp helpers --------
async function waGraphGet(url) {
  const resp = await fetch(url, { method: "GET", headers: { "Authorization": "Bearer " + WA_TOKEN } });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("waGraphGet failed: " + resp.status);
  return json;
}
async function waDownloadFile(url, localPath) {
  const resp = await fetch(url, { headers: { "Authorization": "Bearer " + WA_TOKEN } });
  if (!resp.ok) throw new Error("waDownloadFile failed: " + resp.status);
  await fsp.mkdir(path.dirname(localPath), { recursive: true });
  const buf = Buffer.from(await resp.arrayBuffer());
  await fsp.writeFile(localPath, buf);
  return localPath;
}
async function waSendText(toWaId, text) {
  const url = "https://graph.facebook.com/v20.0/" + encodeURIComponent(PHONE_NUMBER_ID) + "/messages";
  const body = { messaging_product: "whatsapp", to: String(toWaId), type: "text", text: { body: String(text) } };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Authorization": "Bearer " + WA_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("waSendText failed: " + resp.status);
  return json;
}
function mimeToMsgType(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "document";
}
async function waUploadMedia(localFilePath, mimeType) {
  const url = "https://graph.facebook.com/v20.0/" + encodeURIComponent(PHONE_NUMBER_ID) + "/media";
  if (FormDataPkg) {
    const form = new FormDataPkg();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType || "application/octet-stream");
    form.append("file", fs.createReadStream(localFilePath));
    const resp = await fetch(url, { method: "POST", headers: { "Authorization": "Bearer " + WA_TOKEN, ...form.getHeaders() }, body: form });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.id) throw new Error("waUploadMedia failed: " + resp.status);
    return json.id;
  }
  if (typeof FormData === "undefined") throw new Error("FormData not available. Install form-data: npm i form-data");
  const fd = new FormData();
  fd.append("messaging_product", "whatsapp");
  fd.append("type", mimeType || "application/octet-stream");
  const buf = await fsp.readFile(localFilePath);
  const filename = path.basename(localFilePath);
  if (typeof Blob === "undefined") throw new Error("Blob not available. Install form-data: npm i form-data");
  fd.append("file", new Blob([buf], { type: mimeType || "application/octet-stream" }), filename);
  const resp = await fetch(url, { method: "POST", headers: { "Authorization": "Bearer " + WA_TOKEN }, body: fd });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.id) throw new Error("waUploadMedia failed: " + resp.status);
  return json.id;
}
async function waSendMediaMessage(toWaId, mediaId, mimeType, caption) {
  const msgType = mimeToMsgType(mimeType);
  const url = "https://graph.facebook.com/v20.0/" + encodeURIComponent(PHONE_NUMBER_ID) + "/messages";
  const payload = { messaging_product: "whatsapp", to: String(toWaId), type: msgType };
  payload[msgType] = { id: String(mediaId) };
  if (caption && (msgType === "image" || msgType === "video" || msgType === "document")) payload[msgType].caption = String(caption).slice(0, 1024);
  const resp = await fetch(url, { method: "POST", headers: { "Authorization": "Bearer " + WA_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("waSendMediaMessage failed: " + resp.status);
  return { msgType, sendResp: json };
}

// Optional signature verify
function verifyAppSecret(req, rawBody) {
  const secret = process.env.APP_SECRET;
  if (!secret) return true;
  const sig = req.get("x-hub-signature-256");
  if (!sig) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// -------- routing --------
const ROUTE_HINTS = {
  presales: ["price","quote","cost","wholesale","dealer","buy","order","discount","lead"],
  aftersales: ["support","warranty","broken","issue","problem","return","rma","bms","charge","charging","fault","help"]
};
function keywordRoute(text) {
  const t = String(text || "").toLowerCase();
  for (const w of ROUTE_HINTS.presales) if (t.includes(w)) return "presales";
  for (const w of ROUTE_HINTS.aftersales) if (t.includes(w)) return "aftersales";
  return "unknown";
}
async function aiRoute(text) {
  if (!openai) return "unknown";
  const msg = String(text || "").slice(0, 1200);
  const prompt =
    "Classify the customer message for a battery company into one of:\n" +
    "- presales (pricing, dealer, wholesale, buying, order)\n" +
    "- aftersales (support, warranty, troubleshooting, defective, install)\n" +
    "- unknown\n\n" +
    "Return only one word: presales | aftersales | unknown\n\n" +
    "Message:\n" + msg;
  try {
    const res = await openai.chat.completions.create({ model: OPENAI_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0 });
    const out = String(res.choices?.[0]?.message?.content || "").trim().toLowerCase();
    if (out.includes("presales")) return "presales";
    if (out.includes("aftersales")) return "aftersales";
    return "unknown";
  } catch (_) {
    return "unknown";
  }
}

async function ensureCustomer(wa_id) {
  await pool.query("INSERT INTO customers(wa_id) VALUES($1) ON CONFLICT (wa_id) DO NOTHING", [String(wa_id)]);
}
async function setCustomerNameIfEmpty(wa_id, name) {
  const n = String(name || "").trim();
  if (!n) return;
  await pool.query("UPDATE customers SET name=$2, updated_at=NOW() WHERE wa_id=$1 AND (name IS NULL OR name='')", [String(wa_id), n.slice(0, 120)]);
}
async function createTicketOrReopen(wa_id, dept, assignee) {
  const wa = String(wa_id);
  const d = (dept && String(dept).trim()) ? String(dept).trim() : "presales";
  const deptCol = (await columnExists('tickets','dept').catch(()=>false)) ? 'dept' : ((await columnExists('tickets','department').catch(()=>false)) ? 'department' : 'dept');

  // 1) Try find an existing open/pending ticket for this wa_id and dept
  try {
    const q = `SELECT id FROM tickets WHERE wa_id=$1 AND ${deptCol}=$2 AND status IN ('open','pending') ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`;
    const r = await pool.query(q, [wa, d]);
    if (r.rows.length) return r.rows[0].id;
  } catch (_) {}

  // 2) Reopen latest closed ticket if exists
  try {
    const q = `SELECT id FROM tickets WHERE wa_id=$1 AND ${deptCol}=$2 AND status='closed' ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`;
    const r = await pool.query(q, [wa, d]);
    if (r.rows.length) {
      const id = r.rows[0].id;
      await pool.query("UPDATE tickets SET status='open', updated_at=NOW() WHERE id=$1", [id]).catch(()=>{});
      return id;
    }
  } catch (_) {}

  // 3) Create new ticket
  const hasAssignee = await columnExists("tickets", "assignee").catch(()=>false);
  const hasTags = await columnExists("tickets", "tags").catch(()=>false);

  if (hasAssignee && hasTags) {
    const q = `INSERT INTO tickets(wa_id, ${deptCol}, status, created_at, updated_at, unread_count, assignee, tags)
               VALUES($1,$2,'open',NOW(),NOW(),0,$3,COALESCE($4, ARRAY[]::text[])) RETURNING id`;
    const r = await pool.query(q, [wa, d, assignee || null, null]);
    return r.rows[0].id;
  }
  if (hasAssignee && !hasTags) {
    const q = `INSERT INTO tickets(wa_id, ${deptCol}, status, created_at, updated_at, unread_count, assignee)
               VALUES($1,$2,'open',NOW(),NOW(),0,$3) RETURNING id`;
    const r = await pool.query(q, [wa, d, assignee || null]);
    return r.rows[0].id;
  }
  if (!hasAssignee && hasTags) {
    const q = `INSERT INTO tickets(wa_id, ${deptCol}, status, created_at, updated_at, unread_count, tags)
               VALUES($1,$2,'open',NOW(),NOW(),0,COALESCE($3, ARRAY[]::text[])) RETURNING id`;
    const r = await pool.query(q, [wa, d, null]);
    return r.rows[0].id;
  }
  const q = `INSERT INTO tickets(wa_id, ${deptCol}, status, created_at, updated_at, unread_count)
             VALUES($1,$2,'open',NOW(),NOW(),0) RETURNING id`;
  const r = await pool.query(q, [wa, d]);
  return r.rows[0].id;
}

async function getOrCreateConversation(wa_id, dept) {
  // Ultra-robust legacy compatibility:
  // - Some DBs use conversations.id = wa_id (PK), even if a wa_id column exists.
  // - Some DBs have wa_id column + serial id.
  // - Some DBs have minimal columns.
  const hasWaId = await columnExists("conversations", "wa_id").catch(()=>false);
  const hasDept = await columnExists("conversations", "dept").catch(()=>false);
  const hasStatus = await columnExists("conversations", "status").catch(()=>false);
  const hasUpdated = await columnExists("conversations", "updated_at").catch(()=>false);
  const hasLastMsgAt = await columnExists("conversations", "last_message_at").catch(()=>false);

  const wid = String(wa_id);

  async function touchWhereIdIsWaId() {
    // If id is used as wa_id, prefer to reuse it.
    if (!/^\d+$/.test(wid)) return null;
    try {
      const r = await pool.query("SELECT id FROM conversations WHERE id=$1::bigint LIMIT 1", [wid]);
      if (r.rows.length) {
        const idVal = r.rows[0].id;
        if (hasUpdated || hasLastMsgAt) {
          const sets=[];
          if (hasUpdated) sets.push("updated_at=NOW()");
          if (hasLastMsgAt) sets.push("last_message_at=NOW()");
          await pool.query("UPDATE conversations SET "+sets.join(", ")+" WHERE id=$1", [idVal]).catch(()=>{});
        }
        return idVal;
      }
    } catch (_) {}
    return null;
  }

  // 0) First, ALWAYS try legacy "id = wa_id" reuse (this avoids duplicate PK errors entirely)
  const legacyId = await touchWhereIdIsWaId();
  if (legacyId) return legacyId;

  // --- Case A: no wa_id column, classic legacy table id=wa_id ---
  if (!hasWaId) {
    // upsert by PK=id
    const cols = ["id"]; const vals = ["$1"]; const params=[wid];
    if (hasStatus) { cols.push("status"); vals.push("'open'"); }
    if (hasUpdated) { cols.push("updated_at"); vals.push("NOW()"); }
    if (hasLastMsgAt) { cols.push("last_message_at"); vals.push("NOW()"); }
    const updateSet = (hasUpdated || hasLastMsgAt) ? [
      hasUpdated ? "updated_at=NOW()" : null,
      hasLastMsgAt ? "last_message_at=NOW()" : null
    ].filter(Boolean).join(", ") : "id=EXCLUDED.id";

    const sql =
      "INSERT INTO conversations(" + cols.join(",") + ") VALUES(" + vals.join(",") + ") " +
      "ON CONFLICT (id) DO UPDATE SET " + updateSet + " RETURNING id";
    const ins = await pool.query(sql, params);
    return ins.rows[0].id;
  }

  // --- Case B: normal table with wa_id column ---
  const whereDept = hasDept ? " AND COALESCE(dept,'')=$2 " : "";
  const paramsOpen = hasDept ? [wid, String(dept||'')] : [wid];
  const statusClauseOpen = hasStatus ? " AND COALESCE(status,'open') IN ('open','pending') " : "";

  // 1) Find open/pending
  try {
    const r = await pool.query(
      "SELECT id FROM conversations WHERE wa_id=$1" + whereDept + statusClauseOpen +
      " ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1",
      paramsOpen
    );
    if (r.rows.length) return r.rows[0].id;
  } catch (_) {}

  // 2) Create new (but guard against duplicate PK by catching 23505 and re-selecting)
  try {
    if (hasDept && hasStatus) {
      const ins = await pool.query(
        "INSERT INTO conversations(wa_id, dept, status, last_message_at, unread_count) VALUES($1,$2,'open',NOW(),0) RETURNING id",
        [wid, String(dept||'')]
      );
      return ins.rows[0].id;
    }
    if (hasDept && !hasStatus) {
      const ins = await pool.query(
        "INSERT INTO conversations(wa_id, dept, last_message_at, unread_count) VALUES($1,$2,NOW(),0) RETURNING id",
        [wid, String(dept||'')]
      );
      return ins.rows[0].id;
    }
    if (!hasDept && hasStatus) {
      const ins = await pool.query(
        "INSERT INTO conversations(wa_id, status, last_message_at, unread_count) VALUES($1,'open',NOW(),0) RETURNING id",
        [wid]
      );
      return ins.rows[0].id;
    }
    const ins = await pool.query("INSERT INTO conversations(wa_id) VALUES($1) RETURNING id", [wid]);
    return ins.rows[0].id;
  } catch (e) {
    // If the DB uses id=wa_id, an insert can collide; just reuse the existing row.
    if (String(e && e.code) === "23505") {
      const again = await touchWhereIdIsWaId();
      if (again) return again;
      // fallback: try select by wa_id
      try {
        const r = await pool.query("SELECT id FROM conversations WHERE wa_id=$1 ORDER BY id DESC LIMIT 1", [wid]);
        if (r.rows.length) return r.rows[0].id;
      } catch (_) {}
    }
    throw e;
  }
}

async function ensureTicketConversation(ticket_id, wa_id, dept) {
  // If DB doesn't have tickets.conversation_id, just return null
  const hasCol = await columnExists("tickets", "conversation_id").catch(()=>false);
  if (!hasCol) return null;

  const r = await pool.query("SELECT conversation_id FROM tickets WHERE id=$1 LIMIT 1", [Number(ticket_id)]);
  const existing = r.rows[0]?.conversation_id ?? null;
  if (existing) return Number(existing);

  // Create conversation and bind
  const cid = await getOrCreateConversation(wa_id, dept);
  await pool.query("UPDATE tickets SET conversation_id=$2 WHERE id=$1", [Number(ticket_id), Number(cid)]);
  return Number(cid);
}

async function markTicketNeedRoute(ticket_id) {
  // Don't hide tickets by marking them pending (UI filters often hide pending).
  // Instead, keep status open and add a tag 'need_route'.
  try {
    const hasStatus = await columnExists("tickets","status").catch(()=>false);
    const hasTags = await columnExists("tickets","tags").catch(()=>false);

    if (hasStatus && hasTags) {
      await pool.query(
        "UPDATE tickets SET status=COALESCE(status,'open'), tags = (CASE WHEN tags IS NULL THEN ARRAY['need_route']::text[] WHEN NOT ('need_route'=ANY(tags)) THEN array_append(tags,'need_route') ELSE tags END), updated_at=NOW() WHERE id=$1",
        [Number(ticket_id)]
      );
    } else if (hasTags) {
      await pool.query(
        "UPDATE tickets SET tags = (CASE WHEN tags IS NULL THEN ARRAY['need_route']::text[] WHEN NOT ('need_route'=ANY(tags)) THEN array_append(tags,'need_route') ELSE tags END), updated_at=NOW() WHERE id=$1",
        [Number(ticket_id)]
      );
    } else if (hasStatus) {
      await pool.query("UPDATE tickets SET status=COALESCE(status,'open'), updated_at=NOW() WHERE id=$1", [Number(ticket_id)]);
    }
  } catch (_) {}
}
async function bumpTicketOnIncoming(ticket_id, text) {
  await pool.query("UPDATE tickets SET last_message_at=NOW(), last_message=$2, unread_count=COALESCE(unread_count,0)+1, updated_at=NOW() WHERE id=$1", [ticket_id, String(text || "").slice(0, 600)]);
  // Mirror to conversations if bound
  try {
    const hasCol = await columnExists("tickets","conversation_id").catch(()=>false);
    if (!hasCol) return;
    const r = await pool.query("SELECT conversation_id FROM tickets WHERE id=$1 LIMIT 1", [Number(ticket_id)]);
    const cid = r.rows[0]?.conversation_id;
    if (cid) {
      await pool.query("UPDATE conversations SET last_message_at=NOW(), last_message=$2, unread_count=COALESCE(unread_count,0)+1, updated_at=NOW() WHERE id=$1", [Number(cid), String(text || "").slice(0, 600)]);
    }
  } catch (_) {}
}
async function bumpTicketOnOutgoing(ticket_id, text) {
  await pool.query("UPDATE tickets SET last_message_at=NOW(), last_message=$2, updated_at=NOW() WHERE id=$1", [ticket_id, String(text || "").slice(0, 600)]);
  // Mirror to conversations if bound
  try {
    const hasCol = await columnExists("tickets","conversation_id").catch(()=>false);
    if (!hasCol) return;
    const r = await pool.query("SELECT conversation_id FROM tickets WHERE id=$1 LIMIT 1", [Number(ticket_id)]);
    const cid = r.rows[0]?.conversation_id;
    if (cid) {
      await pool.query("UPDATE conversations SET last_message_at=NOW(), last_message=$2, updated_at=NOW() WHERE id=$1", [Number(cid), String(text || "").slice(0, 600)]);
    }
  } catch (_) {}
}
async function insertMessage({ ticket_id, wa_id, dept, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id, conversation_id }) {
  const wmid = (wa_message_id ?? null);
  let cid = (conversation_id ?? null);

  const hasTicketId = await columnExists("messages", "ticket_id").catch(()=>false);
  const hasConversationId = await columnExists("messages", "conversation_id").catch(()=>false);

  // If conversation_id exists, some legacy schemas require it NOT NULL.
  if (hasConversationId && !cid) {
    cid = await getOrCreateConversation(wa_id, dept || "");
  }

  // If BOTH columns exist, write BOTH so old/new readers both work.
  if (hasTicketId && hasConversationId && ticket_id && cid) {
    if (wmid && String(wmid).trim()) {
      const r = await pool.query(
        "INSERT INTO messages(ticket_id, conversation_id, wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (wa_message_id) DO NOTHING RETURNING id",
        [Number(ticket_id), Number(cid), String(wa_id), String(direction), String(msg_type||"text"), text ?? null, caption ?? null, media_path ?? null, thumb_path ?? null, String(wmid)]
      );
      return r.rows[0]?.id || null;
    }
    const r = await pool.query(
      "INSERT INTO messages(ticket_id, conversation_id, wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
      [Number(ticket_id), Number(cid), String(wa_id), String(direction), String(msg_type||"text"), text ?? null, caption ?? null, media_path ?? null, thumb_path ?? null, null]
    );
    return r.rows[0]?.id || null;
  }

  if (hasTicketId && ticket_id && !hasConversationId) {
    if (wmid && String(wmid).trim()) {
      const r = await pool.query(
        "INSERT INTO messages(ticket_id, wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (wa_message_id) DO NOTHING RETURNING id",
        [Number(ticket_id), String(wa_id), String(direction), String(msg_type||"text"), text ?? null, caption ?? null, media_path ?? null, thumb_path ?? null, String(wmid)]
      );
      return r.rows[0]?.id || null;
    }
    const r = await pool.query(
      "INSERT INTO messages(ticket_id, wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
      [Number(ticket_id), String(wa_id), String(direction), String(msg_type||"text"), text ?? null, caption ?? null, media_path ?? null, thumb_path ?? null, null]
    );
    return r.rows[0]?.id || null;
  }

  if (hasConversationId && cid) {
    if (wmid && String(wmid).trim()) {
      const r = await pool.query(
        "INSERT INTO messages(conversation_id, wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (wa_message_id) DO NOTHING RETURNING id",
        [Number(cid), String(wa_id), String(direction), String(msg_type||"text"), text ?? null, caption ?? null, media_path ?? null, thumb_path ?? null, String(wmid)]
      );
      return r.rows[0]?.id || null;
    }
    const r = await pool.query(
      "INSERT INTO messages(conversation_id, wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
      [Number(cid), String(wa_id), String(direction), String(msg_type||"text"), text ?? null, caption ?? null, media_path ?? null, thumb_path ?? null, null]
    );
    return r.rows[0]?.id || null;
  }

  throw new Error("messages schema unsupported: cannot resolve ticket_id / conversation_id");
}

// -------- webhook verify/receive --------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

async function downloadInboundMedia(kind, m, wa_id) {
  const mediaObj = m[kind];
  const mediaId = mediaObj?.id;
  if (!mediaId) return { media_path: null, thumb_path: null, caption: null, mimeType: "" };

  const meta = await waGraphGet("https://graph.facebook.com/v20.0/" + encodeURIComponent(mediaId));
  const url = meta?.url;
  const mimeType = meta?.mime_type || mediaObj?.mime_type || "";
  const ext = safeExtFromMime(mimeType, "");
  const folder = path.join(MEDIA_DIR, todayFolder());
  await fsp.mkdir(folder, { recursive: true });

  const base = `${wa_id}_${mediaId}_${Date.now()}`;
  const filename = base + (ext || "");
  const localAbs = path.join(folder, filename);
  await waDownloadFile(url, localAbs);

  const rel = path.relative(MEDIA_DIR, localAbs).replace(/\\/g, "/");
  const media_path = "/media/" + rel;

  const caption = String(mediaObj?.caption || "").trim() || null;

  let thumb_path = null;
  try {
    if (sharp && kind === "image") {
      const thumbName = base + "_thumb.jpg";
      const thumbAbs = path.join(THUMBS_DIR, thumbName);
      await sharp(localAbs).resize({ width: 560 }).jpeg({ quality: 84 }).toFile(thumbAbs);
      thumb_path = "/media/__thumbs/" + thumbName;
    }
  } catch (_) {}

  return { media_path, thumb_path, caption, mimeType };
}

app.post("/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const rawBody = req.body;
  try {
    const ct = req.get("content-type") || "";
    const typ = rawBody === null ? "null" : Array.isArray(rawBody) ? "array" : Buffer.isBuffer(rawBody) ? "buffer" : typeof rawBody;
    console.log("📩 WEBHOOK HIT " + APP_VERSION, { ct, typ, len: Buffer.isBuffer(rawBody) ? rawBody.length : undefined, t: new Date().toISOString() });
  } catch (_) {}

  try {
    // IMPORTANT:
    // If app.use(express.json()) runs before this route, req.body may already be an Object.
    // So we must support Buffer | string | object safely.
    const isBuf = Buffer.isBuffer(rawBody);
    const rawText = isBuf ? rawBody.toString("utf8") : (typeof rawBody === "string" ? rawBody : null);

    // Signature verify needs the raw bytes. If body was already parsed to object, we can't verify.
    // (Most deployments do not set APP_SECRET; if you do, place the webhook route BEFORE express.json()).
    if (process.env.APP_SECRET && !isBuf) {
      console.warn("⚠️ APP_SECRET is set but webhook body is not Buffer. Move /webhook route above express.json() to verify signatures correctly.");
    }
    if (!verifyAppSecret(req, isBuf ? rawBody : Buffer.from(rawText || JSON.stringify(rawBody || {})))) {
      return res.status(403).send("bad signature");
    }

    const body = rawText ? JSON.parse(rawText) : (rawBody && typeof rawBody === "object" ? rawBody : {});
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const contacts = value?.contacts || [];
    const profileName = contacts?.[0]?.profile?.name || "";

    const messages = value?.messages || [];
    try { console.log('📨 WEBHOOK PARSED', { msgs: messages.length, hasContacts: (value?.contacts||[]).length, field: change?.field, t: new Date().toISOString() }); } catch (_) {}
    if (!messages.length) return res.json({ ok: true });

    for (const m of messages) {
      const wa_id = m.from;
      const wa_message_id = m.id;
      const type = m.type;

      await ensureCustomer(wa_id);
      if (profileName) await setCustomerNameIfEmpty(wa_id, profileName);

      let dept = null;
      let routeUnknown = false;
      let effectiveText = "";
      if (type === "text") effectiveText = m.text?.body || "";
      else if (type === "button") effectiveText = m.button?.text || "";
      else if (type === "interactive") effectiveText = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "";

      const trimmed = String(effectiveText || "").trim();

      if (trimmed === "1" || /^sales$/i.test(trimmed) || /^presales$/i.test(trimmed) || /^price$/i.test(trimmed)) dept = "presales";
      else if (trimmed === "2" || /^support$/i.test(trimmed) || /^aftersales$/i.test(trimmed)) dept = "aftersales";
      else {
        const latest = await pool.query("SELECT dept FROM tickets WHERE wa_id=$1 AND status IN ('open','pending') ORDER BY updated_at DESC LIMIT 1", [String(wa_id)]);
        if (latest.rows.length && latest.rows[0].dept) dept = latest.rows[0].dept;
        else if (effectiveText) {
          let r = keywordRoute(effectiveText);
          if (r === "unknown") r = await aiRoute(effectiveText);
          dept = r === "unknown" ? null : r;
        }
      }

      if (!dept) routeUnknown = true;
      if (!dept && (type === "text" || type === "button" || type === "interactive")) {
        await waSendText(wa_id,
          "Hi! To connect you faster, please choose:\n1️⃣ Sales (price/quote)\n2️⃣ Support (warranty/issue)\n\n为更快处理，请回复：\n1）售前（报价/下单）\n2）售后（质保/故障）"
        );
        continue;
      }
      if (!dept) dept = "presales";
      const assignee = dept === "presales" ? PRESALES_ASSIGNEE : AFTERSALES_ASSIGNEE;

      // If this message is a routing selection (1/2), try to update the latest pending 'need_route' ticket
      try {
        const isSelect = (trimmed === "1" || trimmed === "2" || /^sales$/i.test(trimmed) || /^presales$/i.test(trimmed) || /^support$/i.test(trimmed) || /^aftersales$/i.test(trimmed));
        if (isSelect) {
          const cand = await pool.query(
            "SELECT id FROM tickets WHERE wa_id=$1 AND COALESCE(status,'open')='open' AND tags IS NOT NULL AND 'need_route'=ANY(tags) ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1",
            [String(wa_id)]
          );
          if (cand.rows.length) {
            await pool.query("UPDATE tickets SET dept=$2, assignee=$3, status='open', updated_at=NOW() WHERE id=$1", [Number(cand.rows[0].id), dept, assignee]);
          }
        }
      } catch (_) {}
      const ticket_id = await createTicketOrReopen(wa_id, dept, assignee);
      console.log('🎫 TICKET', { ticket_id, wa_id, dept, assignee, routeUnknown, t: new Date().toISOString() });
      const conversation_id = await ensureTicketConversation(ticket_id, wa_id, dept).catch(()=>null);

      let msg_type = "text";
      let text = null;
      let caption = null;
      let media_path = null;
      let thumb_path = null;

      if (type === "text") { msg_type="text"; text = effectiveText; }
      else if (type === "image") { msg_type="image"; const d=await downloadInboundMedia("image", m, wa_id); caption=d.caption; media_path=d.media_path; thumb_path=d.thumb_path; text="[image]"; }
      else if (type === "video") { msg_type="video"; const d=await downloadInboundMedia("video", m, wa_id); caption=d.caption; media_path=d.media_path; thumb_path=d.thumb_path; text="[video]"; }
      else if (type === "audio") { msg_type="audio"; const d=await downloadInboundMedia("audio", m, wa_id); caption=d.caption; media_path=d.media_path; thumb_path=d.thumb_path; text="[audio]"; }
      else if (type === "document") { msg_type="document"; const d=await downloadInboundMedia("document", m, wa_id); caption=d.caption; media_path=d.media_path; thumb_path=d.thumb_path; text="[document]"; }
      else { msg_type="text"; text = effectiveText || "[unsupported message type]"; }

      const insertedId = await insertMessage({ ticket_id, wa_id, dept, direction:"incoming", msg_type, text, caption, media_path, thumb_path, wa_message_id, conversation_id });
      console.log('💾 MSG_INSERT', { insertedId, wa_message_id, msg_type, t: new Date().toISOString() });
      if (!insertedId) continue;

      await bumpTicketOnIncoming(ticket_id, caption || text || `[${msg_type}]`);

      if (routeUnknown) {
        await markTicketNeedRoute(ticket_id);
        try {
          await waSendText(wa_id,
            "Hi! To connect you faster, please choose:\n1️⃣ Sales (price/quote)\n2️⃣ Support (warranty/issue)\n\n为更快处理，请回复：\n1）售前（报价/下单）\n2）售后（质保/故障）"
          );
        } catch (_) {}
      }

      sseSend("message", { wa_id, ticket_id, dept, direction:"incoming", msg_type });
      sseSend("tickets", { changed:true });
      broadcastCustomersUpdate(wa_id);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ webhook error:", e);
    return res.status(200).json({ ok: true });
  }
});

// -------- UI login/logout --------
function renderLogin(errMsg) {
  const hint = errMsg ? "<div class='err'>" + esc(errMsg) + "</div>" : "";
  return (
    "<!doctype html><html><head><meta charset='utf-8'/>" +
    "<meta name='viewport' content='width=device-width, initial-scale=1'/>" +
    "<title>Voltgo Support Login</title>" +
    "<style>" +
    "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f3f4f6;color:#0f172a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}" +
    ".card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:28px;width:360px;box-shadow:0 10px 30px rgba(15,23,42,.08)}" +
    "h1{margin:0 0 10px 0;font-size:20px}" +
    "p{margin:0 0 16px 0;color:#475569;font-size:13px}" +
    "input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #e5e7eb;background:#fff;color:#0f172a;margin:8px 0;}" +
    "button{width:100%;padding:10px 12px;border-radius:10px;border:0;background:#2563eb;color:#fff;font-weight:800;cursor:pointer;margin-top:10px}" +
    ".err{background:#fee2e2;border:1px solid #fecaca;color:#7f1d1d;padding:10px 12px;border-radius:10px;margin:10px 0}" +
    "</style></head><body><div class='card'>" +
    "<h1>Voltgo Support System</h1>" +
    "<p>Login to continue</p>" +
    hint +
    "<form method='POST' action='/login'>" +
    "<input name='username' placeholder='Username' autocomplete='username'/>" +
    "<input name='password' type='password' placeholder='Password' autocomplete='current-password'/>" +
    "<button type='submit'>Login</button>" +
    "</form>" +
    "<p style='margin-top:14px;color:#64748b'>Version: " + APP_VERSION + " • Light UI • Customer Profile • Ticket Notes • Media • Strict Isolation " + (STRICT_AGENT_VIEW ? "ON" : "OFF") + "</p>" +
    "</div></body></html>"
  );
}

app.get("/login", (req, res) => { res.set("Cache-Control","no-store"); return res.status(200).send(renderLogin()); });
app.post("/login", (req, res) => {
  const u = String(req.body.username || "").trim();
  const p = String(req.body.password || "").trim();
  let ok = false;

  if (UI_USERS_MAP) ok = UI_USERS_MAP[u] && UI_USERS_MAP[u] === p;
  else ok = u === UI_USER_FALLBACK && p === UI_PASS_FALLBACK;

  if (!ok) return res.status(401).send(renderLogin("Invalid username or password"));
  req.session.user = u;
  req.session.save(() => res.redirect("/ui"));
});
app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));

// -------- isolation --------
function applyIsolation(req, baseWhere, params) {
  if (!STRICT_AGENT_VIEW) return { where: baseWhere, params };
  const dept = userDept(getUser(req));
  if (!dept) return { where: baseWhere, params };
  const clause = (baseWhere ? baseWhere + " AND " : "") + "t.dept = $" + (params.length + 1);
  return { where: clause, params: params.concat([dept]) };
}
async function canAccessTicket(req, ticketId) {
  if (!STRICT_AGENT_VIEW) return true;
  const dept = userDept(getUser(req));
  if (!dept) return true;
  const r = await pool.query("SELECT dept FROM tickets WHERE id=$1 LIMIT 1", [Number(ticketId)]);
  if (!r.rows.length) return false;
  return r.rows[0].dept === dept;
}
async function canAccessCustomer(req, wa_id) {
  if (!STRICT_AGENT_VIEW) return true;
  const dept = userDept(getUser(req));
  if (!dept) return true;
  const r = await pool.query("SELECT 1 FROM tickets WHERE wa_id=$1 AND dept=$2 LIMIT 1", [String(wa_id), String(dept)]);
  return r.rows.length > 0;
}

// -------- API --------
app.get("/api/tickets", requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    const dept = String(req.query.dept || "").trim();
    const unreadOnly = String(req.query.unread || "0") === "1";

    let where = "";
    let params = [];

    if (q) {
      params.push("%" + q + "%");
      where = "(t.wa_id ILIKE $" + params.length + " OR COALESCE(c.name,'') ILIKE $" + params.length + " OR COALESCE(t.last_message,'') ILIKE $" + params.length + ")";
    }
    if (status && ["open","pending","closed"].includes(status)) {
      params.push(status);
      where = (where ? where + " AND " : "") + "t.status = $" + params.length;
    }
    if (dept && ["presales","aftersales"].includes(dept)) {
      params.push(dept);
      where = (where ? where + " AND " : "") + "t.dept = $" + params.length;
    }
    if (unreadOnly) where = (where ? where + " AND " : "") + "COALESCE(t.unread_count,0) > 0";

    const iso = applyIsolation(req, where, params);
    where = iso.where; params = iso.params;

    const sql =
      "SELECT t.id, t.wa_id, COALESCE(t.dept,'presales') AS dept, COALESCE(t.status,'open') AS status, COALESCE(t.assignee,'') AS assignee," +
      " COALESCE(c.name,'') AS name, t.last_message_at, COALESCE(t.last_message,'') AS last_message, COALESCE(t.unread_count,0) AS unread_count" +
      " FROM tickets t JOIN customers c ON c.wa_id=t.wa_id" +
      (where ? " WHERE " + where : "") +
      " ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC NULLS LAST LIMIT 800";

    const r = await pool.query(sql, params);
    res.json({ ok: true, rows: r.rows, tickets: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});



app.get("/api/messages", requireAuth, async (req, res) => {
  try {
    const ticketId = Number(req.query.ticket_id || 0);
    if (!ticketId) return res.status(400).json({ ok: false, error: "ticket_id required" });
    if (!(await canAccessTicket(req, ticketId))) return res.status(403).json({ ok: false, error: "forbidden" });

    const hasTicketId = await columnExists("messages", "ticket_id").catch(()=>false);
    const hasConversationId = await columnExists("messages", "conversation_id").catch(()=>false);
    const hasTicketConv = await columnExists("tickets","conversation_id").catch(()=>false);

    let rows = [];
    let mode = "unknown";

    if (hasTicketId) {
      const r = await pool.query(
        "SELECT id::text AS id, wa_id::text AS wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id, created_at " +
        "FROM messages WHERE ticket_id=$1 ORDER BY id ASC LIMIT 2500",
        [ticketId]
      );
      rows = r.rows;
      mode = "ticket_id";
    }

    if (hasConversationId) {
      const t = await pool.query(
        "SELECT wa_id::text AS wa_id, " + (hasTicketConv ? "conversation_id::text AS conversation_id " : "NULL::text AS conversation_id ") +
        "FROM tickets WHERE id=$1 LIMIT 1",
        [ticketId]
      );
      if (t.rows.length) {
        const wa_id = String(t.rows[0].wa_id || "");
        const cid = t.rows[0].conversation_id ? String(t.rows[0].conversation_id) : wa_id;

        const r2 = await pool.query(
          "SELECT id::text AS id, wa_id::text AS wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id, created_at " +
          "FROM messages WHERE conversation_id=$1 ORDER BY id ASC LIMIT 2500",
          [cid]
        );

        if (r2.rows.length) {
          const seen = new Set(rows.map(x => String(x.wa_message_id || x.id)));
          for (const item of r2.rows) {
            const key = String(item.wa_message_id || item.id);
            if (!seen.has(key)) {
              rows.push(item);
              seen.add(key);
            }
          }
          rows.sort((a, b) => { const av = Date.parse(a && a.created_at ? a.created_at : "") || 0; const bv = Date.parse(b && b.created_at ? b.created_at : "") || 0; if (av !== bv) return av - bv; return (Number(a && a.id ? a.id : 0) - Number(b && b.id ? b.id : 0)); });
          mode = mode === "ticket_id" ? "ticket_id+conversation_id" : "conversation_id";
        }
      }
    }

    await pool.query("UPDATE tickets SET unread_count=0, updated_at=NOW() WHERE id=$1", [ticketId]).catch(()=>{});
    sseSend("tickets", { changed: true });

    return res.json({ ok: true, mode, rows, messages: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});







app.post("/api/tickets/mark-read", requireAuth, async (req, res) => {
  try {
    const ticketId = Number(req.body.ticket_id || 0);
    if (!ticketId) return res.status(400).json({ ok: false, error: "ticket_id required" });
    if (!(await canAccessTicket(req, ticketId))) return res.status(403).json({ ok: false, error: "forbidden" });
    await pool.query("UPDATE tickets SET unread_count=0, updated_at=NOW() WHERE id=$1", [ticketId]);
    sseSend("tickets", { changed: true });
    broadcastCustomersUpdate(wa_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/send", requireAuth, async (req, res) => {
  try {
    const ticketId = Number(req.body.ticket_id || 0);
    const wa_id = String(req.body.wa_id || "").trim();
    const text = String(req.body.text || "").trim();
    if (!ticketId || !wa_id || !text) return res.status(400).json({ ok: false, error: "ticket_id, wa_id, text required" });
    if (!(await canAccessTicket(req, ticketId))) return res.status(403).json({ ok: false, error: "forbidden" });

    const waResp = await waSendText(wa_id, text);
    const outId = waResp?.messages?.[0]?.id || null;

        const conversation_id = await ensureTicketConversation(ticketId, wa_id, (await pool.query('SELECT dept FROM tickets WHERE id=$1',[ticketId])).rows[0]?.dept || '').catch(()=>null);
    await insertMessage({ ticket_id: ticketId, wa_id, dept: (await pool.query('SELECT dept FROM tickets WHERE id=$1',[ticketId])).rows[0]?.dept || '', direction:'outgoing', msg_type:'text', text: text.slice(0, 4000), wa_message_id: outId, conversation_id });
    await bumpTicketOnOutgoing(ticketId, text);

    sseSend("message", { wa_id, ticket_id: ticketId, direction: "outgoing", msg_type: "text" });
    sseSend("tickets", { changed: true });
    broadcastCustomersUpdate(wa_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/send-media", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const ticketId = Number(req.body.ticket_id || 0);
    const wa_id = String(req.body.wa_id || "").trim();
    const caption = String(req.body.caption || "").trim();
    const f = req.file;

    if (!ticketId || !wa_id || !f) return res.status(400).json({ ok: false, error: "ticket_id, wa_id, file required" });
    if (!(await canAccessTicket(req, ticketId))) return res.status(403).json({ ok: false, error: "forbidden" });

    const folder = path.join(MEDIA_DIR, todayFolder());
    await fsp.mkdir(folder, { recursive: true });
    const ext = safeExtFromMime(f.mimetype, path.extname(f.originalname || ""));
    const base = `out_${wa_id}_${Date.now()}`;
    const destAbs = path.join(folder, base + (ext || ""));
    await fsp.rename(f.path, destAbs).catch(async () => { await fsp.copyFile(f.path, destAbs); await fsp.unlink(f.path).catch(()=>{}); });

    const rel = path.relative(MEDIA_DIR, destAbs).replace(/\\/g, "/");
    const media_path = "/media/" + rel;

    const mediaId = await waUploadMedia(destAbs, f.mimetype);
    const { msgType, sendResp } = await waSendMediaMessage(wa_id, mediaId, f.mimetype, caption);
    const outId = sendResp?.messages?.[0]?.id || null;

    let thumb_path = null;
    try {
      if (sharp && msgType === "image") {
        const thumbName = base + "_thumb.jpg";
        const thumbAbs = path.join(THUMBS_DIR, thumbName);
        await sharp(destAbs).resize({ width: 560 }).jpeg({ quality: 84 }).toFile(thumbAbs);
        thumb_path = "/media/__thumbs/" + thumbName;
      }
    } catch (_) {}

    const conversation_id = await ensureTicketConversation(ticketId, wa_id, (await pool.query('SELECT dept FROM tickets WHERE id=$1',[ticketId])).rows[0]?.dept || '').catch(()=>null);
    await insertMessage({ ticket_id: ticketId, wa_id, dept: (await pool.query('SELECT dept FROM tickets WHERE id=$1',[ticketId])).rows[0]?.dept || '', direction:'outgoing', msg_type: msgType, caption: caption || null, media_path, thumb_path, wa_message_id: outId, conversation_id });
    await bumpTicketOnOutgoing(ticketId, caption || `[${msgType}]`);

    sseSend("message", { wa_id, ticket_id: ticketId, direction: "outgoing", msg_type: msgType });
    sseSend("tickets", { changed: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Customer Profile
app.get("/api/customer", requireAuth, async (req, res) => {
  try {
    const wa_id = String(req.query.wa_id || "").trim();
    if (!wa_id) return res.status(400).json({ ok: false, error: "wa_id required" });
    if (!(await canAccessCustomer(req, wa_id))) return res.status(403).json({ ok: false, error: "forbidden" });
    const r = await pool.query("SELECT wa_id, COALESCE(name,'') AS name, COALESCE(notes,'') AS notes, created_at, updated_at FROM customers WHERE wa_id=$1 LIMIT 1", [wa_id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, row: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
app.post("/api/customer/update", requireAuth, async (req, res) => {
  try {
    const wa_id = String(req.body.wa_id || "").trim();
    const name = String(req.body.name ?? "").trim().slice(0, 120);
    const notes = String(req.body.notes ?? "").trim().slice(0, 8000);
    if (!wa_id) return res.status(400).json({ ok: false, error: "wa_id required" });
    if (!(await canAccessCustomer(req, wa_id))) return res.status(403).json({ ok: false, error: "forbidden" });
    await pool.query("UPDATE customers SET name=$2, notes=$3, updated_at=NOW() WHERE wa_id=$1", [wa_id, name || null, notes || null]);
    broadcastCustomersUpdate(wa_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Ticket Notes
app.get("/api/ticket-notes", requireAuth, async (req, res) => {
  try {
    const ticketId = Number(req.query.ticket_id || 0);
    if (!ticketId) return res.status(400).json({ ok: false, error: "ticket_id required" });
    if (!(await canAccessTicket(req, ticketId))) return res.status(403).json({ ok: false, error: "forbidden" });
    const r = await pool.query("SELECT id, ticket_id, COALESCE(author,'') AS author, note, created_at FROM ticket_notes WHERE ticket_id=$1 ORDER BY id ASC LIMIT 500", [ticketId]);
    res.json({ ok: true, rows: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
app.post("/api/ticket-notes/add", requireAuth, async (req, res) => {
  try {
    const ticketId = Number(req.body.ticket_id || 0);
    const note = String(req.body.note || "").trim();
    if (!ticketId || !note) return res.status(400).json({ ok: false, error: "ticket_id and note required" });
    if (!(await canAccessTicket(req, ticketId))) return res.status(403).json({ ok: false, error: "forbidden" });
    const author = getUser(req) || "";
    await pool.query("INSERT INTO ticket_notes(ticket_id, author, note) VALUES($1,$2,$3)", [ticketId, author, note.slice(0, 8000)]);
    sseSend("ticket_notes", { ticket_id: ticketId, changed: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


app.get("/api/customers", requireAuth, async (req, res) => {
  try {
    let where = "";
    let params = [];
    if (STRICT_AGENT_VIEW) {
      const dept = userDept(getUser(req));
      if (dept) {
        where = "WHERE t.dept=$1";
        params = [dept];
      }
    }
    const r = await pool.query(
      "SELECT c.wa_id, COALESCE(c.name,'') AS name, COALESCE(c.notes,'') AS notes, " +
      "MAX(t.updated_at) AS last_ticket_at, COUNT(t.id)::int AS ticket_count, " +
      "COALESCE(SUM(COALESCE(t.unread_count,0)),0)::int AS unread_count " +
      "FROM customers c LEFT JOIN tickets t ON t.wa_id=c.wa_id " +
      where + " GROUP BY c.wa_id, c.name, c.notes ORDER BY MAX(t.updated_at) DESC NULLS LAST, c.wa_id ASC LIMIT 1000",
      params
    );
    res.json({ ok:true, rows:r.rows, customers:r.rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

app.get("/api/customer-tickets", requireAuth, async (req, res) => {
  try {
    const wa_id = String(req.query.wa_id || "").trim();
    if (!wa_id) return res.status(400).json({ ok:false, error:"wa_id required" });

    let where = "WHERE t.wa_id=$1";
    let params = [wa_id];
    if (STRICT_AGENT_VIEW) {
      const dept = userDept(getUser(req));
      if (dept) {
        where += " AND t.dept=$2";
        params.push(dept);
      }
    }

    const r = await pool.query(
      "SELECT t.id, t.wa_id, COALESCE(t.dept,'presales') AS dept, COALESCE(t.status,'open') AS status, COALESCE(t.last_message,'') AS last_message, COALESCE(t.unread_count,0) AS unread_count, t.updated_at " +
      "SELECT t.id, t.wa_id, COALESCE(t.dept,'presales') AS dept, COALESCE(t.status,'open') AS status, COALESCE(t.last_message,'') AS last_message, t.updated_at, COALESCE(t.unread_count,0) AS unread_count " +
      "FROM tickets t " + where + " ORDER BY t.updated_at DESC NULLS LAST, t.id DESC LIMIT 200",
      params
    );
    res.json({ ok:true, rows:r.rows, tickets:r.rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});


// -------- UI Dashboard --------

app.get("/ui.js", requireAuth, (req, res) => {
  res.set("Cache-Control","no-store");
  res.type("application/javascript; charset=utf-8");
  res.send(String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const listEl = $("ticketList");
  const chatEl = $("chat");
  const chatTitle = $("chatTitle");
  const chatMeta = $("chatMeta");
  const msgCount = $("msgCount");
  const btnRefresh = $("refresh");
  const btnReloadChat = $("reloadChat");
  const inText = $("text");
  const btnSend = $("send");
  const fileInput = $("fileInput");
  const fileCaption = $("fileCaption");
  const btnSendFile = $("sendFile");
  const selectedFileName = $("selectedFileName");
  const custName = $("custName");
  const custPhone = $("custPhone");
  const custNotes = $("custNotes");
  const btnSaveCustomer = $("saveCustomer");
  const notesList = $("ticketNotes");
  const newNote = $("newNote");
  const btnAddNote = $("addNote");

  let tickets = [];
  let active = null;

  function setStatus(text, ok=true){
    if(!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("ok", !!ok);
  }

  function fmtTime(v){
    if(!v) return "";
    const d = new Date(v);
    if (isNaN(d)) return String(v);
    const mm = String(d.getMonth()+1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return mm + "-" + dd + " " + hh + ":" + mi;
  }

  async function api(url, opts){
    const r = await fetch(url, Object.assign({ credentials:"same-origin" }, opts||{}));
    const j = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error((j && (j.error||j.message)) || ("HTTP " + r.status));
    return j;
  }

  function renderTickets(){
    if(!listEl) return;
    listEl.innerHTML = "";
    if(!tickets.length){
      const d=document.createElement("div");
      d.className="muted";
      d.textContent="No tickets.";
      listEl.appendChild(d);
      return;
    }
    tickets.forEach(t=>{
      const row=document.createElement("div");
      row.className="row" + (active && String(active.id)===String(t.id) ? " active" : "");
      row.dataset.id=String(t.id);
      const top=document.createElement("div");
      top.style.display="flex";
      top.style.justifyContent="space-between";
      top.style.gap="8px";
      const title = (t.name && String(t.name).trim()) ? t.name : (t.wa_id || "");
      const unreadHtml = Number(t.unread_count || 0) > 0 ? " <span style='display:inline-block;min-width:18px;padding:0 6px;border-radius:999px;background:#dc2626;color:#fff;font-size:12px;line-height:18px;text-align:center'>" + Number(t.unread_count || 0) + "</span>" : "";
      top.innerHTML = "<div><b>#"+t.id+"</b> " + title + unreadHtml + "</div><div class='muted'>"+(t.status||"")+"</div>";
      const sub=document.createElement("div");
      sub.className="muted";
      sub.textContent = (t.last_message || "").toString().slice(0,90);
      row.appendChild(top);
      row.appendChild(sub);
      row.onclick=()=>selectTicket(t);
      listEl.appendChild(row);
    });
  }

  function appendTextBlock(parent, text){
    if(!text) return;
    const txt=document.createElement("div");
    txt.style.whiteSpace="pre-wrap";
    txt.textContent=text;
    parent.appendChild(txt);
  }

  function appendMediaBlock(parent, m){
    const type = String(m.msg_type || "");
    const mediaPath = m.media_path || "";
    const thumbPath = m.thumb_path || mediaPath || "";
    if(type === "image" && mediaPath){
      const a = document.createElement("a");
      a.href = mediaPath;
      a.target = "_blank";
      const img = document.createElement("img");
      img.src = thumbPath;
      img.alt = m.caption || "image";
      img.style.maxWidth = "240px";
      img.style.borderRadius = "8px";
      img.style.display = "block";
      a.appendChild(img);
      parent.appendChild(a);
      appendTextBlock(parent, m.caption || "");
      return;
    }
    if(type === "video" && mediaPath){
      const v = document.createElement("video");
      v.src = mediaPath;
      v.controls = true;
      v.style.maxWidth = "260px";
      v.style.borderRadius = "8px";
      v.style.display = "block";
      parent.appendChild(v);
      appendTextBlock(parent, m.caption || "");
      return;
    }
    if(type === "audio" && mediaPath){
      const a = document.createElement("audio");
      a.src = mediaPath;
      a.controls = true;
      a.style.display = "block";
      parent.appendChild(a);
      appendTextBlock(parent, m.caption || "");
      return;
    }
    if(type === "document" && mediaPath){
      const link = document.createElement("a");
      link.href = mediaPath;
      link.target = "_blank";
      link.textContent = "📄 Open file";
      link.style.color = (m.direction === "outgoing") ? "#fff" : "#2563eb";
      parent.appendChild(link);
      appendTextBlock(parent, m.caption || m.text || "");
      return;
    }
    appendTextBlock(parent, (m.text && String(m.text).trim()) ? m.text : (m.caption || ("[" + type + "]")));
  }

  function renderMessages(rows){
    if(!chatEl) return;
    const ordered = (rows || []).slice().sort((a,b)=>{
      const at = Date.parse(a && a.created_at ? a.created_at : "") || 0;
      const bt = Date.parse(b && b.created_at ? b.created_at : "") || 0;
      if (at !== bt) return at - bt;
      return (Number(a && a.id ? a.id : 0) - Number(b && b.id ? b.id : 0));
    });

    chatEl.innerHTML="";
    ordered.forEach(m=>{
      const wrap=document.createElement("div");
      wrap.className="msg " + (m.direction==="outgoing" ? "outgoing" : "incoming");
      const bubble=document.createElement("div");
      bubble.className="bubble";
      appendMediaBlock(bubble, m);
      const meta=document.createElement("div");
      meta.className="muted";
      meta.textContent = fmtTime(m.created_at || "");
      wrap.appendChild(bubble);
      wrap.appendChild(meta);
      chatEl.appendChild(wrap);
    });
    if(msgCount) msgCount.textContent = String(ordered.length);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function renderTicketNotes(rows){
    if(!notesList) return;
    notesList.innerHTML = "";
    const items = rows || [];
    if(!items.length){
      const d=document.createElement("div");
      d.className="muted";
      d.textContent="No notes yet.";
      notesList.appendChild(d);
      return;
    }
    items.forEach(n=>{
      const el=document.createElement("div");
      el.className="noteItem";
      const head=document.createElement("div");
      head.className="muted";
      head.textContent = (n.author || "system") + " · " + fmtTime(n.created_at);
      const body=document.createElement("div");
      body.textContent = n.note || "";
      el.appendChild(head);
      el.appendChild(body);
      notesList.appendChild(el);
    });
  }

  async function loadTickets(){
    try{
      const j = await api("/api/tickets");
      tickets = j.tickets || j.rows || [];
      setStatus("JS: OK · tickets " + tickets.length, true);
      renderTickets();
      if(!active && tickets.length) selectTicket(tickets[0]);
      if(active){
        const fresh = tickets.find(x => String(x.id) === String(active.id));
        if(fresh){
          active = fresh;
          renderTickets();
        }
      }
    }catch(e){
      setStatus("JS: /api/tickets failed", false);
      console.error("loadTickets", e);
    }
  }

  async function loadMessages(){
    if(!active) return;
    try{
      const j = await api("/api/messages?ticket_id=" + encodeURIComponent(active.id));
      const rows = j.messages || j.rows || [];
      renderMessages(rows);
      if(btnSend) btnSend.disabled = false;
      if(btnSendFile) btnSendFile.disabled = false;
    }catch(e){
      console.error("loadMessages", e);
    }
  }

  async function loadCustomer(){
    if(!active) return;
    try{
      const j = await api("/api/customer?wa_id=" + encodeURIComponent(active.wa_id));
      const row = j.row || {};
      if(custName) custName.value = row.name || "";
      if(custPhone) custPhone.value = row.wa_id || active.wa_id || "";
      if(custNotes) custNotes.value = row.notes || "";
    }catch(e){
      console.error("loadCustomer", e);
    }
  }

  async function loadNotes(){
    if(!active) return;
    try{
      const j = await api("/api/ticket-notes?ticket_id=" + encodeURIComponent(active.id));
      renderTicketNotes(j.rows || []);
    }catch(e){
      console.error("loadNotes", e);
    }
  }

  async function selectTicket(t){
    active = t;
    try{
      await api("/api/tickets/mark-read", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ ticket_id: t.id })
      });
      t.unread_count = 0;
    }catch(e){
      console.error("markRead", e);
    }
    renderTickets();
    if(chatTitle) chatTitle.textContent = "Ticket #" + t.id;
    if(chatMeta) chatMeta.textContent = (t.dept||"") + " · " + (t.wa_id||"");
    await loadMessages();
    await loadCustomer();
    await loadNotes();
  }

  async function sendText(){
    if(!active) return;
    const text = (inText.value || "").trim();
    if(!text) return;
    btnSend.disabled = true;
    try{
      await api("/api/send", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ ticket_id: active.id, wa_id: active.wa_id, text })
      });
      inText.value = "";
      await loadMessages();
      await loadTickets();
    }catch(e){
      console.error("send", e);
      alert("Send failed: " + e.message);
    }finally{
      btnSend.disabled = false;
    }
  }

  async function sendMedia(){
    if(!active) return;
    const file = fileInput && fileInput.files ? fileInput.files[0] : null;
    if(!file) return;
    btnSendFile.disabled = true;
    try{
      const fd = new FormData();
      fd.append("ticket_id", String(active.id));
      fd.append("wa_id", String(active.wa_id));
      fd.append("file", file);
      fd.append("caption", fileCaption ? (fileCaption.value || "") : "");
      const r = await fetch("/api/send-media", { method:"POST", body: fd, credentials:"same-origin" });
      const j = await r.json().catch(()=>({}));
      if(!r.ok) throw new Error((j && (j.error||j.message)) || ("HTTP " + r.status));
      if(fileInput) fileInput.value = "";
      if(fileCaption) fileCaption.value = "";
      if(selectedFileName) selectedFileName.textContent = "No file selected";
      await loadMessages();
      await loadTickets();
    }catch(e){
      console.error("sendMedia", e);
      alert("Send media failed: " + e.message);
    }finally{
      btnSendFile.disabled = false;
    }
  }

  async function saveCustomer(){
    if(!active) return;
    try{
      await api("/api/customer/update", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          wa_id: active.wa_id,
          name: custName ? custName.value : "",
          notes: custNotes ? custNotes.value : ""
        })
      });
      await loadTickets();
      alert("Customer saved");
    }catch(e){
      console.error("saveCustomer", e);
      alert("Save failed: " + e.message);
    }
  }

  async function addTicketNote(){
    if(!active) return;
    const note = (newNote.value || "").trim();
    if(!note) return;
    try{
      await api("/api/ticket-notes/add", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ ticket_id: active.id, note })
      });
      newNote.value = "";
      await loadNotes();
    }catch(e){
      console.error("addNote", e);
      alert("Add note failed: " + e.message);
    }
  }

  if(btnRefresh) btnRefresh.onclick = ()=>{ loadTickets(); };
  if(btnReloadChat) btnReloadChat.onclick = ()=>{ if(active) loadMessages(); };
  if(btnSend) btnSend.onclick = ()=>sendText();
  if(btnSendFile) btnSendFile.onclick = ()=>sendMedia();
  if(btnSaveCustomer) btnSaveCustomer.onclick = ()=>saveCustomer();
  if(btnAddNote) btnAddNote.onclick = ()=>addTicketNote();

  if(inText){
    inText.addEventListener("keydown", (ev)=>{
      if(ev.key === "Enter" && !ev.shiftKey){
        ev.preventDefault();
        sendText();
      }
    });
  }
  if(fileInput){
    fileInput.addEventListener("change", ()=>{
      const file = fileInput.files && fileInput.files[0];
      if(selectedFileName) selectedFileName.textContent = file ? file.name : "No file selected";
    });
  }

  loadTickets();
  setInterval(()=>{ loadTickets(); }, 2000);
})();
`);
});

app.get("/ui", requireAuth, (req, res) => { res.set("Cache-Control","no-store"); res.type("text/html; charset=utf-8");
  const user = getUser(req);
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Voltgo Support System</title>
  <meta http-equiv="Cache-Control" content="no-store"/>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f7fb;color:#111}
    .top{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#fff;border-bottom:1px solid #e5e7eb;position:sticky;top:0;z-index:5}
    .brand{font-weight:700}
    .pill{font-size:12px;padding:3px 8px;border:1px solid #e5e7eb;border-radius:999px;background:#fff;color:#444}
    .wrap{display:grid;grid-template-columns:320px minmax(420px,1fr) 320px;gap:10px;padding:10px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    .left{padding:10px}
    .list{display:flex;flex-direction:column;gap:6px;max-height:calc(100vh - 120px);overflow:auto}
    .row{padding:10px;border:1px solid #eee;border-radius:10px;cursor:pointer}
    .row.active{border-color:#2563eb;background:#eff6ff}
    .muted{color:#666;font-size:12px}
    .main{display:flex;flex-direction:column;min-width:0}
    .chat{padding:10px;max-height:calc(100vh - 190px);overflow:auto}
    .msg{display:flex;flex-direction:column;gap:2px;margin:8px 0}
    .bubble{display:inline-block;padding:8px 10px;border-radius:10px;border:1px solid #eee;max-width:65%;word-break:break-word}
    .incoming{align-items:flex-start}
    .incoming .bubble{background:#f3f4f6;width:fit-content;max-width:65%}
    .outgoing{align-items:flex-end}
    .outgoing .bubble{background:#2563eb;color:#fff;border-color:#2563eb;width:fit-content;max-width:65%}
    .composer{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb}
    input,textarea{font:inherit}
    .in{flex:1;padding:10px;border:1px solid #e5e7eb;border-radius:10px}
    .btn{padding:10px 12px;border:1px solid #111;background:#111;color:#fff;border-radius:10px;cursor:pointer}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .ok{background:#eef7ee;border-color:#b7dfb7;color:#2b6b2b}
    .side{padding:10px;display:flex;flex-direction:column;gap:10px}
    .field label{display:block;font-size:12px;color:#666;margin-bottom:4px}
    .field input,.field textarea{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e5e7eb;border-radius:10px;background:#fff}
    .field textarea{min-height:78px;resize:vertical}
    .notesList{display:flex;flex-direction:column;gap:8px;max-height:240px;overflow:auto}
    .noteItem{border:1px solid #eee;border-radius:10px;padding:8px 10px}
  </style>
</head>
<body>
  <div class="top">
    <div style="display:flex;gap:12px;align-items:center">
      <div class="brand">Voltgo Support System</div>
      <a class="pill" href="/ui" style="text-decoration:none">Tickets</a>
      <a class="pill" href="/customers" style="text-decoration:none">Customers</a>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <span id="status" class="pill">JS: booting…</span>
      <a class="pill" href="/logout">Logout</a>
    </div>
  </div>

  <div class="wrap">
    <div class="card left">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:600">Tickets</div>
        <button id="refresh" class="pill" style="cursor:pointer">Refresh</button>
      </div>
      <div id="ticketList" class="list"></div>
      <div class="muted" style="margin-top:8px">Tickets auto refresh every 2s · chat manual</div>
    </div>

    <div class="card main">
      <div style="padding:10px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-weight:600" id="chatTitle">Conversation</div>
          <div class="muted" id="chatMeta">Select a ticket</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button id="reloadChat" class="pill" style="cursor:pointer">Reload chat</button>
          <div class="pill" id="msgCount">0</div>
        </div>
      </div>
      <div id="chat" class="chat"></div>
      <div class="composer">
        <input id="text" class="in" placeholder="Type a reply…"/>
        <button id="send" class="btn" disabled>Send</button>
      </div>
      <div class="composer" style="border-top:0;padding-top:0;flex-wrap:wrap">
        <input id="fileInput" type="file" class="pill" style="max-width:240px;padding:8px"/>
        <input id="fileCaption" class="in" placeholder="Caption (optional)…" style="min-width:220px"/>
        <button id="sendFile" class="btn" disabled>Send file</button>
        <div id="selectedFileName" class="muted" style="width:100%">No file selected</div>
      </div>
    </div>

    <div class="card side">
      <div>
        <div style="font-weight:600;margin-bottom:8px">Customer Profile</div>
        <div class="field"><label>Name</label><input id="custName" placeholder="Customer name"/></div>
        <div class="field"><label>Phone</label><input id="custPhone" disabled/></div>
        <div class="field"><label>Notes</label><textarea id="custNotes" placeholder="Customer notes"></textarea></div>
        <button id="saveCustomer" class="pill" style="cursor:pointer">Save customer</button>
      </div>

      <div>
        <div style="font-weight:600;margin-bottom:8px">Ticket Notes</div>
        <div id="ticketNotes" class="notesList"></div>
        <div class="field" style="margin-top:8px"><label>Add Note</label><textarea id="newNote" placeholder="Internal note"></textarea></div>
        <button id="addNote" class="pill" style="cursor:pointer">Add note</button>
      </div>
    </div>
  </div>

<<<<<<< HEAD
  <script src="/ui.js?v=${APP_VERSION}"></script>
=======
  <script src="/ui.js?v=" + APP_VERSION + ""></script>
>>>>>>> c905d64 (upgrade to V4.8.8 search + media UI)
</body>
</html>`);
});


app.get("/customers", requireAuth, (req, res) => { res.set("Cache-Control","no-store"); res.type("text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Voltgo Customers</title>
  <meta http-equiv="Cache-Control" content="no-store"/>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f7fb;color:#111}
    .top{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#fff;border-bottom:1px solid #e5e7eb;position:sticky;top:0;z-index:5}
    .brand{font-weight:700}
    .pill{font-size:12px;padding:3px 8px;border:1px solid #e5e7eb;border-radius:999px;background:#fff;color:#444}
    .wrap{display:grid;grid-template-columns:320px 360px 1fr;gap:10px;padding:10px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    .side{padding:10px}
    .list{display:flex;flex-direction:column;gap:6px;max-height:calc(100vh - 120px);overflow:auto}
    .row{padding:10px;border:1px solid #eee;border-radius:10px;cursor:pointer}
    .row.active{border-color:#2563eb;background:#eff6ff}
    .muted{color:#666;font-size:12px}
    .field label{display:block;font-size:12px;color:#666;margin-bottom:4px}
    .field input,.field textarea{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e5e7eb;border-radius:10px;background:#fff}
    .field textarea{min-height:100px;resize:vertical}
    .note{padding:10px}
    .badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 6px;border-radius:999px;background:#ef4444;color:#fff;font-size:11px;font-weight:700;line-height:1}
    .rowHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
  </style>
</head>
<body>
  <div class="top">
    <div style="display:flex;gap:12px;align-items:center">
      <div class="brand">Voltgo Support System</div>
      <a class="pill" href="/ui" style="text-decoration:none">Tickets</a>
      <a class="pill" href="/customers" style="text-decoration:none">Customers</a>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <span id="status" class="pill">JS: booting…</span>
      <a class="pill" href="/logout">Logout</a>
    </div>
  </div>

  <div class="wrap">
    <div class="card side">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:600">Customers</div>
        <button id="refreshCustomers" class="pill" style="cursor:pointer">Refresh</button>
      </div>
      <div class="field" style="margin-bottom:8px;display:flex;gap:6px">
        <input id="customerSearch" placeholder="Search customer..." style="flex:1"/>
        <button id="customerSearchBtn" class="pill" style="cursor:pointer">Search</button>
        <button id="customerClearBtn" class="pill" style="cursor:pointer">Clear</button>
      </div>
      <div id="customerList" class="list"></div>
    </div>

    <div class="card side">
      <div style="font-weight:600;margin-bottom:8px">Customer Profile</div>
      <div class="field"><label>Name</label><input id="custName" placeholder="Customer name"/></div>
      <div class="field"><label>Phone</label><input id="custPhone" disabled/></div>
      <div class="field"><label>Notes</label><textarea id="custNotes" placeholder="Customer notes"></textarea></div>
      <button id="saveCustomer" class="pill" style="cursor:pointer;margin-top:8px">Save customer</button>
    </div>

    <div class="card side">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:600">Customer Tickets</div>
        <span id="ticketCount" class="pill">0</span>
      </div>
      <div id="custTickets" class="list"></div>
      <div class="muted" style="margin-top:8px">Click a ticket to open the conversation page</div>
    </div>
  </div>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const customerList = $("customerList");
  const custTickets = $("custTickets");
  const ticketCount = $("ticketCount");
  const custName = $("custName");
  const custPhone = $("custPhone");
  const custNotes = $("custNotes");
  const btnSaveCustomer = $("saveCustomer");
  const btnRefreshCustomers = $("refreshCustomers");
  const btnSearch = $("customerSearchBtn");
  const btnClear = $("customerClearBtn");
  const searchInput = $("customerSearch");
  let customers = [];
  let active = null;
  let es = null;
  let sseRetry = null;

  function setStatus(text, ok=true){
    statusEl.textContent = text;
    statusEl.style.background = ok ? "#eef7ee" : "#fdecec";
    statusEl.style.borderColor = ok ? "#b7dfb7" : "#f0b3b3";
    statusEl.style.color = ok ? "#2b6b2b" : "#8a1f1f";
  }
  async function api(url, opts){
    const r = await fetch(url, Object.assign({ credentials:"same-origin" }, opts||{}));
    const j = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error((j && (j.error||j.message)) || ("HTTP " + r.status));
    return j;
  }
  function currentKeyword(){
    return String((searchInput && searchInput.value) || "").trim().toLowerCase();
  }
  function filteredCustomers(){
    const kw = currentKeyword();
    if(!kw) return customers.slice();
    return customers.filter(c =>
      String(c.wa_id || "").toLowerCase().includes(kw) ||
      String(c.name || "").toLowerCase().includes(kw) ||
      String(c.notes || "").toLowerCase().includes(kw)
    );
  }
  function badge(n){
    const num = Number(n || 0);
    if(num <= 0) return "";
    return "<span style='display:inline-block;min-width:18px;padding:0 6px;border-radius:999px;background:#ef4444;color:#fff;font-size:12px;line-height:18px;text-align:center'>" + num + "</span>";
  }
  function renderCustomers(){
    const rows = filteredCustomers();
    customerList.innerHTML = "";
    if(!rows.length){
      const d = document.createElement("div");
      d.className = "muted";
      d.textContent = "No customers.";
      customerList.appendChild(d);
      return;
    }
    rows.forEach(c => {
      const row = document.createElement("div");
      row.className = "row" + (active && active.wa_id === c.wa_id ? " active" : "");
<<<<<<< HEAD
      const unread = Number(c.unread_count || 0);
      row.innerHTML = "<div class='rowHead'><div><b>" + (c.name || c.wa_id) + "</b></div>" +
                      (unread > 0 ? "<span class='badge'>" + unread + "</span>" : "") + "</div>" +
=======
      row.innerHTML = "<div style='display:flex;justify-content:space-between;gap:8px;align-items:center'><div><b>" + (c.name || c.wa_id) + "</b></div>" + badge(c.unread_count) + "</div>" +
>>>>>>> c905d64 (upgrade to V4.8.8 search + media UI)
                      "<div class='muted'>" + c.wa_id + "</div>" +
                      "<div class='muted'>" + (c.ticket_count || 0) + " tickets</div>";
      row.onclick = () => selectCustomer(c);
      customerList.appendChild(row);
    });
  }
  async function loadCustomers(){
    try{
      const j = await api("/api/customers");
      customers = j.customers || j.rows || [];
      setStatus("JS: OK · customers " + customers.length, true);
      const prevWa = active ? active.wa_id : null;
      renderCustomers();
      if(prevWa){
        const found = customers.find(x => x.wa_id === prevWa);
        if(found) active = found;
      }
      if(!active && customers.length) selectCustomer(customers[0]);
      else if(active){ renderCustomers(); }
    }catch(e){
      console.error("loadCustomers", e);
      setStatus("JS: /api/customers failed", false);
    }
  }
  async function loadCustomerProfile(){
    if(!active) return;
    const j = await api("/api/customer?wa_id=" + encodeURIComponent(active.wa_id));
    const row = j.row || {};
    custName.value = row.name || "";
    custPhone.value = row.wa_id || active.wa_id || "";
    custNotes.value = row.notes || "";
  }
  async function loadCustomerTickets(){
    if(!active) return;
    const j = await api("/api/customer-tickets?wa_id=" + encodeURIComponent(active.wa_id));
    const rows = j.tickets || j.rows || [];
    ticketCount.textContent = String(rows.length);
    custTickets.innerHTML = "";
    if(!rows.length){
      const d = document.createElement("div");
      d.className = "muted";
      d.textContent = "No tickets.";
      custTickets.appendChild(d);
      return;
    }
    rows.forEach(t => {
      const row = document.createElement("div");
      row.className = "row";
<<<<<<< HEAD
      const unread = Number(t.unread_count || 0);
      row.innerHTML = "<div class='rowHead'><div><b>#"+t.id+"</b> " + (t.dept || "") + " · " + (t.status || "") + "</div>" +
                      (unread > 0 ? "<span class='badge'>" + unread + "</span>" : "") + "</div>" +
=======
      row.innerHTML = "<div style='display:flex;justify-content:space-between;gap:8px;align-items:center'><div><b>#"+t.id+"</b> " + (t.dept || "") + " · " + (t.status || "") + "</div>" + badge(t.unread_count) + "</div>" +
>>>>>>> c905d64 (upgrade to V4.8.8 search + media UI)
                      "<div class='muted'>" + (t.last_message || "").slice(0,90) + "</div>";
      row.onclick = () => { window.location.href = "/ui?ticket_id=" + encodeURIComponent(t.id); };
      custTickets.appendChild(row);
    });
  }
  async function selectCustomer(c){
    active = c;
    renderCustomers();
    await loadCustomerProfile();
    await loadCustomerTickets();
  }
  async function saveCustomer(){
    if(!active) return;
    try{
      await api("/api/customer/update", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ wa_id: active.wa_id, name: custName.value || "", notes: custNotes.value || "" })
      });
      await loadCustomers();
      alert("Customer saved");
    }catch(e){
      console.error("saveCustomer", e);
      alert("Save failed: " + e.message);
    }
  }
  function connectSSE(){
    try { if(es) es.close(); } catch(_) {}
    es = new EventSource("/sse");
    es.addEventListener("hello", () => setStatus("JS: OK · customers " + customers.length, true));
    es.addEventListener("customers", async () => {
      await loadCustomers();
      if(active) await loadCustomerTickets();
    });
    es.addEventListener("tickets", async () => {
      await loadCustomers();
      if(active) await loadCustomerTickets();
    });
    es.onerror = () => {
      setStatus("JS: SSE reconnecting…", false);
      try { es.close(); } catch(_) {}
      clearTimeout(sseRetry);
      sseRetry = setTimeout(connectSSE, 2000);
    };
  }

  btnRefreshCustomers.onclick = loadCustomers;
  btnSaveCustomer.onclick = saveCustomer;
<<<<<<< HEAD

  let es = null;
  let sseRetry = null;

  function connectSSE(){
    try{ if(es) es.close(); }catch(_){}
    es = new EventSource("/sse");

    es.addEventListener("hello", () => {
      setStatus("JS: OK · customers " + customers.length, true);
    });

    es.addEventListener("customers", async () => {
      try{
        const prevWa = active ? active.wa_id : null;
        await loadCustomers();
        if(prevWa){
          const next = customers.find(x => x.wa_id === prevWa);
          if(next){
            active = next;
            renderCustomers();
            await loadCustomerProfile();
            await loadCustomerTickets();
          }
        }
      }catch(e){
        console.error("customers SSE", e);
      }
    });

    es.addEventListener("tickets", async () => {
      try{
        const prevWa = active ? active.wa_id : null;
        await loadCustomers();
        if(prevWa){
          const next = customers.find(x => x.wa_id === prevWa);
          if(next){
            active = next;
            renderCustomers();
            await loadCustomerTickets();
          }
        }
      }catch(e){
        console.error("tickets SSE", e);
      }
    });

    es.onerror = () => {
      setStatus("JS: SSE reconnecting…", false);
      try{ es.close(); }catch(_){}
      clearTimeout(sseRetry);
      sseRetry = setTimeout(connectSSE, 2000);
    };
  }

=======
  if(btnSearch) btnSearch.onclick = () => renderCustomers();
  if(btnClear) btnClear.onclick = () => { if(searchInput) searchInput.value = ""; renderCustomers(); };
  if(searchInput) searchInput.addEventListener("keydown", (e) => { if(e.key === "Enter") renderCustomers(); });
>>>>>>> c905d64 (upgrade to V4.8.8 search + media UI)
  loadCustomers().then(connectSSE);
})();
</script>
</body>
</html>`);
});


app.get("/", (req, res) => res.redirect("/ui"));
app.get("/health", async (req, res) => { try { await dbPing(); res.json({ ok: true }); } catch { res.status(500).json({ ok: false }); } });
app.get("/version", (req, res) => {
  res.set("Cache-Control","no-store");
  res.json({
    ok: true,
    version: APP_VERSION,
    node: process.version,
    railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT || null,
    railwayService: process.env.RAILWAY_SERVICE_NAME || null,
    time: new Date().toISOString()
  });
});

// Quick sanity endpoint to confirm your service is reachable
app.get("/debug/ping", (req, res) => {
  res.set("Cache-Control","no-store");
  res.send("pong " + APP_VERSION + " " + new Date().toISOString());
});

// Optional debug key for one-off diagnostics (set Railway variable DEBUG_KEY to enable)
function checkDebugKey(req) {
  const k = process.env.DEBUG_KEY;
  if (!k) return false;
  const q = String(req.query.key || "");
  return q && q === k;
}

app.get("/debug/tickets", async (req, res) => {
  try {
    if (!checkDebugKey(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    const deptCol = (await columnExists('tickets','dept').catch(()=>false)) ? 'dept' : ((await columnExists('tickets','department').catch(()=>false)) ? 'department' : 'dept');
    const r = await pool.query(`SELECT id, wa_id, ${deptCol} AS dept, status, updated_at, last_message_at, last_message FROM tickets ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 50`);
    res.json({ ok: true, rows: r.rows });
  } catch (e) { res.status(500).json({ ok:false, error: String(e?.message||e) }); }
});

app.get("/debug/messages", async (req, res) => {
  try {
    if (!checkDebugKey(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    const ticketId = Number(req.query.ticket_id || 0);
    if (!ticketId) return res.status(400).json({ ok: false, error: "ticket_id required" });

    const hasTicketId = await columnExists("messages", "ticket_id").catch(()=>false);
    const hasConversationId = await columnExists("messages", "conversation_id").catch(()=>false);

    if (hasTicketId) {
      const r = await pool.query("SELECT id, wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id, created_at FROM messages WHERE ticket_id=$1 ORDER BY id ASC LIMIT 200", [ticketId]);
      return res.json({ ok: true, mode: "ticket_id", rows: r.rows });
    }
    if (hasConversationId) {
      const t = await pool.query("SELECT wa_id, " + ((await columnExists("tickets","conversation_id").catch(()=>false)) ? "conversation_id" : "NULL::bigint AS conversation_id") + " FROM tickets WHERE id=$1 LIMIT 1", [ticketId]);
      if (!t.rows.length) return res.json({ ok: true, mode: "conversation_id", rows: [] });
      const wa_id = String(t.rows[0].wa_id || "");
      const cid = t.rows[0].conversation_id ? String(t.rows[0].conversation_id) : wa_id;
      const r = await pool.query("SELECT id, wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id, created_at FROM messages WHERE conversation_id=$1 ORDER BY id ASC LIMIT 200", [cid]);
      return res.json({ ok: true, mode: "conversation_id", conversation_id: cid, rows: r.rows });
    }
    return res.json({ ok: true, mode: "unknown", rows: [] });
  } catch (e) { res.status(500).json({ ok:false, error: String(e?.message||e) }); }
});


// Boot init + listen
(async () => {
  try {
    await dbPing();
    console.log("✅ DB connected");
    await detectSchema();
    await ensureBaseTables();
    await migrateSchema();
    await ensureSessionTable();
    await ensureIndexes();
    console.log("✅ tables ready (migrated + session + indexes + ticket_notes)");
  } catch (e) {
    console.error("❌ DB init failed:", e);
  }
  console.log("=================================");
  console.log("🚀 Server running");
  console.log("NODE VERSION:", process.version);
  console.log("PORT:", PORT);
  console.log("VERSION MARKER:", APP_VERSION);
  console.log("STRICT ISOLATION:", STRICT_AGENT_VIEW ? "ON" : "OFF");
  console.log("COOKIE_SECURE:", COOKIE_SECURE ? "true" : "false");
  console.log("=================================");
  app.listen(PORT, () => console.log("✅ Server running on port " + PORT));
})();

