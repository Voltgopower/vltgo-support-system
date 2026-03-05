#!/usr/bin/env node
/**
 * Voltgo Support System V4.6.2 (Railway + PostgreSQL Session Store + Mini Dashboard + Media)
 *
 * V4.6:
 * - PostgreSQL session store via connect-pg-simple (no MemoryStore warning)
 * - Auto-create "session" table on boot
 *
 * V4.6.1:
 * - Mini dashboard at /ui:
 *   - Tickets list + view messages + send text + mark read + SSE refresh
 *
 * V4.6.2:
 * - Strict Isolation hotfix: admin (or any non-agent user) can view ALL tickets/messages when STRICT_AGENT_VIEW=1
 * - Media receive + send:
 *   - Receive image/video/audio/document: download media to logs/media, store media_path + caption in messages
 *   - UI shows media thumbnails/links
 *   - UI can upload & send media via WhatsApp (multipart upload + send)
 *
 * Dependencies:
 * - npm i connect-pg-simple
 * - (recommended) npm i openai   (optional, only if OPENAI_API_KEY set)
 * - (optional) npm i sharp       (image thumbnails)
 * - (optional) npm i form-data   (more reliable WhatsApp media upload; native FormData fallback exists)
 *
 * Env required:
 * - VERIFY_TOKEN, WA_TOKEN, PHONE_NUMBER_ID, DATABASE_URL
 * Env optional:
 * - SESSION_SECRET, UI_USER, UI_PASS, UI_USERS
 * - PRESALES_ASSIGNEE, AFTERSALES_ASSIGNEE, STRICT_AGENT_VIEW
 * - OPENAI_API_KEY, OPENAI_MODEL
 * - COOKIE_SECURE (1 for Railway https, 0 for local http)
 */

require("dotenv").config();
console.log("✅ LOADED SERVER.JS: V4.6.2_STABLE_RAILWAY (2026-03-05)");

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

// Optional form-data (more reliable for stream upload)
let FormDataPkg = null;
try {
  FormDataPkg = require("form-data");
  console.log("✅ form-data enabled: media upload uses streams");
} catch (e) {
  console.log("ℹ️ form-data not installed: will try native FormData fallback");
}

const app = express();
app.set("trust proxy", 1);

// Webhook uses express.raw on /webhook; keep global json limit for UI/APIs
app.use(express.json({ limit: "10mb" }));
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

// -------- upload dirs --------
const LOGS_DIR = path.join(process.cwd(), "logs");
const UPLOADS_DIR = path.join(LOGS_DIR, "uploads");
const MEDIA_DIR = path.join(LOGS_DIR, "media");
const THUMBS_DIR = path.join(MEDIA_DIR, "__thumbs");
for (const d of [LOGS_DIR, UPLOADS_DIR, MEDIA_DIR, THUMBS_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 40 * 1024 * 1024 } });

// Serve media files for the dashboard
app.use("/media", express.static(MEDIA_DIR, { fallthrough: true }));
// (thumbs are under /media/__thumbs/...)

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
}

async function migrateSchema() {
  // customers
  await addColumnIfMissing("customers", "name", "name TEXT");
  await addColumnIfMissing("customers", "notes", "notes TEXT");
  await addColumnIfMissing("customers", "created_at", "created_at TIMESTAMP DEFAULT NOW()");
  await addColumnIfMissing("customers", "updated_at", "updated_at TIMESTAMP DEFAULT NOW()");

  // tickets
  await addColumnIfMissing("tickets", "dept", "dept TEXT");
  await addColumnIfMissing("tickets", "status", "status TEXT DEFAULT 'open'");
  await addColumnIfMissing("tickets", "assignee", "assignee TEXT");
  await addColumnIfMissing("tickets", "created_at", "created_at TIMESTAMP DEFAULT NOW()");
  await addColumnIfMissing("tickets", "updated_at", "updated_at TIMESTAMP DEFAULT NOW()");
  await addColumnIfMissing("tickets", "last_message_at", "last_message_at TIMESTAMP");
  await addColumnIfMissing("tickets", "last_message", "last_message TEXT");
  await addColumnIfMissing("tickets", "unread_count", "unread_count INT DEFAULT 0");
  await addColumnIfMissing("tickets", "tags", "tags TEXT[] DEFAULT ARRAY[]::TEXT[]");

  // messages
  await addColumnIfMissing("messages", "msg_type", "msg_type TEXT DEFAULT 'text'");
  await addColumnIfMissing("messages", "caption", "caption TEXT");
  await addColumnIfMissing("messages", "media_path", "media_path TEXT");
  await addColumnIfMissing("messages", "thumb_path", "thumb_path TEXT");
  await addColumnIfMissing("messages", "wa_message_id", "wa_message_id TEXT");
  await addColumnIfMissing("messages", "created_at", "created_at TIMESTAMP DEFAULT NOW()");

  // Backfill dept for old rows
  await pool.query(
    "UPDATE tickets SET dept = CASE " +
      "WHEN dept IS NOT NULL AND dept<>'' THEN dept " +
      "WHEN assignee=$1 THEN 'presales' " +
      "WHEN assignee=$2 THEN 'aftersales' " +
      "ELSE 'presales' END " +
    "WHERE dept IS NULL OR dept='';",
    [PRESALES_ASSIGNEE, AFTERSALES_ASSIGNEE]
  );

  // Normalize status
  await pool.query("UPDATE tickets SET status='open' WHERE status IS NULL OR status='';");
  await pool.query("UPDATE tickets SET status='open' WHERE status NOT IN ('open','pending','closed');");

  // Normalize message direction
  await pool.query("UPDATE messages SET direction='incoming' WHERE direction IS NULL OR direction='';");
  await pool.query("UPDATE messages SET direction='incoming' WHERE direction NOT IN ('incoming','outgoing');");

  // Try to add constraints (ignore if fail)
  try { await pool.query("ALTER TABLE tickets ADD CONSTRAINT tickets_dept_check CHECK (dept IN ('presales','aftersales'));"); } catch (_) {}
  try { await pool.query("ALTER TABLE tickets ADD CONSTRAINT tickets_status_check CHECK (status IN ('open','pending','closed'));"); } catch (_) {}
  try { await pool.query("ALTER TABLE messages ADD CONSTRAINT messages_direction_check CHECK (direction IN ('incoming','outgoing'));"); } catch (_) {}
}

