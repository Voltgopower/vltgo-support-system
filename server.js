/**
 * WhatsApp Webhook Server
 * - Webhook receive + log jsonl (incoming)
 * - Send message + log jsonl (outgoing)
 * - UI: customers list + chat bubble view
 * - Filters: unread only / last 24h / tag filter
 * - Unread tracking via logs/state/<wa_id>.json (no jsonl rewrites)
 
 * .env required:
 *   VERIFY_TOKEN=voltgo_webhook_verify
 *   WA_TOKEN=xxxxxxxxxxxxxxxx
 *   PHONE_NUMBER_ID=xxxxxxxxxxxxxxxx
 *   UI_USER=xxxxx
 *   UI_PASS=xxxxx
 * optional:
 *   PORT=8080
 *   APP_SECRET=xxxxx
 */


require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const app = express();

/** Save raw body for signature verification */
function rawBodySaver(req, res, buf) {
  req.rawBody = buf;
}

// IMPORTANT: JSON must be before routes (keep raw body for signature check)
app.use(express.json({ verify: rawBodySaver }));
// IMPORTANT: enable form POST
app.use(express.urlencoded({ extended: false }));

// ========= ENV =========
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 8080;
const APP_SECRET = process.env.APP_SECRET || null; // optional

if (!VERIFY_TOKEN) {
  console.error("Missing .env variable: VERIFY_TOKEN");
  process.exit(1);
}

// ========= Basic Auth (protect UI + send + APIs) =========
const UI_USER = process.env.UI_USER;
const UI_PASS = process.env.UI_PASS;

function unauthorized(res) {
  res.set("WWW-Authenticate", 'Basic realm="WhatsApp CS"');
  return res.status(401).send("Authentication required");
}

