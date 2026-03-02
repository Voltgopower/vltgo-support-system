/**
 * WhatsApp Webhook Server (FAST A - DB COMPAT v1)
 *
 * ✅ DB schema COMPAT (existing table):
 *   messages(
 *     id BIGSERIAL PRIMARY KEY,
 *     conversation_id TEXT NOT NULL,
 *     direction TEXT NOT NULL,
 *     msg_type TEXT,
 *     text TEXT,
 *     media_url TEXT,
 *     wa_message_id TEXT,
 *     created_at TIMESTAMPTZ DEFAULT NOW()
 *   )
 *
 * Features:
 * - Webhook receive (incoming) -> save to Postgres
 * - Download incoming media to disk (image/video/document/audio) and save local media_url
 * - Send message: text OR upload local file (image/video/document/audio)
 * - UI: light theme + chat bubbles
 * - Filters: unread only / last 24h / tag filter
 * - Unread tracking via logs/state/<wa_id>.json
 * - Version probe: /__version
 * - Media routes:
 *    - /media/original/:wa_id/:filename   (original file + strong cache)
 *    - /media/thumb/:wa_id/:filename      (webp thumbnail if sharp installed; else fallback original) + strong cache
 *
 * .env required:
 *   VERIFY_TOKEN=voltgo_webhook_verify
 *   WA_TOKEN=xxxxxxxxxxxxxxxx
 *   PHONE_NUMBER_ID=xxxxxxxxxxxxxxxx
 *   UI_USER=xxxxx
 *   UI_PASS=xxxxx
 *   DATABASE_URL=postgresql://...
 * optional:
 *   PORT=8080
 *   APP_SECRET=xxxxx
 */

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { Pool } = require("pg");

// -------- Optional sharp (do NOT crash if missing) --------
let sharp = null;
try {
  sharp = require("sharp");
  console.log("✅ sharp enabled: thumbnails will be generated");
} catch (e) {
  console.log("⚠️ sharp not installed: /media/thumb will fallback to original");
}

const app = express();

// ========= RAW BODY SAVER (signature verify) =========
function rawBodySaver(req, res, buf) {
  req.rawBody = buf;
}

app.use(express.json({ verify: rawBodySaver }));
app.use(express.urlencoded({ extended: false }));

// ========= ENV =========
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 8080;
const APP_SECRET = process.env.APP_SECRET || null;

const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const UI_USER = process.env.UI_USER;
const UI_PASS = process.env.UI_PASS;

const DATABASE_URL = process.env.DATABASE_URL;

if (!VERIFY_TOKEN) {
  console.error("Missing .env variable: VERIFY_TOKEN");
  process.exit(1);
}
if (!WA_TOKEN) console.warn("⚠️ WA_TOKEN missing: webhook media download/send will fail");
if (!PHONE_NUMBER_ID) console.warn("⚠️ PHONE_NUMBER_ID missing: send will fail");
if (!DATABASE_URL) console.warn("⚠️ DATABASE_URL missing: DB write/read will fail");

// ========= Basic Auth (protect UI + send + APIs + media) =========
function unauthorized(res) {
  res.set("WWW-Authenticate", 'Basic realm="WhatsApp CS"');
  return res.status(401).send("Authentication required");
}

function basicAuth(req, res, next) {
  // allow webhook endpoints without auth (Meta calls)
  if (req.path === "/webhook") return next();

  // allow health/version probes without auth
  if (req.path === "/" || req.path === "/__version") return next();

  // protect these routes
  const protectedPrefixes = ["/ui", "/customers", "/send", "/media", "/__db_init"];
  if (!protectedPrefixes.some((p) => req.path.startsWith(p))) return next();

  if (!UI_USER || !UI_PASS) return res.status(500).send("UI auth not configured on server");

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

// ========= Local dirs (state/media/uploads) =========
const baseLogsDir = path.join(__dirname, "logs");
const stateDir = path.join(baseLogsDir, "state");
const mediaDir = path.join(baseLogsDir, "media");
const thumbsDir = path.join(mediaDir, "__thumbs");
const uploadsDir = path.join(baseLogsDir, "uploads");

ensureDir(baseLogsDir);
ensureDir(stateDir);
ensureDir(mediaDir);
ensureDir(thumbsDir);
ensureDir(uploadsDir);

// ========= Multer upload =========
const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
      const safe = safeFileName(file.originalname || "file");
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      cb(null, `${ts}__${safe}`);
    },
  }),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
  },
});