// --- V4.6: session table auto-create ---
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

  // WhatsApp webhook duplicate protection
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_wa_message_id
      ON messages(wa_message_id)
      WHERE wa_message_id IS NOT NULL AND wa_message_id <> '';
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
  return null; // admin/others
}

// -------- session (V4.6 PG store) --------
app.use(
  session({
    store: new pgSession({
      pool: pool,
      tableName: "session"
    }),
    name: "vltgo.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: COOKIE_SECURE,
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

// -------- SSE --------
const sseClients = new Set(); // { res, user }
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

// -------- WhatsApp helpers --------
async function waGraphGet(url) {
  const resp = await fetch(url, {
    method: "GET",
    headers: { "Authorization": "Bearer " + WA_TOKEN }
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error("❌ waGraphGet failed", resp.status, json);
    throw new Error("waGraphGet failed: " + resp.status);
  }
  return json;
}

async function waDownloadFile(url, localPath) {
  const resp = await fetch(url, { headers: { "Authorization": "Bearer " + WA_TOKEN } });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error("❌ waDownloadFile failed", resp.status, txt.slice(0, 300));
    throw new Error("waDownloadFile failed: " + resp.status);
  }
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
  if (!resp.ok) {
    console.error("❌ waSendText failed", resp.status, json);
    throw new Error("waSendText failed: " + resp.status);
  }
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

  // Prefer form-data package (stream upload)
  if (FormDataPkg) {
    const form = new FormDataPkg();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType || "application/octet-stream");
    form.append("file", fs.createReadStream(localFilePath));
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Authorization": "Bearer " + WA_TOKEN, ...form.getHeaders() },
      body: form
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.id) {
      console.error("❌ waUploadMedia failed", resp.status, json);
      throw new Error("waUploadMedia failed: " + resp.status);
    }
    return json.id;
  }

  // Fallback to native FormData (Node 18+/undici). Uses buffer blob.
  if (typeof FormData === "undefined") {
    throw new Error("FormData not available. Install form-data: npm i form-data");
  }
  const fd = new FormData();
  fd.append("messaging_product", "whatsapp");
  fd.append("type", mimeType || "application/octet-stream");

  const buf = await fsp.readFile(localFilePath);
  const filename = path.basename(localFilePath);
  // Blob is available in Node 18+. If not, user should install form-data.
  if (typeof Blob === "undefined") {
    throw new Error("Blob not available. Install form-data: npm i form-data");
  }
  fd.append("file", new Blob([buf], { type: mimeType || "application/octet-stream" }), filename);

  const resp = await fetch(url, { method: "POST", headers: { "Authorization": "Bearer " + WA_TOKEN }, body: fd });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.id) {
    console.error("❌ waUploadMedia failed", resp.status, json);
    throw new Error("waUploadMedia failed: " + resp.status);
  }
  return json.id;
}