function basicAuth(req, res, next) {
  // allow webhook endpoints without auth (Meta calls)
  if (req.path === "/webhook") return next();

  // protect these routes
  const protectedPrefixes = ["/ui", "/customers", "/send"];
  if (!protectedPrefixes.some((p) => req.path.startsWith(p))) return next();

  if (!UI_USER || !UI_PASS) {
    return res.status(500).send("UI auth not configured on server");
  }

  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return unauthorized(res);

  const b64 = header.slice(6);
  const decoded = Buffer.from(b64, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return unauthorized(res);

  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  if (user !== UI_USER || pass !== UI_PASS) return unauthorized(res);
  return next();
}
app.use(basicAuth);
// ========= Postgres =========
const DATABASE_URL = process.env.DATABASE_URL || null;

const pgPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

// ========= DB init route =========
app.get("/__db_init", async (req, res) => {
  try {
    if (!pgPool) return res.status(500).send("Missing DATABASE_URL");

    const sql = `
CREATE TABLE IF NOT EXISTS wa_customers (
  wa_id TEXT PRIMARY KEY,
  profile_name TEXT,
  last_seen_incoming_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wa_messages (
  id BIGSERIAL PRIMARY KEY,
  wa_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
  type TEXT NOT NULL,
  text TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  message_id TEXT,
  from_wa TEXT,
  to_wa TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),

  media_id TEXT,
  mime_type TEXT,
  sha256 TEXT,
  caption TEXT,
  filename TEXT,

  raw JSONB
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_wa_id_ts ON wa_messages (wa_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_tags ON wa_messages USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_wa_messages_ts ON wa_messages (ts DESC);
`;
    await pgPool.query(sql);

    return res.status(200).send("✅ DB init OK");
  } catch (e) {
    console.error("❌ DB init error:", e);
    return res.status(500).send("DB init failed: " + e.message);
  }
});
// ========= Log directories =========
const baseLogsDir = path.join(__dirname, "logs");
const byUserDir = path.join(baseLogsDir, "by-user");
const byDateDir = path.join(baseLogsDir, "by-date");
const stateDir = path.join(baseLogsDir, "state");

ensureDir(byUserDir);
ensureDir(byDateDir);
ensureDir(stateDir);

// ========= Helpers =========
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendJsonl(filePath, obj) {
  const line = JSON.stringify(obj) + "\n";
  fs.appendFile(filePath, line, (err) => {
    if (err) console.error("❌ log write failed:", err.message);
  });
}

function todayFileName(prefix = "messages") {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${prefix}-${yyyy}-${mm}-${dd}.jsonl`;
}

function safeFileName(name) {
  return String(name || "")
    .replace(/[\\\/:*?"<>|]/g, "_")
    .trim();
}

/** Optional: verify Meta webhook signature */
function isValidSignature(req) {
  if (!APP_SECRET) return true;
  const sig = req.get("x-hub-signature-256");
  if (!sig || !sig.startsWith("sha256=")) return false;

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", APP_SECRET)
      .update(req.rawBody || Buffer.from(""))
      .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ========= Tags =========
function getTags(text) {
  const t = (text || "").toLowerCase();
  const tags = [];

  if (/(track|tracking|deliver|delivery|ups|fedex|dhl|usps|shipment|物流|派送|签收|运单|快递)/i.test(t)) {
    tags.push("logistics");
  }
  if (/(warranty|broken|issue|problem|fault|defect|return|replace|refund|not work|doesn't work|坏|故障|问题|退货|换货|退款)/i.test(t)) {
    tags.push("after_sales");
  }
  if (/(price|quote|quotation|invoice|pay|payment|discount|availability|lead time|报价|价格|发票|付款|折扣|有货|交期)/i.test(t)) {
    tags.push("pre_sales");
  }

  return tags;
}

// ========= State (Unread tracking) =========
// state file: logs/state/<wa_id>.json
// { last_seen_incoming_at: "ISO" }
function statePath(waId) {
  return path.join(stateDir, `${safeFileName(waId)}.json`);
}

function readState(waId) {
  try {
    const p = statePath(waId);
    if (!fs.existsSync(p)) return { last_seen_incoming_at: null };
    const raw = fs.readFileSync(p, "utf8");
    const obj = JSON.parse(raw);
    return { last_seen_incoming_at: obj?.last_seen_incoming_at || null };
  } catch (_) {
    return { last_seen_incoming_at: null };
  }
}

function writeState(waId, patch) {
  try {
    const cur = readState(waId);
    const next = { ...cur, ...patch };
    fs.writeFileSync(statePath(waId), JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    console.error("❌ writeState error:", e);
  }
}

function isoToMs(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : 0;
}

function withinLastHours(iso, hours) {
  const ms = isoToMs(iso);
  if (!ms) return false;
  const now = Date.now();
  return now - ms <= hours * 3600 * 1000;
}

// ========= Read log =========
function readJsonlLastN(filePath, n = 300) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  const tail = lines.slice(Math.max(0, lines.length - n));
  const out = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line));
    } catch (_) {}
  }
  return out;
}

function summarizeCustomer(filePath, waId) {
  const rows = readJsonlLastN(filePath, 300);
  if (rows.length === 0) return null;

  // find last message
  const last = rows[rows.length - 1];

  // tag counts (last 300)
  const tagCounts = {};
  for (const r of rows) {
    for (const tag of r.tags || []) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  }

  // unread counts based on state
  const st = readState(waId);
  const lastSeenMs = isoToMs(st.last_seen_incoming_at);
  let unreadCount = 0;
  let lastIncomingAt = null;

  for (const r of rows) {
    if (r.direction === "incoming") {
      const t = r.received_at || null;
      if (t) lastIncomingAt = t; // will end as last incoming
      const ms = isoToMs(t);
      if (ms && ms > lastSeenMs) unreadCount++;
    }
  }

  return {
    wa_id: waId,
    profile_name: last.profile_name || null,
    last_time: last.received_at || last.sent_at || null,
    last_text: last.text || null,
    last_type: last.type || null,
    last_direction: last.direction || null,
    tags: tagCounts,
    unread_count: unreadCount,
    last_incoming_at: lastIncomingAt,
  };
}

// ========= UI helpers =========
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return escapeHtml(iso);
  return d.toLocaleString();
}

function buildQueryLink(basePath, current, patch) {
  const u = new URL("http://localhost" + basePath);
  const params = new URLSearchParams(current || {});
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null || v === undefined || v === "") params.delete(k);
    else params.set(k, String(v));
  }
  u.search = params.toString();
  return u.pathname + (u.search ? `?${u.search}` : "");
}
app.get("/__version", (req, res) => {
  res.status(200).json({
    ok: true,
    ts: new Date().toISOString(),
    marker: "LIGHT_UI_2026-02-27_v1",
    node: process.version,
  });
});
// ========= Health =========
app.get("/", (req, res) => res.status(200).send("OK"));

// ========= Webhook verify =========
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  console.warn("❌ Webhook verify failed");
  return res.sendStatus(403);
});

// ========= Webhook receive (incoming) =========
app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  try {
    if (!isValidSignature(req)) {
      console.warn("❌ Invalid webhook signature");
      return;
    }

    const body = req.body;
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const field = change?.field;

    if (field !== "messages" || !value?.messages?.length) return;

    const msg = value.messages[0];
    const contact = value.contacts?.[0];
    const textBody = msg.text?.body ?? null;

    const record = {
      direction: "incoming",
      received_at: new Date().toISOString(),

      waba_id: entry?.id,
      phone_number_id: value?.metadata?.phone_number_id,
      display_phone_number: value?.metadata?.display_phone_number,

      from: msg.from,
      to: value?.metadata?.display_phone_number || null,

      wa_id: contact?.wa_id || msg.from || null,
      profile_name: contact?.profile?.name || null,

      message_id: msg.id,
      timestamp: msg.timestamp,
      type: msg.type,

      text: textBody,
      tags: getTags(textBody ?? ""),
      raw: msg,
    };

    appendJsonl(path.join(byDateDir, todayFileName("messages")), record);

    const customerKey = safeFileName(record.wa_id || record.from);
    appendJsonl(path.join(byUserDir, `${customerKey}.jsonl`), record);

    console.log(
      "📝 saved incoming:",
      record.type,
      record.from,
      record.text || "",
      record.tags?.length ? `tags=${record.tags.join(",")}` : ""
    );
  } catch (e) {
    console.error("❌ webhook handler error:", e);
  }
});

// ========= Customer APIs =========
app.get("/customers", (req, res) => {
  try {
    ensureDir(byUserDir);
    const files = fs.readdirSync(byUserDir).filter((f) => f.endsWith(".jsonl"));

    const customers = [];
    for (const f of files) {
      const waId = f.replace(/\.jsonl$/i, "");
      const filePath = path.join(byUserDir, f);
      const summary = summarizeCustomer(filePath, waId);
      if (summary) customers.push(summary);
    }

    customers.sort((a, b) => isoToMs(b.last_time) - isoToMs(a.last_time));

    res.json({ count: customers.length, customers });
  } catch (e) {
    console.error("❌ /customers error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/customers/:wa_id/messages", (req, res) => {
  try {
    const waId = safeFileName(req.params.wa_id);
    const limit = Math.min(parseInt(req.query.limit || "300", 10) || 300, 3000);
    const filePath = path.join(byUserDir, `${waId}.jsonl`);
    const rows = readJsonlLastN(filePath, limit);
    res.json({ wa_id: waId, count: rows.length, messages: rows });
  } catch (e) {
    console.error("❌ /customers/:wa_id/messages error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

// ========= UI: Customers list (filters: q, unread, recent24, tag) =========
app.get("/ui", (req, res) => {
  try {
    ensureDir(byUserDir);

    const q = (req.query.q || "").toString().trim().toLowerCase();
    const unreadOnly = (req.query.unread || "").toString() === "1";
    const recent24 = (req.query.recent24 || "").toString() === "1";
    const tag = (req.query.tag || "").toString().trim().toLowerCase();

    const files = fs.readdirSync(byUserDir).filter((f) => f.endsWith(".jsonl"));
    const customers = [];

    // build tag set
    const allTagsSet = new Set();

    for (const f of files) {
      const waId = f.replace(/\.jsonl$/i, "");
      const filePath = path.join(byUserDir, f);

      const summary = summarizeCustomer(filePath, waId);
      if (!summary) continue;

      // collect tags
      for (const k of Object.keys(summary.tags || {})) allTagsSet.add(k);

      // filters
      if (unreadOnly && (summary.unread_count || 0) <= 0) continue;
      if (recent24 && !withinLastHours(summary.last_time, 24)) continue;

      const hay = `${summary.wa_id} ${summary.profile_name || ""} ${summary.last_text || ""}`.toLowerCase();
      if (q && !hay.includes(q)) continue;

      if (tag) {
        const hasTag = (summary.tags && summary.tags[tag]) || 0;
        if (!hasTag) continue;
      }

      customers.push(summary);
    }

    customers.sort((a, b) => isoToMs(b.last_time) - isoToMs(a.last_time));

    const allTags = Array.from(allTagsSet).sort();

    const rowsHtml = customers
      .map((c) => {
        const unreadBadge =
          (c.unread_count || 0) > 0
            ? `<span class="badge">${c.unread_count}</span>`
            : `<span class="badge ghost">0</span>`;

        const lastDir = c.last_direction
          ? `<span class="pill ${escapeHtml(c.last_direction)}">${escapeHtml(c.last_direction)}</span>`
          : "";

        const tags = Object.entries(c.tags || {})
          .map(([k, v]) => `<span class="tag">${escapeHtml(k)}:${v}</span>`)
          .join(" ");

        return `
          <tr>
            <td class="mono">
              <a href="/ui/customer/${encodeURIComponent(c.wa_id)}">${escapeHtml(c.wa_id)}</a>
            </td>
            <td>${escapeHtml(c.profile_name || "")}</td>
            <td>${escapeHtml(fmtTime(c.last_time))}</td>
            <td>${unreadBadge} ${lastDir} ${escapeHtml(c.last_text || "")}</td>
            <td>${tags}</td>
          </tr>
        `;
      })
      .join("");

    const currentParams = {
      q: q || "",
      unread: unreadOnly ? "1" : "",
      recent24: recent24 ? "1" : "",
      tag: tag || "",
    };

    const unreadLink = buildQueryLink("/ui", currentParams, { unread: unreadOnly ? "" : "1" });
    const recentLink = buildQueryLink("/ui", currentParams, { recent24: recent24 ? "" : "1" });
    const clearLink = "/ui";

    const tagOptions = [
      `<option value="">All</option>`,
      ...allTags.map(
        (t) => `<option value="${escapeHtml(t)}" ${t === tag ? "selected" : ""}>${escapeHtml(t)}</option>`
      ),
    ].join("");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp CS - Customers</title>
  <style>
    :root {
      --bg: #f6f7fb;
      --card: #ffffff;
      --border: #e6e8f0;
      --text: #111827;
      --muted: #6b7280;
      --accent: #2563eb;
      --pill: #eef2ff;
      --incoming: #f1f5f9;
      --outgoing: #dbeafe;
      --danger: #ef4444;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    .wrap { max-width: 1200px; margin: 0 auto; padding: 18px; }

    .top { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
    h2 { margin:0; font-size:18px; font-weight: 650; }

    .muted { color: var(--muted); font-size: 13px; }

    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .controls { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }

    input, select {
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: #fff;
      color: var(--text);
      outline: none;
    }

    button {
      padding: 10px 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--accent);
      color: #fff;
      font-weight: 600;
      cursor:pointer;
    }
    button:hover { opacity: .92; }

    .chip {
      display:inline-flex;
      gap:8px;
      align-items:center;
      padding:8px 12px;
      border:1px solid var(--border);
      border-radius:999px;
      background:#fff;
      color: var(--text);
    }
    .chip b { font-size:12px; }
    .chip.on { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37, 99, 235, .12); }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 14px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow:hidden;
    }

    th, td {
      border-bottom: 1px solid var(--border);
      padding: 12px;
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }

    th {
      background: #fafafa;
      position: sticky;
      top: 0;
      z-index: 1;
      font-size: 12px;
      color: var(--muted);
      letter-spacing: .02em;
    }

    tr:hover td { background: #f9fafb; }

    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

    .tag {
      display:inline-block;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 12px;
      background: #eef2ff;
      color: #3730a3;
      margin-right: 6px;
    }

    .pill {
      display:inline-block;
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 999px;
      margin-right: 6px;
      background: var(--pill);
      color: #3730a3;
    }
    .pill.incoming { background: #e0f2fe; color: #075985; }
    .pill.outgoing { background: #dcfce7; color: #166534; }

    .badge {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-width:22px;
      height:22px;
      padding: 0 7px;
      border-radius:999px;
      background: var(--danger);
      color:#fff;
      font-size:12px;
      margin-right:8px;
      font-weight:700;
    }

    .badge.ghost {
      background: #f3f4f6;
      color: var(--muted);
      border: 1px solid var(--border);
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h2>Customers</h2>
        <div class="muted">Read-only UI. Logs: logs/by-user/*.jsonl &nbsp;|&nbsp; Unread state: logs/state/*.json</div>
      </div>

      <div class="controls">
        <a href="/send" class="chip"><b>Send Page</b></a>
        <a href="${unreadLink}" class="chip ${unreadOnly ? "on" : ""}"><b>Unread Only</b></a>
        <a href="${recentLink}" class="chip ${recent24 ? "on" : ""}"><b>Last 24h</b></a>
      </div>

      <form method="get" action="/ui" class="controls">
        <input name="q" placeholder="Search wa_id / name / last text" value="${escapeHtml(q)}" />
        <select name="tag">
          ${tagOptions}
        </select>
        <input type="hidden" name="unread" value="${unreadOnly ? "1" : ""}" />
        <input type="hidden" name="recent24" value="${recent24 ? "1" : ""}" />
        <button type="submit">Apply</button>
        <a class="muted" href="${clearLink}">Clear</a>
      </form>
    </div>

    <table>
      <thead>
        <tr>
          <th>wa_id</th>
          <th>Name</th>
          <th>Last time</th>
          <th>Last message</th>
          <th>Tags (last 300)</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml || `<tr><td colspan="5" class="muted">No customers found.</td></tr>`}
      </tbody>
    </table>
  </div>
</body>
</html>`;

    res.status(200).send(html);
  } catch (e) {
    console.error("❌ /ui error:", e);
    res.status(500).send("Internal error");
  }
});

