#!/usr/bin/env node
/**
 * Voltgo Support System V4.5 (Railway Stable)
 * - DB-backed (Postgres)
 * - Multi-agent UI login (UI_USERS=presales:111111,aftersales:222222)
 * - Dept routing: presales / aftersales
 *   - AI routing optional (OPENAI_API_KEY) with fallback menu 1/2 when unknown
 * - Strict isolation (STRICT_AGENT_VIEW=1): agents only see their dept
 * - Customers (name + notes) + Tickets + Messages
 * - Realtime UI via SSE (auto push)
 *
 * Required .env variables (Railway Variables or local .env):
 *   VERIFY_TOKEN=voltgo_webhook_verify
 *   WA_TOKEN=... (Meta permanent/system user token)
 *   PHONE_NUMBER_ID=...
 *   DATABASE_URL=postgresql://...
 *   SESSION_SECRET=...
 *
 * Optional:
 *   UI_USERS=presales:111111,aftersales:222222   (if not set, falls back to UI_USER/UI_PASS)
 *   UI_USER=admin
 *   UI_PASS=voltgo123
 *   PRESALES_ASSIGNEE=presales
 *   AFTERSALES_ASSIGNEE=aftersales
 *   STRICT_AGENT_VIEW=1
 *   OPENAI_API_KEY=...   (enables AI routing)
 *   OPENAI_MODEL=gpt-4o-mini
 *   APP_SECRET=... (Meta webhook signature verify; optional)
 */

require("dotenv").config();
console.log("✅ LOADED SERVER.JS: V4.5_STABLE_RAILWAY (2026-03-04)");

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const session = require("express-session");
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

// Optional sharp (thumbnails)
let sharp = null;
try {
  sharp = require("sharp");
  console.log("✅ sharp enabled: thumbnails will be generated");
} catch (e) {
  console.log("ℹ️ sharp not installed: thumbnails disabled (ok)");
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// ------------------------ ENV helpers ------------------------
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

// ------------------------ Session ------------------------
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // Railway terminates TLS; this is ok behind proxy
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

// ------------------------ Upload dirs ------------------------
const LOGS_DIR = path.join(process.cwd(), "logs");
const UPLOADS_DIR = path.join(LOGS_DIR, "uploads");
const MEDIA_DIR = path.join(LOGS_DIR, "media");
const THUMBS_DIR = path.join(MEDIA_DIR, "__thumbs");
for (const d of [LOGS_DIR, UPLOADS_DIR, MEDIA_DIR, THUMBS_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 25 * 1024 * 1024 }
});

// ------------------------ DB ------------------------
const pool = new Pool({ connectionString: DATABASE_URL });

async function dbPing() {
  const c = await pool.connect();
  try {
    await c.query("SELECT 1");
  } finally {
    c.release();
  }
}

async function ensureTables() {
  // Customers: stable entity per wa_id
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      wa_id TEXT PRIMARY KEY,
      name TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Tickets: can have multiple tickets per customer
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id BIGSERIAL PRIMARY KEY,
      wa_id TEXT NOT NULL REFERENCES customers(wa_id) ON DELETE CASCADE,
      dept TEXT NOT NULL CHECK (dept IN ('presales','aftersales')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','closed')),
      assignee TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      last_message_at TIMESTAMP,
      last_message TEXT,
      unread_count INT DEFAULT 0,
      tags TEXT[] DEFAULT ARRAY[]::TEXT[]
    );
  `);

  // Messages: attach to ticket
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      wa_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
      msg_type TEXT NOT NULL DEFAULT 'text',
      text TEXT,
      caption TEXT,
      media_path TEXT,
      thumb_path TEXT,
      wa_message_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // quick indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_wa_id ON tickets(wa_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_dept ON tickets(dept);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_ticket_id ON messages(ticket_id);`);
}