async function waSendMediaMessage(toWaId, mediaId, mimeType, caption) {
  const msgType = mimeToMsgType(mimeType);

  const url = "https://graph.facebook.com/v20.0/" + encodeURIComponent(PHONE_NUMBER_ID) + "/messages";
  const payload = { messaging_product: "whatsapp", to: String(toWaId), type: msgType };
  payload[msgType] = { id: String(mediaId) };
  if (caption && (msgType === "image" || msgType === "video" || msgType === "document")) {
    payload[msgType].caption = String(caption).slice(0, 1024);
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Authorization": "Bearer " + WA_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error("❌ waSendMediaMessage failed", resp.status, json);
    throw new Error("waSendMediaMessage failed: " + resp.status);
  }
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
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    });
    const out = String(res.choices?.[0]?.message?.content || "").trim().toLowerCase();
    if (out.includes("presales")) return "presales";
    if (out.includes("aftersales")) return "aftersales";
    return "unknown";
  } catch (e) {
    console.warn("⚠️ aiRoute failed; fallback", e?.message || e);
    return "unknown";
  }
}

async function ensureCustomer(wa_id) {
  await pool.query("INSERT INTO customers(wa_id) VALUES($1) ON CONFLICT (wa_id) DO NOTHING", [String(wa_id)]);
}

async function setCustomerNameIfEmpty(wa_id, name) {
  const n = String(name || "").trim();
  if (!n) return;
  await pool.query(
    "UPDATE customers SET name=$2, updated_at=NOW() WHERE wa_id=$1 AND (name IS NULL OR name='')",
    [String(wa_id), n.slice(0, 120)]
  );
}

async function createTicketIfNeeded(wa_id, dept, assignee) {
  const q = await pool.query(
    "SELECT id FROM tickets WHERE wa_id=$1 AND dept=$2 AND status IN ('open','pending') ORDER BY id DESC LIMIT 1",
    [String(wa_id), String(dept)]
  );
  if (q.rows.length) return q.rows[0].id;
  const ins = await pool.query(
    "INSERT INTO tickets(wa_id, dept, status, assignee, last_message_at, unread_count) VALUES($1,$2,'open',$3,NOW(),0) RETURNING id",
    [String(wa_id), String(dept), assignee || null]
  );
  return ins.rows[0].id;
}

async function bumpTicketOnIncoming(ticket_id, text) {
  await pool.query(
    "UPDATE tickets SET last_message_at=NOW(), last_message=$2, unread_count=COALESCE(unread_count,0)+1, updated_at=NOW() WHERE id=$1",
    [ticket_id, String(text || "").slice(0, 600)]
  );
}
async function bumpTicketOnOutgoing(ticket_id, text) {
  await pool.query(
    "UPDATE tickets SET last_message_at=NOW(), last_message=$2, updated_at=NOW() WHERE id=$1",
    [ticket_id, String(text || "").slice(0, 600)]
  );
}

// Insert message with dedup protection (idempotent on wa_message_id)
async function insertMessage({ ticket_id, wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id }) {
  const r = await pool.query(
    "INSERT INTO messages(ticket_id, wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id) " +
    "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) " +
    "ON CONFLICT (wa_message_id) DO NOTHING " +
    "RETURNING id",
    [
      ticket_id,
      String(wa_id),
      String(direction),
      String(msg_type || "text"),
      text ?? null,
      caption ?? null,
      media_path ?? null,
      thumb_path ?? null,
      wa_message_id ?? null
    ]
  );
  return r.rows[0]?.id || null; // null => duplicate delivery
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
  // kind: image | video | audio | document
  const mediaObj = m[kind];
  const mediaId = mediaObj?.id;
  if (!mediaId) return { media_path: null, thumb_path: null, caption: null, note: "[media without id]" };

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

  // Store as /media/<date>/<file>
  const rel = path.relative(MEDIA_DIR, localAbs).replace(/\\/g, "/");
  const media_path = "/media/" + rel;

  // caption if any
  const caption = String(mediaObj?.caption || "").trim() || null;

  // thumbnail for images (optional)
  let thumb_path = null;
  try {
    if (sharp && kind === "image") {
      const thumbName = base + "_thumb.jpg";
      const thumbAbs = path.join(THUMBS_DIR, thumbName);
      await sharp(localAbs).resize({ width: 480 }).jpeg({ quality: 82 }).toFile(thumbAbs);
      thumb_path = "/media/__thumbs/" + thumbName;
    }
  } catch (_) {}

  return { media_path, thumb_path, caption, mimeType };
}