// ========= UI: Customer chat (bubble + filters: q, recent24, tag, unreadOnly=only unread incoming) =========
app.get("/ui/customer/:wa_id", (req, res) => {
  try {
    const waId = safeFileName(req.params.wa_id);

    const q = (req.query.q || "").toString().trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit || "800", 10) || 800, 5000);

    const recent24 = (req.query.recent24 || "").toString() === "1";
    const tag = (req.query.tag || "").toString().trim().toLowerCase();
    const unreadOnly = (req.query.unread || "").toString() === "1";

    const filePath = path.join(byUserDir, `${waId}.jsonl`);
    const rows = readJsonlLastN(filePath, limit);

    // Build tags dropdown from existing data
    const tagsSet = new Set();
    for (const r of rows) {
      for (const t of r.tags || []) tagsSet.add(t);
    }
    const allTags = Array.from(tagsSet).sort();

    // unread computation
    const st = readState(waId);
    const lastSeenMs = isoToMs(st.last_seen_incoming_at);

    // Filter
    const filtered = rows.filter((r) => {
      const text = (r.text || "").toString();
      const tagsStr = (r.tags || []).join(",");
      const hay = `${text} ${tagsStr}`.toLowerCase();

      if (q && !hay.includes(q)) return false;

      const timeIso = r.received_at || r.sent_at || null;
      if (recent24 && !withinLastHours(timeIso, 24)) return false;

      if (tag) {
        const has = (r.tags || []).map((x) => String(x).toLowerCase()).includes(tag);
        if (!has) return false;
      }

      if (unreadOnly) {
        // show only unread incoming (received after last seen)
        if (r.direction !== "incoming") return false;
        const ms = isoToMs(r.received_at);
        if (!ms || ms <= lastSeenMs) return false;
      }

      return true;
    });

    // When opening this page, mark all incoming as read (update last_seen_incoming_at)
    let latestIncoming = null;
    for (const r of rows) {
      if (r.direction === "incoming" && r.received_at) latestIncoming = r.received_at;
    }
    if (latestIncoming) {
      if (isoToMs(latestIncoming) > lastSeenMs) {
        writeState(waId, { last_seen_incoming_at: latestIncoming });
      }
    }

    const sentFlag = (req.query.sent || "").toString();
    const errMsg = (req.query.err || "").toString();

    const notice = errMsg
      ? `<div class="alert err">❌ ${escapeHtml(errMsg)}</div>`
      : sentFlag
      ? `<div class="alert ok">✅ Sent</div>`
      : "";

    const bubbles = filtered
      .map((r) => {
        const dir = r.direction || "";
        const isOut = dir === "outgoing";
        const timeIso = r.received_at || r.sent_at || "";
        const time = fmtTime(timeIso);

        const tags = (r.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");

        // unread indicator for incoming
        let unreadMark = "";
        if (r.direction === "incoming") {
          const ms = isoToMs(r.received_at);
          if (ms && ms > lastSeenMs) unreadMark = `<span class="dot" title="unread"></span>`;
        }

        return `
          <div class="row ${isOut ? "right" : "left"}">
            <div class="bubble ${isOut ? "out" : "in"}">
              <div class="meta">
                ${unreadMark}
                <span class="time">${escapeHtml(time)}</span>
                <span class="type">${escapeHtml(r.type || "")}</span>
                ${tags ? `<span class="tags">${tags}</span>` : ""}
              </div>
              <div class="text">${escapeHtml(r.text || "")}</div>
            </div>
          </div>
        `;
      })
      .join("");

    const currentParams = {
      q: q || "",
      tag: tag || "",
      recent24: recent24 ? "1" : "",
      unread: unreadOnly ? "1" : "",
      limit: String(limit),
    };

    const toggleUnreadLink = buildQueryLink(`/ui/customer/${encodeURIComponent(waId)}`, currentParams, {
      unread: unreadOnly ? "" : "1",
    });
    const toggleRecentLink = buildQueryLink(`/ui/customer/${encodeURIComponent(waId)}`, currentParams, {
      recent24: recent24 ? "" : "1",
    });
    const clearLink = `/ui/customer/${encodeURIComponent(waId)}`;

    const tagOptions = [
      `<option value="">All</option>`,
      ...allTags.map(
        (t) => `<option value="${escapeHtml(t)}" ${t === tag ? "selected" : ""}>${escapeHtml(t)}</option>`
      ),
    ].join("");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp CS - ${escapeHtml(waId)}</title>
  <style>
    :root {
      --bg: #f6f7fb;
      --card: #ffffff;
      --border: #e6e8f0;
      --text: #111827;
      --muted: #6b7280;
      --accent: #2563eb;

      --incoming: #f1f5f9;
      --outgoing: #dbeafe;

      --okBg: #ecfdf5;
      --okBorder: #a7f3d0;
      --okText: #065f46;

      --errBg: #fef2f2;
      --errBorder: #fecaca;
      --errText: #991b1b;

      --danger: #ef4444;
    }

    body {
      margin:0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    .wrap { max-width: 1100px; margin: 0 auto; padding: 18px; }

    a { color: var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }

    .muted { color: var(--muted); font-size: 13px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

    .top { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap; }
    h2 { margin:0; font-size:18px; font-weight: 650; }

    .controls { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }

    input, select, textarea {
      padding: 10px 12px;
      border: 1px solid var(--border);
      background: #fff;
      color: var(--text);
      border-radius: 12px;
    }

    textarea { width:100%; box-sizing:border-box; resize: vertical; }

    button {
      padding: 10px 14px;
      border: 1px solid var(--border);
      background: var(--accent);
      color: #fff;
      border-radius: 12px;
      cursor:pointer;
      font-weight: 650;
    }
    button:hover { opacity: .92; }

    .chip {
      display:inline-flex; gap:8px; align-items:center;
      padding:8px 12px;
      border:1px solid var(--border);
      border-radius:999px;
      background:#fff;
      color: var(--text);
    }
    .chip.on { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
    .chip b { font-size:12px; }

    .chat {
      margin-top: 14px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
    }

    .row { display:flex; margin: 10px 0; }
    .row.left { justify-content:flex-start; }
    .row.right { justify-content:flex-end; }

    .bubble {
      max-width: 78%;
      padding: 10px 12px;
      border-radius: 14px;
      border: 1px solid var(--border);
      box-shadow: 0 10px 28px rgba(17,24,39,.08);
      background: #fff;
    }
    .bubble.in { background: var(--incoming); border-bottom-left-radius: 6px; }
    .bubble.out { background: var(--outgoing); border-bottom-right-radius: 6px; }

    .meta {
      display:flex; gap:10px; flex-wrap:wrap; align-items:center;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .type {
      padding:2px 8px;
      border:1px solid var(--border);
      border-radius:999px;
      background:#fff;
    }

    .tag {
      display:inline-block;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 12px;
      background: #eef2ff;
      color: #3730a3;
      margin-right: 6px;
    }

    .text { white-space: pre-wrap; line-height: 1.35; font-size: 14px; }

    .reply {
      margin-top: 14px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
    }
    .replyTop {
      display:flex; align-items:center; justify-content:space-between;
      gap:10px; flex-wrap:wrap; margin-bottom: 10px;
    }

    .alert { margin-top:12px; padding:10px 12px; border-radius:12px; border:1px solid var(--border); }
    .alert.ok { border-color: var(--okBorder); background: var(--okBg); color: var(--okText); }
    .alert.err { border-color: var(--errBorder); background: var(--errBg); color: var(--errText); }

    .dot { width:8px; height:8px; border-radius:999px; background: var(--danger); display:inline-block; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h2>Customer: <span class="mono">${escapeHtml(waId)}</span></h2>
        <div class="muted">
          <a href="/ui">← Back</a>
          &nbsp;|&nbsp; Showing ${filtered.length} messages
          ${q ? ` (q="${escapeHtml(q)}")` : ""}
          ${tag ? ` (tag="${escapeHtml(tag)}")` : ""}
          ${recent24 ? ` (last 24h)` : ""}
          ${unreadOnly ? ` (unread only)` : ""}
        </div>
      </div>

      <div class="controls">
        <a href="${toggleUnreadLink}" class="chip ${unreadOnly ? "on" : ""}"><b>Unread Only</b></a>
        <a href="${toggleRecentLink}" class="chip ${recent24 ? "on" : ""}"><b>Last 24h</b></a>
      </div>

      <form method="get" action="/ui/customer/${encodeURIComponent(waId)}" class="controls">
        <input name="q" placeholder="Search text / tags" value="${escapeHtml(q)}" />
        <select name="tag">${tagOptions}</select>
        <input name="limit" type="hidden" value="${escapeHtml(String(limit))}" />
        <input name="recent24" type="hidden" value="${recent24 ? "1" : ""}" />
        <input name="unread" type="hidden" value="${unreadOnly ? "1" : ""}" />
        <button type="submit">Apply</button>
        <a class="muted" href="${clearLink}">Clear</a>
      </form>
    </div>

    ${notice}

    <div class="chat">
      ${bubbles || `<div class="muted">No messages found.</div>`}
    </div>

    <div class="reply">
      <div class="replyTop">
        <div class="muted">Reply (will be logged as outgoing)</div>
        <div class="muted">After send: redirect back here</div>
      </div>
      <form method="post" action="/send">
        <input type="hidden" name="to" value="${escapeHtml(waId)}" />
        <input type="hidden" name="redirect" value="/ui/customer/${encodeURIComponent(waId)}" />
        <textarea name="text" rows="4" required placeholder="Type reply..."></textarea>
        <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">
          <button type="submit">Send</button>
          <a href="/send" class="chip"><b>Open Send Page</b></a>
        </div>
      </form>
    </div>
  </div>
</body>
</html>`;

    res.status(200).send(html);
  } catch (e) {
    console.error("❌ /ui/customer error:", e);
    res.status(500).send("Internal error");
  }
});

// ===== SEND PAGE =====
app.get("/send", (req, res) => {
  res.send(`
    <h2>Send WhatsApp Message</h2>
    <form method="post" action="/send">
      <div>To (wa_id):</div>
      <input name="to" required /><br/><br/>
      <div>Message:</div>
      <textarea name="text" rows="4" required></textarea><br/><br/>
      <button type="submit">Send</button>
    </form>
    <p><a href="/ui">Back to UI</a></p>
  `);
});

// ===== SEND API (outgoing + log) =====
app.post("/send", async (req, res) => {
  try {
    const to = (req.body.to || "").trim();
    const text = (req.body.text || "").trim();
    const redirectTo = (req.body.redirect || "").trim();

    if (!to || !text) {
      if (redirectTo) {
        const u = new URL(redirectTo, "http://localhost");
        u.searchParams.set("err", "Missing to/text");
        return res.redirect(u.pathname + u.search);
      }
      return res.status(400).send("Missing 'to' or 'text'");
    }

    const WA_TOKEN = process.env.WA_TOKEN;
    const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

    if (!WA_TOKEN) {
      if (redirectTo) {
        const u = new URL(redirectTo, "http://localhost");
        u.searchParams.set("err", "Missing WA_TOKEN");
        return res.redirect(u.pathname + u.search);
      }
      return res.status(500).send("Missing WA_TOKEN");
    }
    if (!PHONE_NUMBER_ID) {
      if (redirectTo) {
        const u = new URL(redirectTo, "http://localhost");
        u.searchParams.set("err", "Missing PHONE_NUMBER_ID");
        return res.redirect(u.pathname + u.search);
      }
      return res.status(500).send("Missing PHONE_NUMBER_ID");
    }

    const url = `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();

    if (!r.ok) {
      console.error("❌ Send error:", data);

      if (redirectTo) {
        const u = new URL(redirectTo, "http://localhost");
        u.searchParams.set("err", "Send failed");
        return res.redirect(u.pathname + u.search);
      }
      return res.status(500).send(`Error: ${JSON.stringify(data)}`);
    }

    // ✅ outgoing log
    try {
      const msgId = data?.messages?.[0]?.id || null;
      const record = {
        direction: "outgoing",
        sent_at: new Date().toISOString(),
        phone_number_id: PHONE_NUMBER_ID,
        to,
        from: null,
        wa_id: to,
        profile_name: null,
        message_id: msgId,
        type: "text",
        text,
        tags: getTags(text),
        api: data,
      };

      appendJsonl(path.join(byDateDir, todayFileName("messages")), record);

      const customerKey = safeFileName(to);
      appendJsonl(path.join(byUserDir, `${customerKey}.jsonl`), record);

      console.log("📝 saved outgoing:", to, text);
    } catch (logErr) {
      console.error("❌ outgoing log error:", logErr);
    }

    // ✅ redirect back
    if (redirectTo) {
      const u = new URL(redirectTo, "http://localhost");
      u.searchParams.set("sent", "1");
      return res.redirect(u.pathname + u.search);
    }

    return res.send(`✅ Sent successfully\n\n${JSON.stringify(data, null, 2)}`);
  } catch (e) {
    console.error("❌ /send exception:", e);
    return res.status(500).send("Internal error");
  }
});

// ========= Start =========
app.listen(PORT, () => {
  console.log("=====================================");
  console.log("🚀 WhatsApp Webhook Server Starting");
  console.log("NODE VERSION:", process.version);
  console.log("PORT:", PORT);
  console.log("VERIFY_TOKEN SET:", VERIFY_TOKEN ? "YES" : "NO");
  console.log("APP_SECRET SET:", APP_SECRET ? "YES" : "NO");
  console.log("UI_USER SET:", UI_USER ? "YES" : "NO");
  console.log("UI_PASS SET:", UI_PASS ? "YES" : "NO");
  console.log("WA_TOKEN SET:", process.env.WA_TOKEN ? "YES" : "NO");
  console.log("PHONE_NUMBER_ID SET:", process.env.PHONE_NUMBER_ID ? "YES" : "NO");
  console.log("=====================================");
  console.log(`✅ Server running on port ${PORT}`);
});