function nowIso() {
  return new Date().toISOString();
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ------------------------ Auth / Users ------------------------
function parseUiUsers() {
  // UI_USERS=presales:111111,aftersales:222222
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

function getUserFromSession(req) {
  if (req.session && req.session.user) return req.session.user;
  return null;
}

function requireAuth(req, res, next) {
  const u = getUserFromSession(req);
  if (!u) return res.redirect("/login");
  return next();
}

function userDept(username) {
  if (!username) return null;
  if (username === PRESALES_ASSIGNEE) return "presales";
  if (username === AFTERSALES_ASSIGNEE) return "aftersales";
  return null;
}

// ------------------------ SSE (Realtime UI) ------------------------
const sseClients = new Set(); // { res, user }
function sseSend(type, payload) {
  const data = JSON.stringify({ type, payload, ts: nowIso() });
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
  const user = getUserFromSession(req);
  const client = { res, user };
  sseClients.add(client);
  res.write("event: hello\n");
  res.write("data: " + JSON.stringify({ ok: true, user, ts: nowIso() }) + "\n\n");
  req.on("close", () => {
    sseClients.delete(client);
  });
});

// ------------------------ WhatsApp helpers ------------------------
async function waSendText(toWaId, text) {
  const url = "https://graph.facebook.com/v20.0/" + encodeURIComponent(PHONE_NUMBER_ID) + "/messages";
  const body = {
    messaging_product: "whatsapp",
    to: String(toWaId),
    type: "text",
    text: { body: String(text) }
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + WA_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error("❌ waSendText failed", resp.status, json);
    throw new Error("waSendText failed: " + resp.status);
  }
  return json;
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

// ------------------------ Routing logic ------------------------
const ROUTE_HINTS = {
  presales: ["price", "quote", "cost", "wholesale", "dealer", "buy", "order", "discount", "lead"],
  aftersales: ["support", "warranty", "broken", "issue", "problem", "return", "rma", "bms", "charge", "charging", "fault", "help"]
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
    console.warn("⚠️ aiRoute failed; fallback to keyword/menu", e?.message || e);
    return "unknown";
  }
}

async function ensureCustomer(wa_id) {
  await pool.query(
    "INSERT INTO customers(wa_id) VALUES($1) ON CONFLICT (wa_id) DO NOTHING",
    [String(wa_id)]
  );
}

async function createTicketIfNeeded(wa_id, dept, assignee) {
  // If there is an open ticket for same wa_id+dept, reuse it.
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
    "UPDATE tickets SET last_message_at=NOW(), last_message=$2, unread_count=unread_count+1, updated_at=NOW() WHERE id=$1",
    [ticket_id, String(text || "").slice(0, 600)]
  );
}

async function bumpTicketOnOutgoing(ticket_id, text) {
  await pool.query(
    "UPDATE tickets SET last_message_at=NOW(), last_message=$2, updated_at=NOW() WHERE id=$1",
    [ticket_id, String(text || "").slice(0, 600)]
  );
}

async function insertMessage({ ticket_id, wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id }) {
  await pool.query(
    "INSERT INTO messages(ticket_id, wa_id, direction, msg_type, text, caption, media_path, thumb_path, wa_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
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
}

// ------------------------ Webhook (Verify + Receive) ------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post(
  "/webhook",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    const rawBody = req.body;
    try {
      if (!verifyAppSecret(req, rawBody)) {
        return res.status(403).send("bad signature");
      }

      const body = JSON.parse(rawBody.toString("utf8"));

      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const messages = value?.messages || [];
      if (!messages.length) return res.json({ ok: true });

      for (const m of messages) {
        const wa_id = m.from;
        const wa_message_id = m.id;
        const type = m.type;

        let text = "";
        if (type === "text") text = m.text?.body || "";
        else if (type === "button") text = m.button?.text || "";
        else if (type === "interactive") {
          // e.g. list reply
          text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "";
        } else {
          text = "[non-text message]";
        }

        await ensureCustomer(wa_id);

        // Dept selection logic:
        // 1) If message is "1" or "2" -> explicit dept.
        // 2) Else if existing open/pending ticket exists in either dept, reuse the most recently updated ticket
        //    (but STRICT isolation still applies to agents in UI).
        // 3) Else try AI routing; if unknown -> ask menu.
        let dept = null;

        const trimmed = String(text || "").trim();
        if (trimmed === "1" || /^sales$/i.test(trimmed) || /^presales$/i.test(trimmed) || /^price$/i.test(trimmed)) {
          dept = "presales";
        } else if (trimmed === "2" || /^support$/i.test(trimmed) || /^aftersales$/i.test(trimmed)) {
          dept = "aftersales";
        } else {
          // check latest open ticket
          const latest = await pool.query(
            "SELECT id, dept FROM tickets WHERE wa_id=$1 AND status IN ('open','pending') ORDER BY updated_at DESC LIMIT 1",
            [String(wa_id)]
          );
          if (latest.rows.length) {
            dept = latest.rows[0].dept;
          } else {
            // route
            let r = keywordRoute(text);
            if (r === "unknown") r = await aiRoute(text);
            if (r === "unknown") {
              await waSendText(
                wa_id,
                "Hi! To connect you faster, please choose:\n1️⃣ Sales (price/quote)\n2️⃣ Support (warranty/issue)"
              );
              continue;
            }
            dept = r;
          }
        }

        const assignee = dept === "presales" ? PRESALES_ASSIGNEE : AFTERSALES_ASSIGNEE;
        const ticket_id = await createTicketIfNeeded(wa_id, dept, assignee);

        await insertMessage({
          ticket_id,
          wa_id,
          direction: "incoming",
          msg_type: "text",
          text,
          wa_message_id
        });

        await bumpTicketOnIncoming(ticket_id, text);

        sseSend("message", { wa_id, ticket_id, dept, direction: "incoming", text });
        sseSend("tickets", { changed: true });
        sseSend("customers", { changed: true });
      }

      return res.json({ ok: true });

    } catch (e) {
      console.error("❌ webhook error:", e);
      return res.status(200).json({ ok: true });
    }
  }
);