app.post("/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const rawBody = req.body;
  try {
    if (!verifyAppSecret(req, rawBody)) return res.status(403).send("bad signature");

    const body = JSON.parse(rawBody.toString("utf8"));
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const contacts = value?.contacts || [];
    const profileName = contacts?.[0]?.profile?.name || "";

    const messages = value?.messages || [];
    if (!messages.length) return res.json({ ok: true });

    for (const m of messages) {
      const wa_id = m.from;
      const wa_message_id = m.id;
      const type = m.type;

      await ensureCustomer(wa_id);
      if (profileName) await setCustomerNameIfEmpty(wa_id, profileName);

      let dept = null;
      let assignee = null;

      // Decide dept based on text (if any); for media, reuse last active ticket if possible
      let effectiveText = "";
      if (type === "text") effectiveText = m.text?.body || "";
      else if (type === "button") effectiveText = m.button?.text || "";
      else if (type === "interactive") {
        effectiveText = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "";
      }

      const trimmed = String(effectiveText || "").trim();

      if (trimmed === "1" || /^sales$/i.test(trimmed) || /^presales$/i.test(trimmed) || /^price$/i.test(trimmed)) {
        dept = "presales";
      } else if (trimmed === "2" || /^support$/i.test(trimmed) || /^aftersales$/i.test(trimmed)) {
        dept = "aftersales";
      } else {
        // reuse latest open ticket dept if exists
        const latest = await pool.query(
          "SELECT id, dept FROM tickets WHERE wa_id=$1 AND status IN ('open','pending') ORDER BY updated_at DESC LIMIT 1",
          [String(wa_id)]
        );
        if (latest.rows.length && latest.rows[0].dept) {
          dept = latest.rows[0].dept;
        } else if (effectiveText) {
          let r = keywordRoute(effectiveText);
          if (r === "unknown") r = await aiRoute(effectiveText);
          dept = r === "unknown" ? null : r;
        }
      }

      // If still unknown and it's a plain text message, ask 1/2
      if (!dept && (type === "text" || type === "button" || type === "interactive")) {
        await waSendText(
          wa_id,
          "Hi! To connect you faster, please choose:\n1️⃣ Sales (price/quote)\n2️⃣ Support (warranty/issue)\n\n为更快处理，请回复：\n1）售前（报价/下单）\n2）售后（质保/故障）"
        );
        continue;
      }

      // If media message and dept unknown, default presales (or reuse latest dept earlier)
      if (!dept) dept = "presales";

      assignee = dept === "presales" ? PRESALES_ASSIGNEE : AFTERSALES_ASSIGNEE;
      const ticket_id = await createTicketIfNeeded(wa_id, dept, assignee);

      // Handle inbound message by type
      let msg_type = "text";
      let text = null;
      let caption = null;
      let media_path = null;
      let thumb_path = null;

      if (type === "text") {
        msg_type = "text";
        text = effectiveText;
      } else if (type === "image") {
        msg_type = "image";
        const d = await downloadInboundMedia("image", m, wa_id);
        caption = d.caption;
        media_path = d.media_path;
        thumb_path = d.thumb_path;
        text = "[image]";
      } else if (type === "video") {
        msg_type = "video";
        const d = await downloadInboundMedia("video", m, wa_id);
        caption = d.caption;
        media_path = d.media_path;
        thumb_path = d.thumb_path;
        text = "[video]";
      } else if (type === "audio") {
        msg_type = "audio";
        const d = await downloadInboundMedia("audio", m, wa_id);
        caption = d.caption;
        media_path = d.media_path;
        thumb_path = d.thumb_path;
        text = "[audio]";
      } else if (type === "document") {
        msg_type = "document";
        const d = await downloadInboundMedia("document", m, wa_id);
        caption = d.caption;
        media_path = d.media_path;
        thumb_path = d.thumb_path;
        text = "[document]";
      } else {
        msg_type = "text";
        text = effectiveText || "[unsupported message type]";
      }

      const insertedId = await insertMessage({
        ticket_id,
        wa_id,
        direction: "incoming",
        msg_type,
        text,
        caption,
        media_path,
        thumb_path,
        wa_message_id
      });

      if (!insertedId) continue;

      await bumpTicketOnIncoming(ticket_id, caption || text || `[${msg_type}]`);

      sseSend("message", { wa_id, ticket_id, dept, direction: "incoming", msg_type });
      sseSend("tickets", { changed: true });
      sseSend("customers", { changed: true });
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
    "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#0b1220;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}" +
    ".card{background:#111b2e;border:1px solid #203052;border-radius:16px;padding:28px;width:360px;box-shadow:0 10px 30px rgba(0,0,0,.35)}" +
    "h1{margin:0 0 10px 0;font-size:20px}" +
    "p{margin:0 0 16px 0;color:#9fb0c7;font-size:13px}" +
    "input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #2a3b61;background:#0b1220;color:#e6edf3;margin:8px 0;}" +
    "button{width:100%;padding:10px 12px;border-radius:10px;border:0;background:#2563eb;color:#fff;font-weight:700;cursor:pointer;margin-top:10px}" +
    ".err{background:#3b1d1d;border:1px solid #7f1d1d;color:#fecaca;padding:10px 12px;border-radius:10px;margin:10px 0}" +
    "</style></head><body><div class='card'>" +
    "<h1>Voltgo Support System</h1>" +
    "<p>Login to continue</p>" +
    hint +
    "<form method='POST' action='/login'>" +
    "<input name='username' placeholder='Username' autocomplete='username'/>" +
    "<input name='password' type='password' placeholder='Password' autocomplete='current-password'/>" +
    "<button type='submit'>Login</button>" +
    "</form>" +
    "<p style='margin-top:14px;color:#7f93ad'>Version: V4.6.2 • PG Session • Dedup • Media • Strict Isolation " + (STRICT_AGENT_VIEW ? "ON" : "OFF") + "</p>" +
    "</div></body></html>"
  );
}

app.get("/login", (req, res) => res.status(200).send(renderLogin()));

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

// -------- isolation filter (V4.6.2 HOTFIX) --------
function applyIsolation(req, baseWhere, params) {
  if (!STRICT_AGENT_VIEW) return { where: baseWhere, params };

  const u = getUser(req);
  const dept = userDept(u);

  // ✅ admin / non-agent => no isolation (see all)
  if (!dept) return { where: baseWhere, params };

  // ✅ agents => only their dept
  const clause = (baseWhere ? baseWhere + " AND " : "") + "t.dept = $" + (params.length + 1);
  return { where: clause, params: params.concat([dept]) };
}

async function canAccessTicket(req, ticketId) {
  if (!STRICT_AGENT_VIEW) return true;

  const u = getUser(req);
  const dept = userDept(u);

  // ✅ admin / non-agent => can access all
  if (!dept) return true;

  const r = await pool.query("SELECT dept FROM tickets WHERE id=$1 LIMIT 1", [Number(ticketId)]);
  if (!r.rows.length) return false;
  return r.rows[0].dept === dept;
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
      where =
        "(t.wa_id ILIKE $" + params.length +
        " OR COALESCE(c.name,'') ILIKE $" + params.length +
        " OR COALESCE(t.last_message,'') ILIKE $" + params.length + ")";
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
      "       COALESCE(c.name,'') AS name, t.last_message_at, COALESCE(t.last_message,'') AS last_message," +
      "       COALESCE(t.unread_count,0) AS unread_count" +
      "  FROM tickets t" +
      "  JOIN customers c ON c.wa_id=t.wa_id" +
      (where ? " WHERE " + where : "") +
      " ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC NULLS LAST" +
      " LIMIT 500";

    const r = await pool.query(sql, params);
    res.json({ ok: true, rows: r.rows });
  } catch (e) {
    console.error("❌ /api/tickets error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/messages", requireAuth, async (req, res) => {
  try {
    const ticketId = Number(req.query.ticket_id || 0);
    if (!ticketId) return res.status(400).json({ ok: false, error: "ticket_id required" });
    if (!(await canAccessTicket(req, ticketId))) return res.status(403).json({ ok: false, error: "forbidden" });

    const r = await pool.query(
      "SELECT id, direction, msg_type, COALESCE(text,'') AS text, COALESCE(caption,'') AS caption," +
      "       COALESCE(media_path,'') AS media_path, COALESCE(thumb_path,'') AS thumb_path," +
      "       wa_message_id, created_at " +
      "FROM messages WHERE ticket_id=$1 ORDER BY id ASC LIMIT 2000",
      [ticketId]
    );
    res.json({ ok: true, rows: r.rows });
  } catch (e) {
    console.error("❌ /api/messages error:", e);
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
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ /api/tickets/mark-read error:", e);
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

    await pool.query(
      "INSERT INTO messages(ticket_id, wa_id, direction, msg_type, text, wa_message_id) VALUES($1,$2,'outgoing','text',$3,$4)",
      [ticketId, wa_id, text.slice(0, 4000), outId]
    );

    await bumpTicketOnOutgoing(ticketId, text);
    sseSend("message", { wa_id, ticket_id: ticketId, direction: "outgoing", msg_type: "text" });
    sseSend("tickets", { changed: true });
    res.json({ ok: true, wa: waResp });
  } catch (e) {
    console.error("❌ /api/send error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// V4.6.2: send media (upload -> send -> store outgoing)
app.post("/api/send-media", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const ticketId = Number(req.body.ticket_id || 0);
    const wa_id = String(req.body.wa_id || "").trim();
    const caption = String(req.body.caption || "").trim();
    const f = req.file;

    if (!ticketId || !wa_id || !f) return res.status(400).json({ ok: false, error: "ticket_id, wa_id, file required" });
    if (!(await canAccessTicket(req, ticketId))) return res.status(403).json({ ok: false, error: "forbidden" });

    // Move uploaded file into media dir for persistence
    const folder = path.join(MEDIA_DIR, todayFolder());
    await fsp.mkdir(folder, { recursive: true });
    const ext = safeExtFromMime(f.mimetype, path.extname(f.originalname || ""));
    const base = `out_${wa_id}_${Date.now()}`;
    const destAbs = path.join(folder, base + (ext || ""));
    await fsp.rename(f.path, destAbs).catch(async () => {
      // fallback cross-device rename
      await fsp.copyFile(f.path, destAbs);
      await fsp.unlink(f.path).catch(() => {});
    });

    const rel = path.relative(MEDIA_DIR, destAbs).replace(/\\/g, "/");
    const media_path = "/media/" + rel;

    // Upload to WhatsApp + send
    const mediaId = await waUploadMedia(destAbs, f.mimetype);
    const { msgType, sendResp } = await waSendMediaMessage(wa_id, mediaId, f.mimetype, caption);

    const outId = sendResp?.messages?.[0]?.id || null;

    // Thumbnail for outgoing images (optional)
    let thumb_path = null;
    try {
      if (sharp && msgType === "image") {
        const thumbName = base + "_thumb.jpg";
        const thumbAbs = path.join(THUMBS_DIR, thumbName);
        await sharp(destAbs).resize({ width: 480 }).jpeg({ quality: 82 }).toFile(thumbAbs);
        thumb_path = "/media/__thumbs/" + thumbName;
      }
    } catch (_) {}

    await pool.query(
      "INSERT INTO messages(ticket_id, wa_id, direction, msg_type, caption, media_path, thumb_path, wa_message_id) " +
      "VALUES($1,$2,'outgoing',$3,$4,$5,$6,$7)",
      [ticketId, wa_id, msgType, caption || null, media_path, thumb_path, outId]
    );

    await bumpTicketOnOutgoing(ticketId, caption || `[${msgType}]`);
    sseSend("message", { wa_id, ticket_id: ticketId, direction: "outgoing", msg_type: msgType });
    sseSend("tickets", { changed: true });

    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ /api/send-media error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------- UI (Dashboard) --------
app.get("/ui", requireAuth, async (req, res) => {
  const user = getUser(req);

  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Voltgo Support System</title>
  <style>
    :root{--bg:#0b1220;--panel:#111b2e;--panel2:#0f172a;--border:#203052;--text:#e6edf3;--muted:#9fb0c7;--blue:#2563eb;--red:#ef4444;}
    body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;}
    a{color:#8ab4ff;text-decoration:none}
    .top{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border);background:#0b1220;position:sticky;top:0;z-index:5}
    .brand{font-weight:900;font-size:18px;letter-spacing:.2px}
    .meta{color:var(--muted);font-size:12px}
    .wrap{display:grid;grid-template-columns:420px 1fr;gap:12px;padding:12px}
    .card{background:var(--panel);border:1px solid var(--border);border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.25);overflow:hidden}
    .card h2{margin:0;padding:12px 14px;border-bottom:1px solid var(--border);font-size:14px;color:#cfe0ff}
    .controls{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);background:rgba(0,0,0,.08)}
    input,select,button,textarea{font:inherit}
    input,select,textarea{background:var(--panel2);border:1px solid #2a3b61;color:var(--text);border-radius:10px;padding:8px 10px}
    button{background:var(--blue);border:0;color:white;border-radius:10px;padding:8px 10px;font-weight:800;cursor:pointer}
    button.ghost{background:transparent;border:1px solid #2a3b61;color:#cfe0ff}
    .list{max-height:calc(100vh - 210px);overflow:auto}
    .row{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer}
    .row:hover{background:rgba(255,255,255,.04)}
    .row.active{background:rgba(37,99,235,.18)}
    .row .t{display:flex;justify-content:space-between;gap:8px;align-items:center}
    .badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.14);color:#dbeafe}
    .badge.unread{border-color:rgba(239,68,68,.6);color:#fecaca}
    .small{color:var(--muted);font-size:12px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .main{display:grid;grid-template-rows:auto 1fr auto;min-height:calc(100vh - 92px)}
    .head{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border)}
    .head .left{min-width:0}
    .head .title{font-weight:900}
    .head .sub{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:720px}
    .msgs{padding:12px 14px;overflow:auto;max-height:calc(100vh - 320px)}
    .msg{margin:10px 0;display:flex}
    .bubble{max-width:78%;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.14);border-radius:14px;padding:10px 12px}
    .msg.incoming{justify-content:flex-start}
    .msg.outgoing{justify-content:flex-end}
    .msg.outgoing .bubble{background:rgba(37,99,235,.18);border-color:rgba(37,99,235,.35)}
    .meta2{color:var(--muted);font-size:11px;margin-top:6px}
    .composer{border-top:1px solid var(--border);padding:10px 12px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
    .composer textarea{flex:1;min-height:46px;max-height:140px;resize:vertical}
    .footer{padding:10px 14px;color:#7f93ad;font-size:12px;border-top:1px solid var(--border)}
    .media{margin-top:8px}
    .media img{max-width:320px;border-radius:12px;border:1px solid rgba(255,255,255,.12)}
    .media a{display:inline-block;margin-top:6px}
  </style>
</head>
<body>
  <div class="top">
    <div>
      <div class="brand">Voltgo Support System</div>
      <div class="meta">Logged in as <b>${esc(user)}</b> • <a href="/logout">Logout</a> • Version: <b>V4.6.2</b> • PG Session • Dedup • Media Dashboard</div>
    </div>
    <div class="meta">Strict Isolation: ${STRICT_AGENT_VIEW ? "ON" : "OFF"}</div>
  </div>

  <div class="wrap">
    <div class="card">
      <h2>Tickets</h2>
      <div class="controls">
        <input id="q" placeholder="Search wa_id / name / message" style="flex:1"/>
        <select id="status">
          <option value="">all</option>
          <option value="open">open</option>
          <option value="pending">pending</option>
          <option value="closed">closed</option>
        </select>
        <select id="dept">
          <option value="">all</option>
          <option value="presales">presales</option>
          <option value="aftersales">aftersales</option>
        </select>
      </div>
      <div class="controls">
        <button class="ghost" id="refresh">Refresh</button>
        <label class="meta" style="display:flex;gap:6px;align-items:center">
          <input type="checkbox" id="unreadOnly"/> Unread only
        </label>
        <span class="meta" id="count"></span>
      </div>
      <div class="list" id="ticketList"></div>
    </div>

    <div class="card main">
      <div class="head">
        <div class="left">
          <div class="title" id="tTitle">Select a ticket</div>
          <div class="sub" id="tSub">—</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="ghost" id="markRead" disabled>Mark as read</button>
        </div>
      </div>

      <div class="msgs" id="msgs"></div>

      <div class="composer">
        <input id="file" type="file" style="width:240px" disabled />
        <textarea id="reply" placeholder="Type reply..." disabled></textarea>
        <button id="send" disabled>Send</button>
        <button id="sendFile" class="ghost" disabled>Send File</button>
      </div>

      <div class="footer">
        Media tips: images show thumbnail; video/audio/document show download link. Uploaded files are stored under /logs/media on server.
      </div>
    </div>
  </div>

<script>
  const el = (id)=>document.getElementById(id);
  let tickets = [];
  let active = null;

  async function api(url, opts){
    const r = await fetch(url, opts);
    const j = await r.json().catch(()=>({}));
    if(!r.ok || j.ok===false) throw new Error(j.error || ('HTTP '+r.status));
    return j;
  }
  function esc(s){
    return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function renderTickets(){
    const list = el('ticketList');
    list.innerHTML = '';
    let n = 0;
    tickets.forEach(t=>{
      n++;
      const div = document.createElement('div');
      div.className = 'row' + (active && active.id===t.id ? ' active':'');
      const unread = Number(t.unread_count||0);
      div.innerHTML = \`
        <div class="t">
          <div style="min-width:0">
            <div><b>#\${t.id}</b> <span class="badge">\${t.dept}</span> <span class="badge">\${t.status}</span> \${unread>0?'<span class="badge unread">unread '+unread+'</span>':''}</div>
            <div class="small">\${(t.name||'').trim() ? esc(t.name) : esc(t.wa_id)} • \${esc(t.last_message||'')}</div>
          </div>
          <div class="small">\${t.last_message_at ? new Date(t.last_message_at).toLocaleString() : ''}</div>
        </div>
      \`;
      div.onclick = ()=>selectTicket(t);
      list.appendChild(div);
    });
    el('count').textContent = n ? (n + ' tickets') : '0';
  }

  async function loadTickets(){
    const q = el('q').value.trim();
    const status = el('status').value;
    const dept = el('dept').value;
    const unread = el('unreadOnly').checked ? '1':'0';

    const params = new URLSearchParams();
    if(q) params.set('q', q);
    if(status) params.set('status', status);
    if(dept) params.set('dept', dept);
    if(unread==='1') params.set('unread', '1');

    const j = await api('/api/tickets?' + params.toString());
    tickets = j.rows || [];
    renderTickets();
  }

  async function selectTicket(t){
    active = t;
    renderTickets();
    el('tTitle').textContent = '#' + t.id + ' • ' + (t.name && t.name.trim() ? t.name : t.wa_id);
    el('tSub').textContent = t.dept + ' • ' + t.status + (t.assignee ? ' • ' + t.assignee : '');
    el('reply').disabled = false;
    el('send').disabled = false;
    el('sendFile').disabled = false;
    el('file').disabled = false;
    el('markRead').disabled = false;
    await loadMessages();
  }

  function renderMedia(m){
    const media_path = (m.media_path||'').trim();
    const thumb_path = (m.thumb_path||'').trim();
    if(!media_path) return '';
    const link = '<a href="'+esc(media_path)+'" target="_blank">Download / Open</a>';
    if(thumb_path){
      return '<div class="media"><img src="'+esc(thumb_path)+'"/><div>'+link+'</div></div>';
    }
    return '<div class="media">'+link+'</div>';
  }

  async function loadMessages(){
    if(!active) return;
    const j = await api('/api/messages?ticket_id=' + encodeURIComponent(active.id));
    const rows = j.rows || [];
    const box = el('msgs');
    box.innerHTML = '';
    rows.forEach(m=>{
      const div = document.createElement('div');
      div.className = 'msg ' + (m.direction==='outgoing' ? 'outgoing':'incoming');
      const txt = (m.text || m.caption || '').trim();
      const ts = m.created_at ? new Date(m.created_at).toLocaleString() : '';
      div.innerHTML = \`
        <div class="bubble">
          <div>\${esc(txt)}</div>
          \${renderMedia(m)}
          <div class="meta2">\${esc(m.direction)} • \${esc(m.msg_type)} • \${esc(ts)}</div>
        </div>\`;
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight + 9999;
  }

  async function sendReply(){
    if(!active) return;
    const text = el('reply').value.trim();
    if(!text) return;
    el('send').disabled = true;
    try{
      await api('/api/send', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ticket_id: active.id, wa_id: active.wa_id, text })
      });
      el('reply').value = '';
      await loadTickets();
      await loadMessages();
    }catch(e){
      alert('Send failed: ' + e.message);
    }finally{
      el('send').disabled = false;
    }
  }

  async function sendFile(){
    if(!active) return;
    const f = el('file').files && el('file').files[0];
    if(!f){ alert('Please choose a file first'); return; }

    const fd = new FormData();
    fd.append('ticket_id', String(active.id));
    fd.append('wa_id', String(active.wa_id));
    fd.append('file', f);
    fd.append('caption', el('reply').value.trim());

    el('sendFile').disabled = true;
    try{
      const r = await fetch('/api/send-media', { method:'POST', body: fd });
      const j = await r.json().catch(()=>({}));
      if(!r.ok || j.ok===false) throw new Error(j.error || ('HTTP '+r.status));
      el('file').value = '';
      el('reply').value = '';
      await loadTickets();
      await loadMessages();
    }catch(e){
      alert('Send file failed: ' + e.message);
    }finally{
      el('sendFile').disabled = false;
    }
  }

  async function markRead(){
    if(!active) return;
    try{
      await api('/api/tickets/mark-read', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ticket_id: active.id })
      });
      await loadTickets();
    }catch(e){
      alert('Failed: ' + e.message);
    }
  }

  // Controls
  el('refresh').onclick = ()=>loadTickets();
  el('send').onclick = ()=>sendReply();
  el('sendFile').onclick = ()=>sendFile();
  el('markRead').onclick = ()=>markRead();
  ['q','status','dept','unreadOnly'].forEach(id=>{
    el(id).addEventListener('change', ()=>loadTickets());
    el(id).addEventListener('keyup', (ev)=>{ if(id==='q' && ev.key==='Enter') loadTickets(); });
  });

  // SSE live updates
  try{
    const es = new EventSource('/sse');
    es.addEventListener('tickets', ()=>loadTickets());
    es.addEventListener('message', ()=>{ if(active) loadMessages(); });
  }catch(_){}

  loadTickets();
</script>
</body>
</html>`);
});

app.get("/", (req, res) => res.redirect("/ui"));

app.get("/health", async (req, res) => {
  try { await dbPing(); res.json({ ok: true }); } catch { res.status(500).json({ ok: false }); }
});

// -------- boot --------
(async () => {
  try {
    await dbPing();
    console.log("✅ DB connected");

    await ensureBaseTables();
    await migrateSchema();

    await ensureSessionTable();
    await ensureIndexes();

    console.log("✅ tables ready (migrated + session + indexes)");
  } catch (e) {
    console.error("❌ DB init failed:", e);
  }

  console.log("=================================");
  console.log("🚀 Server running");
  console.log("NODE VERSION:", process.version);
  console.log("PORT:", PORT);
  console.log("VERIFY_TOKEN SET:", !!process.env.VERIFY_TOKEN ? "YES" : "NO");
  console.log("APP_SECRET SET:", !!process.env.APP_SECRET ? "YES" : "NO");
  console.log("UI_USERS SET:", !!process.env.UI_USERS ? "YES" : "NO");
  console.log("SESSION_SECRET SET:", !!process.env.SESSION_SECRET ? "YES" : "NO");
  console.log("OPENAI_API_KEY SET:", !!process.env.OPENAI_API_KEY ? "YES" : "NO");
  console.log("WA_TOKEN SET:", !!process.env.WA_TOKEN ? "YES" : "NO");
  console.log("PHONE_NUMBER_ID SET:", !!process.env.PHONE_NUMBER_ID ? "YES" : "NO");
  console.log("DATABASE_URL SET:", !!process.env.DATABASE_URL ? "true" : "false");
  console.log("VERSION MARKER: V4.6.2");
  console.log("STRICT ISOLATION:", STRICT_AGENT_VIEW ? "ON" : "OFF");
  console.log("COOKIE_SECURE:", COOKIE_SECURE ? "true" : "false");
  console.log("=================================");

  app.listen(PORT, () => console.log("✅ Server running on port " + PORT));
})();