// ========= Helpers =========
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeFileName(name) {
  return String(name || "")
    .replace(/[\\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isoToMs(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : 0;
}
function withinLastHours(iso, hours) {
  const ms = isoToMs(iso);
  if (!ms) return false;
  return Date.now() - ms <= hours * 3600 * 1000;
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return escapeHtml(iso);
  return d.toLocaleString();
}
function setNoCache(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
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

// ========= Optional: verify Meta webhook signature =========
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

// ========= Unread State =========
// logs/state/<wa_id>.json => { last_seen_incoming_at: "ISO" }
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

// ========= Media helpers =========
function extFromMime(mime) {
  const m = (mime || "").toLowerCase();
  if (m.includes("image/jpeg")) return "jpg";
  if (m.includes("image/png")) return "png";
  if (m.includes("image/webp")) return "webp";
  if (m.includes("image/gif")) return "gif";
  if (m.includes("video/mp4")) return "mp4";
  if (m.includes("video/quicktime")) return "mov";
  if (m.includes("audio/ogg")) return "ogg";
  if (m.includes("audio/mpeg")) return "mp3";
  if (m.includes("audio/mp4")) return "m4a";
  if (m.includes("application/pdf")) return "pdf";
  return "bin";
}
function guessMimeByExt(filename) {
  const f = (filename || "").toLowerCase();
  if (f.endsWith(".jpg") || f.endsWith(".jpeg")) return "image/jpeg";
  if (f.endsWith(".png")) return "image/png";
  if (f.endsWith(".webp")) return "image/webp";
  if (f.endsWith(".gif")) return "image/gif";
  if (f.endsWith(".mp4")) return "video/mp4";
  if (f.endsWith(".mov")) return "video/quicktime";
  if (f.endsWith(".mp3")) return "audio/mpeg";
  if (f.endsWith(".ogg")) return "audio/ogg";
  if (f.endsWith(".m4a")) return "audio/mp4";
  if (f.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}
function classifyMediaType(mimeType) {
  const m = (mimeType || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "document";
}

function mediaLocalDirForWaId(waId) {
  const dir = path.join(mediaDir, safeFileName(waId || "unknown"));
  ensureDir(dir);
  return dir;
}
function mediaOriginalPath(waId, filename) {
  return `/media/original/${encodeURIComponent(waId)}/${encodeURIComponent(filename)}`;
}
function mediaThumbPath(waId, filename) {
  return `/media/thumb/${encodeURIComponent(waId)}/${encodeURIComponent(filename)}`;
}

async function ensureImageThumb(srcPath, thumbPath) {
  if (!sharp) return false;
  if (fs.existsSync(thumbPath)) return true;
  ensureDir(path.dirname(thumbPath));

  await sharp(srcPath)
    .resize({ width: 520, height: 520, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(thumbPath);

  return true;
}

// ========= WhatsApp Graph helpers =========
async function downloadIncomingMedia(waId, mediaId) {
  if (!WA_TOKEN) throw new Error("Missing WA_TOKEN");
  if (!mediaId) return null;

  // 1) media meta
  const metaResp = await fetch(`https://graph.facebook.com/v25.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  });
  const meta = await metaResp.json();
  if (!metaResp.ok) throw new Error(`Media meta error: ${JSON.stringify(meta)}`);

  const url = meta?.url;
  const mime = meta?.mime_type || null;
  if (!url) throw new Error("Media meta missing url");

  // 2) download binary
  const binResp = await fetch(url, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
  if (!binResp.ok) {
    const t = await binResp.text().catch(() => "");
    throw new Error(`Media download error: ${binResp.status} ${t}`);
  }
  const buf = Buffer.from(await binResp.arrayBuffer());

  const ext = extFromMime(mime);
  const fileName = `${safeFileName(mediaId)}.${ext}`;
  const dir = mediaLocalDirForWaId(waId);
  const abs = path.join(dir, fileName);

  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf);

  return {
    filename: fileName,
    abs,
    mime_type: mime,
    original_url: mediaOriginalPath(waId, fileName),
    thumb_url: mediaThumbPath(waId, fileName),
  };
}

async function uploadMediaToWhatsApp(filePath, mimeType) {
  if (!WA_TOKEN) throw new Error("Missing WA_TOKEN");
  if (!PHONE_NUMBER_ID) throw new Error("Missing PHONE_NUMBER_ID");

  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath);

  const file = new File([buf], name, { type: mimeType || "application/octet-stream" });
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", file);

  const r = await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
    body: form,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Upload media failed: ${JSON.stringify(data)}`);
  return data?.id || null;
}

// ========= DB =========
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Railway 常见需要
    })
  : null;

async function dbInit() {
  if (!pool) return;
  await pool.query(`SELECT 1;`);

  // ✅ create table with the EXISTING schema (conversation_id/msg_type/media_url/wa_message_id)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      msg_type TEXT,
      text TEXT,
      media_url TEXT,
      wa_message_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function insertMessage({
  conversation_id,
  direction,
  msg_type,
  text,
  media_url,
  wa_message_id,
  created_at_iso,
}) {
  if (!pool) return;
  await pool.query(
    `
    INSERT INTO messages (conversation_id, direction, msg_type, text, media_url, wa_message_id, created_at)
    VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, NOW()))
    `,
    [
      conversation_id,
      direction,
      msg_type || null,
      text || null,
      media_url || null,
      wa_message_id || null,
      created_at_iso || null,
    ]
  );
}

// ========= Health + Version =========
app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/__version", (req, res) => {
  return res.json({
    ok: true,
    ts: new Date().toISOString(),
    marker: "FAST_A_DB_COMPAT_2026-03-02_v1",
    node: process.version,
    has_DATABASE_URL: !!DATABASE_URL,
    sharp: !!sharp,
  });
});

// Optional DB init endpoint (protected by basic auth)
app.get("/__db_init", async (req, res) => {
  try {
    await dbInit();
    return res.json({ ok: true, ts: new Date().toISOString(), marker: "DB_INIT_OK" });
  } catch (e) {
    console.error("❌ __db_init error:", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

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

  (async () => {
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

      const waId = contact?.wa_id || msg.from || null;
      const type = msg.type || "unknown";

      let text = null;
      let caption = null;
      let mediaId = null;
      let mimeType = null;

      if (type === "text") {
        text = msg.text?.body ?? null;
      } else if (type === "image") {
        mediaId = msg.image?.id || null;
        mimeType = msg.image?.mime_type || null;
        caption = msg.image?.caption || null;
      } else if (type === "video") {
        mediaId = msg.video?.id || null;
        mimeType = msg.video?.mime_type || null;
        caption = msg.video?.caption || null;
      } else if (type === "document") {
        mediaId = msg.document?.id || null;
        mimeType = msg.document?.mime_type || null;
        caption = msg.document?.caption || msg.document?.filename || null;
      } else if (type === "audio") {
        mediaId = msg.audio?.id || null;
        mimeType = msg.audio?.mime_type || null;
      }

      let media_url = null;

      // download media to disk if exists
      if (mediaId && waId) {
        try {
          const dl = await downloadIncomingMedia(waId, mediaId);
          media_url = dl?.original_url || null;
          mimeType = dl?.mime_type || mimeType;
        } catch (e) {
          console.error("❌ download media failed:", e?.message || e);
        }
      }

      const displayText = text || caption || null;

      // ✅ DB insert using EXISTING schema fields
      await insertMessage({
        conversation_id: waId || msg.from,
        direction: "incoming",
        msg_type: type,
        text: displayText,
        media_url,
        wa_message_id: msg.id || null,
        created_at_iso: new Date().toISOString(),
      });

      console.log("📝 Saved incoming:", type, waId, mediaId ? `media=${mediaId}` : "");
    } catch (err) {
      console.error("❌ Webhook error:", err);
    }
  })();
});

// ========= Media routes (strong cache) =========

// Original file: /media/original/:wa_id/:filename
app.get("/media/original/:wa_id/:filename", (req, res) => {
  try {
    const waId = safeFileName(req.params.wa_id);
    const filename = safeFileName(req.params.filename);

    const abs = path.join(mediaDir, waId, filename);
    const root = path.join(mediaDir, waId);

    if (!abs.startsWith(root)) return res.status(400).send("Bad path");
    if (!fs.existsSync(abs)) return res.status(404).send("Not found");

    res.setHeader("Content-Type", guessMimeByExt(filename));
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.sendFile(abs);
  } catch (e) {
    console.error("❌ /media/original error:", e);
    return res.status(500).send("Internal error");
  }
});

// Thumb (webp): /media/thumb/:wa_id/:filename
// - if sharp missing or non-image => fallback to original (302)
app.get("/media/thumb/:wa_id/:filename", async (req, res) => {
  try {
    const waId = safeFileName(req.params.wa_id);
    const filename = safeFileName(req.params.filename);

    const src = path.join(mediaDir, waId, filename);
    const root = path.join(mediaDir, waId);
    if (!src.startsWith(root)) return res.status(400).send("Bad path");
    if (!fs.existsSync(src)) return res.status(404).send("Not found");

    const mime = guessMimeByExt(filename);
    if (!mime.startsWith("image/") || !sharp) {
      // fallback to original
      return res.redirect(302, mediaOriginalPath(waId, filename));
    }

    const stem = filename.replace(/\.[^.]+$/, "");
    const thumbAbs = path.join(thumbsDir, waId, `${stem}.webp`);
    await ensureImageThumb(src, thumbAbs);

    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.sendFile(thumbAbs);
  } catch (e) {
    console.error("❌ /media/thumb error:", e);
    return res.status(500).send("thumb error");
  }
});

// ========= Customers API (DB-based) =========
async function getConversationIds() {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT conversation_id, MAX(created_at) AS last_time
    FROM messages
    GROUP BY conversation_id
    ORDER BY last_time DESC
    LIMIT 500;
  `);
  return r.rows || [];
}

async function getLastNMessages(conversation_id, n = 400) {
  if (!pool) return [];
  const r = await pool.query(
    `
    SELECT id, conversation_id, direction, msg_type, text, media_url, wa_message_id, created_at
    FROM messages
    WHERE conversation_id = $1
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [conversation_id, n]
  );
  // return newest->oldest; UI needs oldest->newest so reverse when rendering
  return r.rows || [];
}

app.get("/customers", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "DATABASE_URL not set" });

    const convs = await getConversationIds();
    const out = [];

    for (const c of convs) {
      const waId = c.conversation_id;
      const rows = await getLastNMessages(waId, 400);
      if (!rows.length) continue;

      const newest = rows[0];

      // tag counts in last 400
      const tagCounts = {};
      let lastIncomingAt = null;

      const st = readState(waId);
      const lastSeenMs = isoToMs(st.last_seen_incoming_at);
      let unreadCount = 0;

      for (const r of rows) {
        const tags = getTags(r.text || "");
        for (const t of tags) tagCounts[t] = (tagCounts[t] || 0) + 1;

        if (r.direction === "incoming") {
          if (!lastIncomingAt || isoToMs(r.created_at) > isoToMs(lastIncomingAt)) lastIncomingAt = r.created_at;
          const ms = isoToMs(r.created_at);
          if (ms && ms > lastSeenMs) unreadCount++;
        }
      }

      out.push({
        wa_id: waId,
        profile_name: null,
        last_time: newest.created_at,
        last_text: newest.text || null,
        last_type: newest.msg_type || null,
        last_direction: newest.direction || null,
        tags: tagCounts,
        unread_count: unreadCount,
        last_incoming_at: lastIncomingAt,
      });
    }

    res.json({ count: out.length, customers: out });
  } catch (e) {
    console.error("❌ /customers error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/customers/:wa_id/messages", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "DATABASE_URL not set" });

    const waId = safeFileName(req.params.wa_id);
    const limit = Math.min(parseInt(req.query.limit || "300", 10) || 300, 3000);

    const rows = await pool.query(
      `
      SELECT id, conversation_id, direction, msg_type, text, media_url, wa_message_id, created_at
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT $2
      `,
      [waId, limit]
    );

    res.json({ wa_id: waId, count: rows.rows.length, messages: rows.rows });
  } catch (e) {
    console.error("❌ /customers/:wa_id/messages error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

// ========= UI: Customers list (filters: q, unread, recent24, tag) =========
app.get("/ui", async (req, res) => {
  try {
    setNoCache(res);
    if (!pool) return res.status(500).send("DATABASE_URL not set");

    const q = (req.query.q || "").toString().trim().toLowerCase();
    const unreadOnly = (req.query.unread || "").toString() === "1";
    const recent24 = (req.query.recent24 || "").toString() === "1";
    const tag = (req.query.tag || "").toString().trim().toLowerCase();

    const convs = await getConversationIds();

    const customers = [];
    const allTagsSet = new Set();

    for (const c of convs) {
      const waId = c.conversation_id;

      const rows = await getLastNMessages(waId, 400);
      if (!rows.length) continue;

      const newest = rows[0];

      // compute tags and unread
      const tagCounts = {};
      const st = readState(waId);
      const lastSeenMs = isoToMs(st.last_seen_incoming_at);

      let unreadCount = 0;
      let lastIncomingAt = null;

      for (const r of rows) {
        const tags = getTags(r.text || "");
        for (const t of tags) {
          tagCounts[t] = (tagCounts[t] || 0) + 1;
          allTagsSet.add(t);
        }
        if (r.direction === "incoming") {
          const ms = isoToMs(r.created_at);
          if (ms && ms > lastSeenMs) unreadCount++;
          if (!lastIncomingAt || ms > isoToMs(lastIncomingAt)) lastIncomingAt = r.created_at;
        }
      }

      const summary = {
        wa_id: waId,
        profile_name: null,
        last_time: newest.created_at,
        last_text: newest.text || null,
        last_type: newest.msg_type || null,
        last_direction: newest.direction || null,
        tags: tagCounts,
        unread_count: unreadCount,
        last_incoming_at: lastIncomingAt,
      };

      // filters
      if (unreadOnly && (summary.unread_count || 0) <= 0) continue;
      if (recent24 && !withinLastHours(summary.last_time, 24)) continue;

      const hay = `${summary.wa_id} ${summary.last_text || ""}`.toLowerCase();
      if (q && !hay.includes(q)) continue;

      if (tag) {
        const hasTag = (summary.tags && summary.tags[tag]) || 0;
        if (!hasTag) continue;
      }

      customers.push(summary);
    }

    const allTags = Array.from(allTagsSet).sort();
    const tagOptions = [
      `<option value="">All</option>`,
      ...allTags.map((t) => `<option value="${escapeHtml(t)}" ${t === tag ? "selected" : ""}>${escapeHtml(t)}</option>`),
    ].join("");

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

        const preview = escapeHtml(c.last_text || "");

        return `
          <tr>
            <td class="mono">
              <a href="/ui/customer/${encodeURIComponent(c.wa_id)}">${escapeHtml(c.wa_id)}</a>
            </td>
            <td>${escapeHtml(c.profile_name || "")}</td>
            <td>${escapeHtml(fmtTime(c.last_time))}</td>
            <td>${unreadBadge} ${lastDir} <span class="preview">${preview}</span></td>
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

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp CS - Customers</title>
  <style>
    :root{
      --bg:#f6f7fb; --card:#ffffff; --text:#111827; --muted:#6b7280; --line:#e5e7eb;
      --blue:#2563eb; --blue2:#1d4ed8; --green:#10b981; --red:#ef4444;
      --chip:#f3f4f6;
    }
    *{box-sizing:border-box;}
    body{margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:var(--bg); color:var(--text);}
    a{color:var(--blue); text-decoration:none;}
    a:hover{text-decoration:underline;}
    .wrap{max-width:1200px; margin:0 auto; padding:18px;}
    .top{display:flex; gap:14px; flex-wrap:wrap; align-items:flex-end; justify-content:space-between;}
    h2{margin:0; font-size:18px;}
    .muted{color:var(--muted); font-size:13px;}
    .controls{display:flex; gap:10px; flex-wrap:wrap; align-items:center;}
    input, select{padding:10px 12px; border:1px solid var(--line); border-radius:12px; background:var(--card); min-width:240px;}
    button{padding:10px 14px; border:1px solid var(--line); border-radius:12px; background:var(--blue); color:white; cursor:pointer;}
    button:hover{background:var(--blue2);}
    .chip{display:inline-flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--line); border-radius:999px; background:var(--chip);}
    .chip.on{border-color:#c7d2fe; background:#eef2ff;}
    .chip b{font-size:12px; color:#111827;}
    .card{margin-top:14px; background:var(--card); border:1px solid var(--line); border-radius:16px; overflow:hidden; box-shadow:0 10px 30px rgba(17,24,39,.06);}
    table{width:100%; border-collapse:collapse;}
    th, td{padding:12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top;}
    th{background:#f9fafb; color:var(--muted); font-size:12px; letter-spacing:.02em; position:sticky; top:0; z-index:1;}
    tr:hover td{background:#f9fafb;}
    .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;}
    .tag{display:inline-block; padding:2px 8px; border:1px solid var(--line); border-radius:999px; margin-right:6px; font-size:12px; color:var(--muted); background:#fafafa;}
    .pill{display:inline-block; padding:2px 8px; border:1px solid var(--line); border-radius:999px; font-size:12px; margin-right:6px; background:#fafafa; color:var(--muted);}
    .pill.incoming{border-color:#bfdbfe; background:#eff6ff; color:#1d4ed8;}
    .pill.outgoing{border-color:#bbf7d0; background:#ecfdf5; color:#047857;}
    .badge{display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:22px; padding:0 6px; border-radius:999px; background:var(--red); color:#fff; font-size:12px; margin-right:8px;}
    .badge.ghost{background:#f3f4f6; color:var(--muted); border:1px solid var(--line);}
    .preview{color:#111827;}
    .footerNote{margin-top:10px; color:var(--muted); font-size:12px;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h2>Customers</h2>
        <div class="muted">DB compat • Table: messages(conversation_id,msg_type,media_url,wa_message_id,created_at)</div>
      </div>

      <div class="controls">
        <a href="/send" class="chip"><b>Send Page</b></a>
        <a href="${unreadLink}" class="chip ${unreadOnly ? "on" : ""}"><b>Unread Only</b></a>
        <a href="${recentLink}" class="chip ${recent24 ? "on" : ""}"><b>Last 24h</b></a>
      </div>

      <form method="get" action="/ui" class="controls">
        <input name="q" placeholder="Search conversation_id / last text" value="${escapeHtml(q)}" />
        <select name="tag">${tagOptions}</select>
        <input type="hidden" name="unread" value="${unreadOnly ? "1" : ""}" />
        <input type="hidden" name="recent24" value="${recent24 ? "1" : ""}" />
        <button type="submit">Apply</button>
        <a class="muted" href="${clearLink}">Clear</a>
      </form>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>conversation_id</th>
            <th>Name</th>
            <th>Last time</th>
            <th>Last message</th>
            <th>Tags (last 400)</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || `<tr><td colspan="5" class="muted">No customers found.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="footerNote">Version: FAST_A_DB_COMPAT_2026-03-02_v1</div>
  </div>
</body>
</html>`;

    res.status(200).send(html);
  } catch (e) {
    console.error("❌ /ui error:", e);
    res.status(500).send("Internal error");
  }
});

// ========= UI: Customer chat =========
app.get("/ui/customer/:wa_id", async (req, res) => {
  try {
    setNoCache(res);
    if (!pool) return res.status(500).send("DATABASE_URL not set");

    const waId = safeFileName(req.params.wa_id);

    const q = (req.query.q || "").toString().trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit || "800", 10) || 800, 5000);
    const recent24 = (req.query.recent24 || "").toString() === "1";
    const tag = (req.query.tag || "").toString().trim().toLowerCase();
    const unreadOnly = (req.query.unread || "").toString() === "1";

    const r = await pool.query(
      `
      SELECT id, conversation_id, direction, msg_type, text, media_url, wa_message_id, created_at
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT $2
      `,
      [waId, limit]
    );

    const newestToOldest = r.rows || [];
    const rows = newestToOldest.slice().reverse(); // oldest -> newest for reading

    // tag dropdown
    const tagsSet = new Set();
    for (const row of newestToOldest) {
      const tags = getTags(row.text || "");
      for (const t of tags) tagsSet.add(t);
    }
    const allTags = Array.from(tagsSet).sort();

    // unread state BEFORE marking read
    const st = readState(waId);
    const lastSeenMs = isoToMs(st.last_seen_incoming_at);

    // filter
    const filtered = rows.filter((row) => {
      const txt = (row.text || "").toString();
      const tagsStr = getTags(txt).join(",");
      const hay = `${txt} ${tagsStr}`.toLowerCase();

      if (q && !hay.includes(q)) return false;
      if (recent24 && !withinLastHours(row.created_at, 24)) return false;

      if (tag) {
        const has = getTags(txt).map((x) => String(x).toLowerCase()).includes(tag);
        if (!has) return false;
      }

      if (unreadOnly) {
        if (row.direction !== "incoming") return false;
        const ms = isoToMs(row.created_at);
        if (!ms || ms <= lastSeenMs) return false;
      }

      return true;
    });

    // mark as read when opening page (latest incoming)
    let latestIncoming = null;
    for (const row of newestToOldest) {
      if (row.direction === "incoming" && row.created_at) {
        latestIncoming = row.created_at;
        break; // because newestToOldest
      }
    }
    if (latestIncoming && isoToMs(latestIncoming) > lastSeenMs) {
      writeState(waId, { last_seen_incoming_at: new Date(latestIncoming).toISOString() });
    }

    const sentFlag = (req.query.sent || "").toString();
    const errMsg = (req.query.err || "").toString();
    const notice = errMsg
      ? `<div class="alert err">❌ ${escapeHtml(errMsg)}</div>`
      : sentFlag
      ? `<div class="alert ok">✅ Sent</div>`
      : "";

    function renderMsgContent(row) {
      const type = row.msg_type || "";
      const text = row.text || "";
      const originalUrl = row.media_url || null;
      const thumbUrl = originalUrl ? mediaThumbPath(waId, path.basename(originalUrl)) : null; // only works if media_url is our /media/original/... path

      if (type === "text" || !originalUrl) {
        return `<div class="text">${escapeHtml(text || (type ? `[${type}]` : ""))}</div>`;
      }

      // Prefer thumb for images
      if (type === "image") {
        const imgSrc = thumbUrl || originalUrl;
        return `
          ${text ? `<div class="text">${escapeHtml(text)}</div>` : ""}
          <div class="media">
            <a href="${originalUrl}" target="_blank" rel="noreferrer">
              <img src="${imgSrc}" alt="image" />
            </a>
            <div class="mediaActions">
              <a href="${originalUrl}" target="_blank" rel="noreferrer">Open / Download</a>
            </div>
          </div>
        `;
      }

      if (type === "video") {
        return `
          ${text ? `<div class="text">${escapeHtml(text)}</div>` : ""}
          <div class="media">
            <video controls src="${originalUrl}" style="max-width:100%; border-radius:12px;"></video>
            <div class="mediaActions"><a href="${originalUrl}" target="_blank" rel="noreferrer">Open / Download</a></div>
          </div>
        `;
      }

      if (type === "audio") {
        return `
          ${text ? `<div class="text">${escapeHtml(text)}</div>` : ""}
          <div class="media">
            <audio controls src="${originalUrl}" style="width:100%;"></audio>
            <div class="mediaActions"><a href="${originalUrl}" target="_blank" rel="noreferrer">Open / Download</a></div>
          </div>
        `;
      }

      // document/others
      return `
        ${text ? `<div class="text">${escapeHtml(text)}</div>` : ""}
        <div class="media">
          <div class="fileBox">
            <div class="fileMeta">
              <div><b>${escapeHtml(type || "document")}</b></div>
              <div class="mutedSmall mono">${escapeHtml(originalUrl)}</div>
            </div>
            <a class="btnLink" href="${originalUrl}" target="_blank" rel="noreferrer">Download</a>
          </div>
        </div>
      `;
    }

    const bubbles = filtered
      .map((row) => {
        const isOut = row.direction === "outgoing";
        const time = fmtTime(row.created_at);

        const tags = getTags(row.text || "").map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");

        let unreadMark = "";
        if (row.direction === "incoming") {
          const ms = isoToMs(row.created_at);
          if (ms && ms > lastSeenMs) unreadMark = `<span class="dot" title="unread"></span>`;
        }

        return `
          <div class="row ${isOut ? "right" : "left"}">
            <div class="bubble ${isOut ? "out" : "in"}">
              <div class="meta">
                ${unreadMark}
                <span class="time">${escapeHtml(time)}</span>
                <span class="type">${escapeHtml(row.msg_type || "")}</span>
                ${tags ? `<span class="tags">${tags}</span>` : ""}
              </div>
              ${renderMsgContent(row)}
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

    const toggleUnreadLink = buildQueryLink(`/ui/customer/${encodeURIComponent(waId)}`, currentParams, { unread: unreadOnly ? "" : "1" });
    const toggleRecentLink = buildQueryLink(`/ui/customer/${encodeURIComponent(waId)}`, currentParams, { recent24: recent24 ? "" : "1" });
    const clearLink = `/ui/customer/${encodeURIComponent(waId)}`;

    const tagOptions = [
      `<option value="">All</option>`,
      ...allTags.map((t) => `<option value="${escapeHtml(t)}" ${t === tag ? "selected" : ""}>${escapeHtml(t)}</option>`),
    ].join("");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp CS - ${escapeHtml(waId)}</title>
  <style>
    :root{
      --bg:#f6f7fb; --card:#ffffff; --text:#111827; --muted:#6b7280; --line:#e5e7eb;
      --in:#ffffff; --out:#ecfdf5;
      --blue:#2563eb; --blue2:#1d4ed8; --red:#ef4444;
      --chip:#f3f4f6;
    }
    *{box-sizing:border-box;}
    body{margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:var(--bg); color:var(--text);}
    a{color:var(--blue); text-decoration:none;}
    a:hover{text-decoration:underline;}
    .wrap{max-width:1100px; margin:0 auto; padding:18px;}
    .top{display:flex; gap:14px; flex-wrap:wrap; align-items:flex-end; justify-content:space-between;}
    h2{margin:0; font-size:18px;}
    .muted{color:var(--muted); font-size:13px;}
    .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;}
    .controls{display:flex; gap:10px; flex-wrap:wrap; align-items:center;}
    input, select, textarea{padding:10px 12px; border:1px solid var(--line); border-radius:12px; background:var(--card); color:var(--text);}
    textarea{width:100%; resize:vertical;}
    button{padding:10px 14px; border:1px solid var(--line); border-radius:12px; background:var(--blue); color:white; cursor:pointer;}
    button:hover{background:var(--blue2);}
    .chip{display:inline-flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--line); border-radius:999px; background:var(--chip);}
    .chip.on{border-color:#c7d2fe; background:#eef2ff;}
    .chip b{font-size:12px; color:#111827;}

    .card{margin-top:14px; background:var(--card); border:1px solid var(--line); border-radius:16px; box-shadow:0 10px 30px rgba(17,24,39,.06);}
    .chat{padding:14px;}
    .row{display:flex; margin:10px 0;}
    .row.left{justify-content:flex-start;}
    .row.right{justify-content:flex-end;}
    .bubble{max-width:78%; padding:10px 12px; border-radius:16px; border:1px solid var(--line); box-shadow:0 10px 30px rgba(17,24,39,.08);}
    .bubble.in{background:var(--in); border-top-left-radius:8px;}
    .bubble.out{background:var(--out); border-top-right-radius:8px; border-color:#bbf7d0;}
    .meta{display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:6px; color:var(--muted); font-size:12px;}
    .type{padding:2px 8px; border:1px solid var(--line); border-radius:999px; background:#fafafa;}
    .tag{display:inline-block; padding:2px 8px; border:1px solid var(--line); border-radius:999px; font-size:12px; color:var(--muted); background:#fafafa; margin-right:6px;}
    .text{white-space:pre-wrap; line-height:1.4; font-size:14px;}
    .dot{width:8px; height:8px; border-radius:999px; background:var(--red); display:inline-block;}
    .media{margin-top:8px;}
    .media img{max-width:100%; border-radius:12px; border:1px solid var(--line);}
    .mediaActions{margin-top:6px; font-size:13px;}
    .mutedSmall{color:var(--muted); font-size:12px; margin-top:4px;}
    .fileBox{display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border:1px solid var(--line); border-radius:12px; background:#fafafa;}
    .btnLink{display:inline-flex; padding:8px 10px; border-radius:10px; border:1px solid var(--line); background:#fff;}
    .alert{margin-top:12px; padding:10px 12px; border-radius:12px; border:1px solid var(--line);}
    .alert.ok{border-color:#bbf7d0; background:#ecfdf5; color:#065f46;}
    .alert.err{border-color:#fecaca; background:#fef2f2; color:#991b1b;}

    .reply{margin-top:14px; padding:14px;}
    .replyTop{display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:10px;}
    .row2{display:flex; gap:10px; flex-wrap:wrap; align-items:center;}
    .fileHint{font-size:12px; color:var(--muted);}
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

    <div class="card">
      <div class="chat">
        ${bubbles || `<div class="muted">No messages found.</div>`}
      </div>

      <div class="reply">
        <div class="replyTop">
          <div class="muted"><b>Reply</b> (text + optional file upload)</div>
          <div class="muted">After send: redirect back here</div>
        </div>

        <form method="post" action="/send" enctype="multipart/form-data">
          <input type="hidden" name="to" value="${escapeHtml(waId)}" />
          <input type="hidden" name="redirect" value="/ui/customer/${encodeURIComponent(waId)}" />

          <textarea name="text" rows="3" placeholder="Type reply... (caption for media)"></textarea>

          <div class="row2" style="margin-top:10px;">
            <input type="file" name="file" />
            <div class="fileHint">Support: image/video/audio/document • Max 25MB (can adjust)</div>
          </div>

          <div class="row2" style="margin-top:10px;">
            <button type="submit">Send</button>
            <a href="/send" class="chip"><b>Open Send Page</b></a>
          </div>
        </form>
      </div>
    </div>

    <div class="muted" style="margin-top:10px;">Version: FAST_A_DB_COMPAT_2026-03-02_v1</div>
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
  setNoCache(res);
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Send</title>
<style>
  body{font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:#f6f7fb; margin:0; padding:18px;}
  .card{max-width:900px; margin:0 auto; background:#fff; border:1px solid #e5e7eb; border-radius:16px; padding:16px; box-shadow:0 10px 30px rgba(17,24,39,.06);}
  input, textarea{width:100%; padding:10px 12px; border:1px solid #e5e7eb; border-radius:12px; margin-top:6px;}
  button{padding:10px 14px; border:1px solid #e5e7eb; border-radius:12px; background:#2563eb; color:#fff; cursor:pointer;}
  button:hover{background:#1d4ed8;}
  .muted{color:#6b7280; font-size:13px;}
</style>
</head><body>
  <div class="card">
    <h2 style="margin:0 0 8px 0;">Send WhatsApp Message</h2>
    <div class="muted">Text + optional file upload</div>
    <form method="post" action="/send" enctype="multipart/form-data" style="margin-top:12px;">
      <label class="muted">To (conversation_id / wa_id)</label>
      <input name="to" required />
      <label class="muted" style="display:block; margin-top:10px;">Text (or caption for media)</label>
      <textarea name="text" rows="4" placeholder="Type message..."></textarea>
      <label class="muted" style="display:block; margin-top:10px;">File (optional)</label>
      <input type="file" name="file" />
      <div style="margin-top:12px;">
        <button type="submit">Send</button>
      </div>
    </form>
    <p style="margin-top:12px;"><a href="/ui">Back to UI</a></p>
  </div>
</body></html>`);
});

// ===== SEND API (outgoing + DB log) =====
app.post("/send", upload.single("file"), async (req, res) => {
  try {
    if (!pool) return res.status(500).send("DATABASE_URL not set");

    const to = (req.body.to || "").trim();
    const text = (req.body.text || "").trim();
    const redirectTo = (req.body.redirect || "").trim();

    if (!to) {
      if (redirectTo) {
        const u = new URL(redirectTo, "http://localhost");
        u.searchParams.set("err", "Missing to");
        return res.redirect(u.pathname + u.search);
      }
      return res.status(400).send("Missing 'to'");
    }

    if (!WA_TOKEN) throw new Error("Missing WA_TOKEN");
    if (!PHONE_NUMBER_ID) throw new Error("Missing PHONE_NUMBER_ID");

    const hasFile = !!req.file;
    if (!hasFile && !text) {
      if (redirectTo) {
        const u = new URL(redirectTo, "http://localhost");
        u.searchParams.set("err", "Missing text (or upload a file)");
        return res.redirect(u.pathname + u.search);
      }
      return res.status(400).send("Missing 'text' (or upload a file)");
    }

    let payload = null;
    let outType = "text";
    let uploadedMediaId = null;
    let mimeType = null;
    let localOutFile = null;
    let localMediaUrl = null;

    if (!hasFile) {
      payload = {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      };
      outType = "text";
    } else {
      localOutFile = req.file.path;
      mimeType = req.file.mimetype || guessMimeByExt(req.file.originalname);
      const category = classifyMediaType(mimeType);

      uploadedMediaId = await uploadMediaToWhatsApp(localOutFile, mimeType);
      if (!uploadedMediaId) throw new Error("Upload ok but missing media id");

      outType = category;

      if (category === "image") {
        payload = { messaging_product: "whatsapp", to, type: "image", image: { id: uploadedMediaId, ...(text ? { caption: text } : {}) } };
      } else if (category === "video") {
        payload = { messaging_product: "whatsapp", to, type: "video", video: { id: uploadedMediaId, ...(text ? { caption: text } : {}) } };
      } else if (category === "audio") {
        payload = { messaging_product: "whatsapp", to, type: "audio", audio: { id: uploadedMediaId } };
      } else {
        payload = {
          messaging_product: "whatsapp",
          to,
          type: "document",
          document: {
            id: uploadedMediaId,
            ...(req.file.originalname ? { filename: req.file.originalname } : {}),
            ...(text ? { caption: text } : {}),
          },
        };
      }

      // Copy to logs/media/<to>/outgoing__xxx.ext so UI can preview later
      const waDir = mediaLocalDirForWaId(to);
      const ext = extFromMime(mimeType);
      const base = safeFileName(path.basename(localOutFile));
      const outName = `outgoing__${base}.${ext}`;
      const dest = path.join(waDir, outName);
      fs.copyFileSync(localOutFile, dest);
      localMediaUrl = mediaOriginalPath(to, outName);
    }

    // send
    const url = `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();

    if (!r.ok) {
      console.error("❌ Send error:", data);
      throw new Error("Send failed");
    }

    // DB insert outgoing
    const msgId = data?.messages?.[0]?.id || null;
    await insertMessage({
      conversation_id: to,
      direction: "outgoing",
      msg_type: outType,
      text: hasFile ? (text || null) : text,
      media_url: hasFile ? localMediaUrl : null,
      wa_message_id: msgId,
      created_at_iso: new Date().toISOString(),
    });

    // redirect back
    if (redirectTo) {
      const u = new URL(redirectTo, "http://localhost");
      u.searchParams.set("sent", "1");
      return res.redirect(u.pathname + u.search);
    }

    return res.send(`✅ Sent successfully\n\n${JSON.stringify(data, null, 2)}`);
  } catch (e) {
    console.error("❌ /send exception:", e);
    const redirectTo = (req.body.redirect || "").trim();
    if (redirectTo) {
      const u = new URL(redirectTo, "http://localhost");
      u.searchParams.set("err", e?.message || "Internal error");
      return res.redirect(u.pathname + u.search);
    }
    return res.status(500).send(e?.message || "Internal error");
  }
});

// ========= Start =========
(async () => {
  try {
    if (pool) {
      await dbInit();
      console.log("✅ DB connected");
      console.log("✅ messages table ready (DB COMPAT schema)");
    }
  } catch (e) {
    console.error("❌ DB init failed:", e?.message || e);
  }

  app.listen(PORT, () => {
    console.log("=================================");
    console.log("🚀 Server running");
    console.log("NODE VERSION:", process.version);
    console.log("PORT:", PORT);
    console.log("VERIFY_TOKEN SET:", VERIFY_TOKEN ? "YES" : "NO");
    console.log("APP_SECRET SET:", APP_SECRET ? "YES" : "NO");
    console.log("UI_USER SET:", UI_USER ? "YES" : "NO");
    console.log("UI_PASS SET:", UI_PASS ? "YES" : "NO");
    console.log("WA_TOKEN SET:", WA_TOKEN ? "YES" : "NO");
    console.log("PHONE_NUMBER_ID SET:", PHONE_NUMBER_ID ? "YES" : "NO");
    console.log("DATABASE_URL SET:", !!DATABASE_URL);
    console.log("MEDIA DIR:", mediaDir);
    console.log("THUMBS DIR:", thumbsDir);
    console.log("UPLOADS DIR:", uploadsDir);
    console.log("VERSION MARKER: FAST_A_DB_COMPAT_2026-03-02_v1");
    console.log("SHARP ENABLED:", !!sharp);
    console.log("=================================");
    console.log(`✅ Server running on port ${PORT}`);
  });
})();