// ------------------------ UI: Login/Logout ------------------------
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
    "<p style='margin-top:14px;color:#7f93ad'>Version: V4.5 • Strict Isolation " + (STRICT_AGENT_VIEW ? "ON" : "OFF") + "</p>" +
    "</div></body></html>"
  );
}

app.get("/login", (req, res) => {
  res.status(200).send(renderLogin());
});

app.post("/login", (req, res) => {
  const u = String(req.body.username || "").trim();
  const p = String(req.body.password || "").trim();

  let ok = false;
  if (UI_USERS_MAP) {
    ok = UI_USERS_MAP[u] && UI_USERS_MAP[u] === p;
  } else {
    ok = u === UI_USER_FALLBACK && p === UI_PASS_FALLBACK;
  }

  if (!ok) return res.status(401).send(renderLogin("Invalid username or password"));

  req.session.user = u;
  req.session.save(() => res.redirect("/ui"));
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ------------------------ API: Customers/Tickets/Messages ------------------------
function applyIsolationFilter(req, baseWhere, params) {
  const u = getUserFromSession(req);
  const dept = userDept(u);

  if (!STRICT_AGENT_VIEW) return { where: baseWhere, params };

  if (dept === "presales" || dept === "aftersales") {
    const clause = (baseWhere ? (baseWhere + " AND ") : "") + "t.dept = $" + (params.length + 1);
    return { where: clause, params: params.concat([dept]) };
  }
  // Unknown user => no dept => show nothing
  const clause = (baseWhere ? (baseWhere + " AND ") : "") + "1=0";
  return { where: clause, params };
}

// Customers list (aggregated across tickets)
app.get("/api/customers", requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const unreadOnly = String(req.query.unread || "0") === "1";

    let where = "";
    let params = [];

    if (q) {
      params.push("%" + q + "%");
      where = "(c.wa_id ILIKE $" + params.length + " OR COALESCE(c.name,'') ILIKE $" + params.length + " OR COALESCE(c.notes,'') ILIKE $" + params.length + " OR COALESCE(t.last_message,'') ILIKE $" + params.length + ")";
    }
    if (unreadOnly) {
      where = (where ? where + " AND " : "") + "t.unread_count > 0";
    }

    // Isolation via tickets alias t
    const iso = applyIsolationFilter(req, where, params);
    where = iso.where;
    params = iso.params;

    const sql =
      "SELECT c.wa_id, COALESCE(c.name,'') AS name, COALESCE(c.notes,'') AS notes," +
      "       COUNT(DISTINCT t.id) AS tickets," +
      "       SUM(CASE WHEN t.status='open' THEN 1 ELSE 0 END) AS open_tickets," +
      "       MAX(t.last_message_at) AS last_time," +
      "       MAX(t.last_message) AS last_message," +
      "       SUM(COALESCE(t.unread_count,0)) AS unread" +
      "  FROM customers c" +
      "  LEFT JOIN tickets t ON t.wa_id=c.wa_id" +
      (where ? " WHERE " + where : "") +
      " GROUP BY c.wa_id, c.name, c.notes" +
      " ORDER BY COALESCE(MAX(t.last_message_at), c.updated_at) DESC NULLS LAST" +
      " LIMIT 500";

    const r = await pool.query(sql, params);
    res.json({ ok: true, rows: r.rows });
  } catch (e) {
    console.error("❌ /api/customers error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Customer profile
app.get("/api/customer/:wa_id", requireAuth, async (req, res) => {
  try {
    const wa_id = String(req.params.wa_id);
    const c = await pool.query("SELECT wa_id, COALESCE(name,'') AS name, COALESCE(notes,'') AS notes FROM customers WHERE wa_id=$1", [wa_id]);
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, customer: c.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Update name/notes
app.post("/api/customer/:wa_id", requireAuth, async (req, res) => {
  try {
    const wa_id = String(req.params.wa_id);
    const name = req.body.name != null ? String(req.body.name).slice(0, 120) : null;
    const notes = req.body.notes != null ? String(req.body.notes).slice(0, 2000) : null;

    await pool.query(
      "UPDATE customers SET name=COALESCE($2,name), notes=COALESCE($3,notes), updated_at=NOW() WHERE wa_id=$1",
      [wa_id, name, notes]
    );
    sseSend("customers", { changed: true });
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ update customer error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Tickets list
app.get("/api/tickets", requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim(); // open/pending/closed
    const dept = String(req.query.dept || "").trim();     // presales/aftersales
    const unreadOnly = String(req.query.unread || "0") === "1";

    let where = "";
    let params = [];

    if (q) {
      params.push("%" + q + "%");
      where = "(t.wa_id ILIKE $" + params.length + " OR COALESCE(c.name,'') ILIKE $" + params.length + " OR COALESCE(t.last_message,'') ILIKE $" + params.length + ")";
    }
    if (status && (status === "open" || status === "pending" || status === "closed")) {
      params.push(status);
      where = (where ? where + " AND " : "") + "t.status = $" + params.length;
    }
    if (dept && (dept === "presales" || dept === "aftersales")) {
      params.push(dept);
      where = (where ? where + " AND " : "") + "t.dept = $" + params.length;
    }
    if (unreadOnly) {
      where = (where ? where + " AND " : "") + "t.unread_count > 0";
    }

    const iso = applyIsolationFilter(req, where, params);
    where = iso.where;
    params = iso.params;

    const sql =
      "SELECT t.id, t.wa_id, t.dept, t.status, COALESCE(t.assignee,'') AS assignee," +
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

// Ticket messages
app.get("/api/ticket/:id/messages", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    // isolation: ensure ticket visible to user
    const base = "t.id=$1";
    const iso = applyIsolationFilter(req, base, [id]);
    const check = await pool.query(
      "SELECT t.id FROM tickets t WHERE " + iso.where + " LIMIT 1",
      iso.params
    );
    if (!check.rows.length) return res.status(404).json({ ok: false, error: "ticket not found" });

    const r = await pool.query(
      "SELECT id, direction, msg_type, COALESCE(text,'') AS text, COALESCE(caption,'') AS caption, media_path, thumb_path, created_at FROM messages WHERE ticket_id=$1 ORDER BY id ASC LIMIT 2000",
      [id]
    );

    // mark read
    await pool.query("UPDATE tickets SET unread_count=0 WHERE id=$1", [id]);
    sseSend("tickets", { changed: true });

    res.json({ ok: true, rows: r.rows });
  } catch (e) {
    console.error("❌ /api/ticket/:id/messages error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Send message from UI
app.post("/api/ticket/:id/send", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "empty" });

    // isolation check + get wa_id
    const base = "t.id=$1";
    const iso = applyIsolationFilter(req, base, [id]);
    const t = await pool.query(
      "SELECT t.id, t.wa_id, t.dept FROM tickets t WHERE " + iso.where + " LIMIT 1",
      iso.params
    );
    if (!t.rows.length) return res.status(404).json({ ok: false, error: "ticket not found" });

    const wa_id = t.rows[0].wa_id;

    const waResp = await waSendText(wa_id, text);
    const wa_message_id = waResp?.messages?.[0]?.id || null;

    await insertMessage({
      ticket_id: id,
      wa_id,
      direction: "outgoing",
      msg_type: "text",
      text,
      wa_message_id
    });

    await bumpTicketOnOutgoing(id, text);

    sseSend("message", { wa_id, ticket_id: id, direction: "outgoing", text });
    sseSend("tickets", { changed: true });
    sseSend("customers", { changed: true });

    res.json({ ok: true });
  } catch (e) {
    console.error("❌ send error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Change ticket status
app.post("/api/ticket/:id/status", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = String(req.body.status || "").trim();
    if (!["open", "pending", "closed"].includes(status)) {
      return res.status(400).json({ ok: false, error: "bad status" });
    }
    const base = "t.id=$1";
    const iso = applyIsolationFilter(req, base, [id]);
    const upd = await pool.query(
      "UPDATE tickets t SET status=$2, updated_at=NOW() WHERE " + iso.where,
      iso.params.concat([status])
    );
    sseSend("tickets", { changed: true });
    res.json({ ok: true, updated: upd.rowCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ------------------------ UI HTML ------------------------
function layout(title, user, bodyHtml, extraHead) {
  const head = extraHead || "";
  return (
    "<!doctype html><html><head><meta charset='utf-8'/>" +
    "<meta name='viewport' content='width=device-width, initial-scale=1'/>" +
    "<title>" + esc(title) + "</title>" +
    "<style>" +
    "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f6f8fb;color:#0b1220;margin:0}" +
    ".top{display:flex;align-items:center;justify-content:space-between;padding:22px 28px}" +
    ".brand{font-size:38px;font-weight:900;letter-spacing:-.8px}" +
    ".sub{color:#6b7a90;font-size:14px;margin-top:4px}" +
    ".right{display:flex;align-items:center;gap:12px;color:#6b7a90}" +
    ".pill{background:#fff;border:1px solid #e3e8f2;border-radius:999px;padding:10px 14px;font-weight:700;color:#0b1220;cursor:pointer}" +
    ".pill.primary{background:#2563eb;border-color:#2563eb;color:#fff}" +
    ".pill.ghost{background:#fff}" +
    ".wrap{padding:0 28px 28px 28px}" +
    ".panel{background:#fff;border:1px solid #e3e8f2;border-radius:18px;box-shadow:0 10px 30px rgba(11,18,32,.06)}" +
    ".toolbar{display:flex;flex-wrap:wrap;gap:10px;padding:14px 14px;border-bottom:1px solid #eef2f8}" +
    "input,select{height:44px;border-radius:999px;border:1px solid #e3e8f2;padding:0 14px;background:#fff;outline:none;font-size:14px}" +
    "input{min-width:280px}" +
    "table{width:100%;border-collapse:separate;border-spacing:0}" +
    "th,td{padding:14px 16px;border-bottom:1px solid #eef2f8;font-size:14px;vertical-align:middle}" +
    "th{color:#6b7a90;font-weight:800;text-transform:none;letter-spacing:.2px}" +
    "tr:hover td{background:#fbfcfe}" +
    "a{color:#2563eb;text-decoration:none;font-weight:800}" +
    ".badge{display:inline-flex;align-items:center;gap:8px;border:1px solid #e3e8f2;border-radius:999px;padding:8px 12px;background:#fff;color:#0b1220;font-weight:800}" +
    ".badge.green{border-color:#bbf7d0;background:#f0fdf4;color:#166534}" +
    ".badge.gray{border-color:#e5e7eb;background:#f9fafb;color:#374151}" +
    ".muted{color:#6b7a90}" +
    ".tabs{display:flex;gap:12px;margin:8px 0 16px 0}" +
    ".tab{padding:10px 16px;border-radius:999px;border:1px solid #e3e8f2;background:#fff;font-weight:900;cursor:pointer}" +
    ".tab.active{background:#2563eb;color:#fff;border-color:#2563eb}" +
    ".grid{display:grid;grid-template-columns: 1.1fr .9fr;gap:16px}" +
    ".card{background:#fff;border:1px solid #e3e8f2;border-radius:18px;box-shadow:0 10px 30px rgba(11,18,32,.06)}" +
    ".card .hd{padding:14px 16px;border-bottom:1px solid #eef2f8;font-weight:900}" +
    ".card .bd{padding:14px 16px}" +
    "textarea{width:100%;min-height:110px;border-radius:14px;border:1px solid #e3e8f2;padding:10px 12px;font-size:14px;outline:none;resize:vertical}" +
    ".msgs{max-height:520px;overflow:auto;padding:14px 16px}" +
    ".msg{margin:10px 0;display:flex}" +
    ".bubble{max-width:78%;padding:10px 12px;border-radius:14px;border:1px solid #e3e8f2;background:#fff}" +
    ".msg.in .bubble{background:#f9fafb}" +
    ".msg.out{justify-content:flex-end}" +
    ".msg.out .bubble{background:#eef2ff;border-color:#c7d2fe}" +
    ".msg .meta{font-size:12px;color:#6b7a90;margin-top:6px}" +
    ".sendRow{display:flex;gap:10px;align-items:center;padding:14px 16px;border-top:1px solid #eef2f8}" +
    ".sendRow input{flex:1;min-width:0}" +
    ".small{font-size:12px;color:#6b7a90}" +
    "</style>" +
    head +
    "</head><body>" +
    "<div class='top'>" +
    "<div><div class='brand'>" + esc(title) + "</div>" +
    "<div class='sub'>DB-backed • Version: V4_5_STABLE_2026-03-04 • Strict Isolation " + (STRICT_AGENT_VIEW ? "ON" : "OFF") + "</div></div>" +
    "<div class='right'><span class='muted'>" + esc(user || "") + "</span>" +
    "<a class='pill ghost' href='/logout'>Logout</a></div></div>" +
    "<div class='wrap'>" + bodyHtml + "</div>" +
    "</body></html>"
  );
}

function uiIndexPage(user) {
  const body =
    "<div class='tabs'>" +
    "<button class='tab active' id='tabCustomers'>Customers</button>" +
    "<button class='tab' id='tabTickets'>Tickets</button>" +
    "</div>" +
    "<div class='panel' id='panelCustomers'>" +
    "<div class='toolbar'>" +
    "<input id='qCustomers' placeholder='Search wa_id / name / notes / last message'/>" +
    "<label class='badge gray'><input type='checkbox' id='unreadCustomers' style='margin-right:8px'/>Unread only</label>" +
    "<button class='pill primary' id='applyCustomers'>Apply</button>" +
    "<button class='pill' id='clearCustomers'>Clear</button>" +
    "</div>" +
    "<div style='overflow:auto'>" +
    "<table><thead><tr>" +
    "<th style='width:190px'>wa_id</th><th style='width:220px'>Name</th><th style='width:90px'>Open</th><th style='width:90px'>Tickets</th><th style='width:200px'>Last time</th><th>Last message</th>" +
    "</tr></thead><tbody id='customersTbody'>" +
    "<tr><td colspan='6' class='muted'>Loading...</td></tr>" +
    "</tbody></table>" +
    "</div></div>" +

    "<div class='panel' id='panelTickets' style='display:none'>" +
    "<div class='toolbar'>" +
    "<input id='qTickets' placeholder='Search wa_id / name / last message'/>" +
    "<select id='deptTickets'><option value=''>All depts</option><option value='presales'>presales</option><option value='aftersales'>aftersales</option></select>" +
    "<select id='statusTickets'><option value=''>All status</option><option value='open'>open</option><option value='pending'>pending</option><option value='closed'>closed</option></select>" +
    "<label class='badge gray'><input type='checkbox' id='unreadTickets' style='margin-right:8px'/>Unread only</label>" +
    "<button class='pill primary' id='applyTickets'>Apply</button>" +
    "<button class='pill' id='clearTickets'>Clear</button>" +
    "</div>" +
    "<div style='overflow:auto'>" +
    "<table><thead><tr>" +
    "<th style='width:90px'>Ticket</th><th style='width:180px'>wa_id</th><th style='width:140px'>Name</th><th style='width:110px'>Dept</th><th style='width:110px'>Status</th><th style='width:110px'>Unread</th><th style='width:200px'>Last time</th><th>Last message</th>" +
    "</tr></thead><tbody id='ticketsTbody'>" +
    "<tr><td colspan='8' class='muted'>Loading...</td></tr>" +
    "</tbody></table>" +
    "</div></div>" +

    "<script>" +
    "const $=s=>document.querySelector(s);" +
    "function fmt(ts){ if(!ts) return ''; try{return new Date(ts).toLocaleString();}catch(e){return ts;} }" +

    "function setTab(name){ " +
      "if(name==='customers'){ $('#tabCustomers').classList.add('active'); $('#tabTickets').classList.remove('active'); $('#panelCustomers').style.display='block'; $('#panelTickets').style.display='none'; }" +
      "else{ $('#tabTickets').classList.add('active'); $('#tabCustomers').classList.remove('active'); $('#panelTickets').style.display='block'; $('#panelCustomers').style.display='none'; }" +
    "}" +
    "$('#tabCustomers').onclick=()=>setTab('customers');" +
    "$('#tabTickets').onclick=()=>setTab('tickets');" +

    "async function loadCustomers(){ " +
      "const q=encodeURIComponent($('#qCustomers').value||'');" +
      "const unread=$('#unreadCustomers').checked?'1':'0';" +
      "const r=await fetch('/api/customers?q='+q+'&unread='+unread);" +
      "const j=await r.json();" +
      "const tb=$('#customersTbody');" +
      "tb.innerHTML='';" +
      "if(!j.ok){ tb.innerHTML='<tr><td colspan=6 class=muted>Error</td></tr>'; return; }" +
      "if(!j.rows.length){ tb.innerHTML='<tr><td colspan=6 class=muted>No customers</td></tr>'; return; }" +
      "for(const c of j.rows){ " +
        "const name = c.name ? c.name : ('Customer ' + c.wa_id);" +
        "const open = Number(c.open_tickets||0);" +
        "const tickets = Number(c.tickets||0);" +
        "const last = fmt(c.last_time);" +
        "const msg = (c.last_message||'');" +
        "tb.insertAdjacentHTML('beforeend', " +
          "`<tr>`+" +
          "`<td><a href='/ui/customer/${encodeURIComponent(c.wa_id)}'>${c.wa_id}</a></td>`+" +
          "`<td>${name}</td>`+" +
          "`<td><span class='badge ${open>0?'green':'gray'}'>${open}</span></td>`+" +
          "`<td><span class='badge gray'>${tickets}</span></td>`+" +
          "`<td>${last}</td>`+" +
          "`<td>${msg}</td>`+" +
          "`</tr>`" +
        ");" +
      "}" +
    "}" +

    "async function loadTickets(){ " +
      "const q=encodeURIComponent($('#qTickets').value||'');" +
      "const dept=encodeURIComponent($('#deptTickets').value||'');" +
      "const status=encodeURIComponent($('#statusTickets').value||'');" +
      "const unread=$('#unreadTickets').checked?'1':'0';" +
      "const r=await fetch('/api/tickets?q='+q+'&dept='+dept+'&status='+status+'&unread='+unread);" +
      "const j=await r.json();" +
      "const tb=$('#ticketsTbody');" +
      "tb.innerHTML='';" +
      "if(!j.ok){ tb.innerHTML='<tr><td colspan=8 class=muted>Error</td></tr>'; return; }" +
      "if(!j.rows.length){ tb.innerHTML='<tr><td colspan=8 class=muted>No tickets yet</td></tr>'; return; }" +
      "for(const t of j.rows){ " +
        "const name = t.name ? t.name : ('Customer ' + t.wa_id);" +
        "const last = fmt(t.last_message_at);" +
        "const msg = (t.last_message||'');" +
        "tb.insertAdjacentHTML('beforeend', " +
          "`<tr>`+" +
          "`<td><a href='/ui/ticket/${t.id}'>#${t.id}</a></td>`+" +
          "`<td><a href='/ui/customer/${encodeURIComponent(t.wa_id)}'>${t.wa_id}</a></td>`+" +
          "`<td>${name}</td>`+" +
          "`<td><span class='badge gray'>${t.dept}</span></td>`+" +
          "`<td><span class='badge ${t.status==='open'?'green':'gray'}'>${t.status}</span></td>`+" +
          "`<td><span class='badge gray'>${t.unread_count}</span></td>`+" +
          "`<td>${last}</td>`+" +
          "`<td>${msg}</td>`+" +
          "`</tr>`" +
        ");" +
      "}" +
    "}" +

    "$('#applyCustomers').onclick=loadCustomers;" +
    "$('#clearCustomers').onclick=()=>{ $('#qCustomers').value=''; $('#unreadCustomers').checked=false; loadCustomers(); };" +
    "$('#applyTickets').onclick=loadTickets;" +
    "$('#clearTickets').onclick=()=>{ $('#qTickets').value=''; $('#deptTickets').value=''; $('#statusTickets').value=''; $('#unreadTickets').checked=false; loadTickets(); };" +

    "loadCustomers(); loadTickets();" +

    "const es=new EventSource('/sse');" +
    "es.addEventListener('customers', ()=>{ if($('#panelCustomers').style.display!=='none') loadCustomers(); });" +
    "es.addEventListener('tickets', ()=>{ if($('#panelTickets').style.display!=='none') loadTickets(); });" +
    "</script>";

  return layout("Customers", user, body, "");
}

function uiCustomerPage(user, wa_id) {
  const body =
    "<div class='tabs'>" +
    "<a class='tab' href='/ui'>Back</a>" +
    "<a class='tab active' href='/ui/customer/" + esc(wa_id) + "'>Customer</a>" +
    "</div>" +
    "<div class='grid'>" +
      "<div class='card'>" +
        "<div class='hd'>Customer Profile</div>" +
        "<div class='bd'>" +
          "<div class='small'>wa_id</div><div style='font-weight:900;margin-bottom:10px'>" + esc(wa_id) + "</div>" +
          "<div class='small'>Name</div><input id='name' placeholder='e.g. John / Dealer_CA' style='width:100%;min-width:0'/>" +
          "<div style='height:10px'></div>" +
          "<div class='small'>Notes</div><textarea id='notes' placeholder='VIP / issue history / preferences'></textarea>" +
          "<div style='display:flex;gap:10px;margin-top:12px'>" +
            "<button class='pill primary' id='save'>Save</button>" +
            "<a class='pill' href='/ui'>Back</a>" +
          "</div>" +
          "<div id='msg' class='small' style='margin-top:10px'></div>" +
        "</div>" +
      "</div>" +
      "<div class='card'>" +
        "<div class='hd'>Tickets</div>" +
        "<div class='bd'><div id='tickets' class='muted'>Loading...</div></div>" +
      "</div>" +
    "</div>" +
    "<script>" +
    "const $=s=>document.querySelector(s);" +
    "async function load(){ " +
      "let r=await fetch('/api/customer/" + encodeURIComponent(wa_id) + "'); let j=await r.json();" +
      "if(j.ok){ $('#name').value=j.customer.name||''; $('#notes').value=j.customer.notes||''; }" +
      "r=await fetch('/api/tickets?q=' + encodeURIComponent('" + wa_id + "')); j=await r.json();" +
      "if(j.ok){ " +
        "const rows=j.rows.filter(x=>x.wa_id==='" + wa_id + "');" +
        "if(!rows.length){ $('#tickets').innerHTML='No tickets yet'; return; }" +
        "let html='<table><thead><tr><th>Ticket</th><th>Dept</th><th>Status</th><th>Unread</th><th>Last</th></tr></thead><tbody>';"+
        "for(const t of rows){ html+=`<tr><td><a href="/ui/ticket/${t.id}">#${t.id}</a></td><td>${t.dept}</td><td>${t.status}</td><td>${t.unread_count}</td><td>${new Date(t.last_message_at||Date.now()).toLocaleString()}</td></tr>`; }"+
        "html+='</tbody></table>'; $('#tickets').innerHTML=html;" +
      "} }" +
    "}" +
    "$('#save').onclick=async()=>{ " +
      "const body={name:$('#name').value, notes:$('#notes').value};" +
      "const r=await fetch('/api/customer/" + encodeURIComponent(wa_id) + "',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});" +
      "const j=await r.json(); $('#msg').textContent = j.ok ? 'Saved' : ('Error: '+(j.error||''));" +
    "};" +
    "load();" +
    "</script>";

  return layout("Customer", user, body, "");
}

function uiTicketPage(user, ticketId) {
  const body =
    "<div class='tabs'>" +
    "<a class='tab' href='/ui'>Back</a>" +
    "<a class='tab active' href='/ui/ticket/" + esc(ticketId) + "'>Ticket #" + esc(ticketId) + "</a>" +
    "</div>" +
    "<div class='grid'>" +
      "<div class='card'>" +
        "<div class='hd'>Messages</div>" +
        "<div class='msgs' id='msgs'><div class='muted'>Loading...</div></div>" +
        "<div class='sendRow'>" +
          "<input id='text' placeholder='Type a reply...'/>" +
          "<button class='pill primary' id='send'>Send</button>" +
        "</div>" +
      "</div>" +
      "<div class='card'>" +
        "<div class='hd'>Actions</div>" +
        "<div class='bd'>" +
          "<div class='small'>Status</div>" +
          "<div style='display:flex;gap:10px;flex-wrap:wrap;margin:10px 0'>" +
            "<button class='pill' data-status='open'>Open</button>" +
            "<button class='pill' data-status='pending'>Pending</button>" +
            "<button class='pill' data-status='closed'>Closed</button>" +
          "</div>" +
          "<div id='info' class='small'></div>" +
          "<div style='height:8px'></div>" +
          "<div class='small'>Tip: Incoming messages auto-push via realtime stream.</div>" +
        "</div>" +
      "</div>" +
    "</div>" +
    "<script>" +
    "const $=s=>document.querySelector(s);" +
    "const ticketId=" + JSON.stringify(Number(ticketId)) + ";" +
    "function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}" +
    "function render(rows){ const el=$('#msgs'); el.innerHTML=''; if(!rows.length){ el.innerHTML='<div class=muted>No messages</div>'; return; }" +
      "for(const m of rows){ const dir=m.direction==='outgoing'?'out':'in'; const txt=escHtml(m.text||m.caption||''); const ts=new Date(m.created_at).toLocaleString();" +
        "el.insertAdjacentHTML('beforeend', `<div class=" + '"msg ${dir}"' + "><div class=" + '"bubble"' + "><div>${txt}</div><div class=" + '"meta"' + ">${ts}</div></div></div>`);" +
      "}" +
      "el.scrollTop=el.scrollHeight;" +
    "}" +
    "async function load(){ const r=await fetch('/api/ticket/'+ticketId+'/messages'); const j=await r.json(); if(j.ok){ render(j.rows); } else { $('#msgs').innerHTML='<div class=muted>Error loading</div>'; } }" +
    "$('#send').onclick=async()=>{ const text=$('#text').value.trim(); if(!text) return; $('#text').value=''; const r=await fetch('/api/ticket/'+ticketId+'/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})}); const j=await r.json(); if(!j.ok){ $('#info').textContent='Send failed: '+(j.error||''); } else { $('#info').textContent='Sent'; } setTimeout(()=>$('#info').textContent='',1200); load(); };" +
    "document.querySelectorAll('[data-status]').forEach(btn=>{ btn.onclick=async()=>{ const st=btn.getAttribute('data-status'); const r=await fetch('/api/ticket/'+ticketId+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:st})}); const j=await r.json(); $('#info').textContent=j.ok?'Updated':'Error'; setTimeout(()=>$('#info').textContent='',1200); }; });" +
    "load();" +
    "const es=new EventSource('/sse'); es.addEventListener('message', (ev)=>{ try{ const j=JSON.parse(ev.data).payload; if(j.ticket_id===ticketId){ load(); } }catch(e){} });" +
    "</script>";

  return layout("Ticket", user, body, "");
}

// UI routes
app.get("/ui", requireAuth, (req, res) => {
  try {
    const user = getUserFromSession(req);
    res.status(200).send(uiIndexPage(user));
  } catch (e) {
    console.error("❌ /ui error:", e);
    res.status(500).send("UI error");
  }
});

app.get("/ui/customer/:wa_id", requireAuth, (req, res) => {
  const user = getUserFromSession(req);
  res.status(200).send(uiCustomerPage(user, String(req.params.wa_id)));
});

app.get("/ui/ticket/:id", requireAuth, (req, res) => {
  const user = getUserFromSession(req);
  res.status(200).send(uiTicketPage(user, String(req.params.id)));
});

// ------------------------ Health ------------------------
app.get("/", (req, res) => res.redirect("/ui"));
app.get("/health", async (req, res) => {
  try { await dbPing(); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false }); }
});

// ------------------------ Boot ------------------------
(async () => {
  try {
    await dbPing();
    console.log("✅ DB connected");
    await ensureTables();
    console.log("✅ tables ready");
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
  console.log("UI_USER SET:", !!process.env.UI_USER ? "YES" : "NO");
  console.log("UI_PASS SET:", !!process.env.UI_PASS ? "YES" : "NO");
  console.log("SESSION_SECRET SET:", !!process.env.SESSION_SECRET ? "YES" : "NO");
  console.log("OPENAI_API_KEY SET:", !!process.env.OPENAI_API_KEY ? "YES" : "NO");
  console.log("WA_TOKEN SET:", !!process.env.WA_TOKEN ? "YES" : "NO");
  console.log("PHONE_NUMBER_ID SET:", !!process.env.PHONE_NUMBER_ID ? "YES" : "NO");
  console.log("DATABASE_URL SET:", !!process.env.DATABASE_URL ? "true" : "false");
  console.log("MEDIA DIR:", MEDIA_DIR);
  console.log("UPLOADS DIR:", UPLOADS_DIR);
  console.log("VERSION MARKER: V4_5_STABLE_2026-03-04");
  console.log("STRICT ISOLATION:", STRICT_AGENT_VIEW ? "ON" : "OFF");
  console.log("=================================");

  app.listen(PORT, () => console.log("✅ Server running on port " + PORT));
})();
