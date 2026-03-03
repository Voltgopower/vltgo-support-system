/**
 * WhatsApp Webhook Server (FAST A - DB + MEDIA + LIGHT UI) - 2026-03-02
 *
 * Key:
 * - Postgres is the source of truth (messages won't disappear after redeploy)
 * - wa_id stored as TEXT (no integer overflow)
 * - Optional sharp for thumbs (won't crash if missing)
 * - /__db_init endpoint creates/updates tables
 *
 * Required ENV:
 *   VERIFY_TOKEN=voltgo_webhook_verify
 *   WA_TOKEN=xxxxxxxxxxxxxxxx
 *   PHONE_NUMBER_ID=xxxxxxxxxxxxxxxx
 *   UI_USER=xxxxx
 *   UI_PASS=xxxxx
 *   DATABASE_URL=postgresql://...
 *
 * Optional:
 *   PORT=8080
 *   APP_SECRET=xxxxx  (Meta webhook signature verify)
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
  // eslint-disable-next-line global-require
  sharp = require("sharp");
  console.log("✅ sharp enabled: thumbnails will be generated");
} catch (e) {
  console.log("⚠️ sharp not installed: /media/thumb will fallback to original");
}

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
if (!WA_TOKEN) {
  console.error("Missing .env variable: WA_TOKEN");
  process.exit(1);
}
if (!PHONE_NUMBER_ID) {
  console.error("Missing .env variable: PHONE_NUMBER_ID");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("Missing .env variable: DATABASE_URL");
  process.exit(1);
}

// ========= Express =========
const app = express();

/** Save raw body for signature verification */
function rawBodySaver(req, res, buf) {
  req.rawBody = buf;
}

// IMPORTANT: JSON must be before routes (keep raw body for signature check)
app.use(express.json({ verify: rawBodySaver }));
app.use(express.urlencoded({ extended: false }));

// ========= Basic Auth =========
function unauthorized(res) {
  res.set("WWW-Authenticate", 'Basic realm="WhatsApp CS"');
  return res.status(401).send("Authentication required");
}

function basicAuth(req, res, next) {
  // allow Meta calls
  if (req.path === "/webhook") return next();

  // allow probes
  if (req.path === "/" || req.path === "/__version") return next();

  // protect these prefixes
  const protectedPrefixes = ["/ui", "/customers", "/send", "/media", "/__db_init"];
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

// ========= Local dirs (ephemeral on Railway without volume) =========
const baseDir = __dirname;
const logsDir = path.join(baseDir, "logs");
const mediaDir = path.join(logsDir, "media");
const thumbsDir = path.join(mediaDir, "__thumbs");
const uploadsDir = path.join(logsDir, "uploads");

ensureDir(logsDir);
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

// ========= DB =========
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("rlwy") || DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : undefined,
});

async function dbPing() {
  const r = await pool.query("SELECT 1 AS ok");
  return r.rows?.[0]?.ok === 1;
}

async function dbInit() {
  // Create tables (TEXT wa_id!)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id BIGSERIAL PRIMARY KEY,
      wa_id TEXT UNIQUE NOT NULL,
      profile_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_message_at TIMESTAMPTZ,
      last_seen_incoming_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      wa_id TEXT NOT NULL,
      direction TEXT NOT NULL,              -- incoming/outgoing
      msg_type TEXT,                        -- text/image/video/audio/document
      text TEXT,
      caption TEXT,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,

      wa_message_id TEXT,                   -- WhatsApp message id
      timestamp_wa TEXT,                    -- Meta timestamp string if provided

      media_id TEXT,
      mime_type TEXT,
      local_original_url TEXT,
      local_thumb_url TEXT,
      local_file_path TEXT,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_id);`);

  // lightweight "migration": add missing columns if old table exists with missing fields
  // (won't fail if already exists)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='wa_id') THEN
        ALTER TABLE messages ADD COLUMN wa_id TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='tags') THEN
        ALTER TABLE messages ADD COLUMN tags JSONB NOT NULL DEFAULT '[]'::jsonb;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='local_thumb_url') THEN
        ALTER TABLE messages ADD COLUMN local_thumb_url TEXT;
      END IF;
    END $$;
  `);
}

async function getOrCreateConversation(waId, profileName) {
  const wa_id = String(waId || "").trim();
  if (!wa_id) throw new Error("Missing wa_id");

  // Upsert conversation
  const r = await pool.query(
    `
    INSERT INTO conversations (wa_id, profile_name, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (wa_id)
    DO UPDATE SET
      profile_name = COALESCE(EXCLUDED.profile_name, conversations.profile_name),
      updated_at = NOW()
    RETURNING id, wa_id, profile_name, last_seen_incoming_at;
    `,
    [wa_id, profileName || null]
  );
  return r.rows[0];
}

async function insertMessage(row) {
  const {
    conversation_id,
    wa_id,
    direction,
    msg_type,
    text,
    caption,
    tags,
    wa_message_id,
    timestamp_wa,
    media_id,
    mime_type,
    local_original_url,
    local_thumb_url,
    local_file_path,
  } = row;

  await pool.query(
    `
    INSERT INTO messages
    (conversation_id, wa_id, direction, msg_type, text, caption, tags, wa_message_id, timestamp_wa, media_id, mime_type, local_original_url, local_thumb_url, local_file_path)
    VALUES
    ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
    `,
    [
      conversation_id,
      String(wa_id),
      direction,
      msg_type || null,
      text || null,
      caption || null,
      JSON.stringify(Array.isArray(tags) ? tags : []),
      wa_message_id || null,
      timestamp_wa || null,
      media_id || null,
      mime_type || null,
      local_original_url || null,
      local_thumb_url || null,
      local_file_path || null,
    ]
  );

  // maintain last_message_at
  await pool.query(
    `UPDATE conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [conversation_id]
  );
}

async function countUnread(conversationId) {
  const r = await pool.query(
    `
    SELECT COUNT(*)::int AS n
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = $1
      AND m.direction = 'incoming'
      AND (c.last_seen_incoming_at IS NULL OR m.created_at > c.last_seen_incoming_at)
    `,
    [conversationId]
  );
  return r.rows?.[0]?.n || 0;
}

async function markConversationSeen(waId) {
  await pool.query(
    `
    UPDATE conversations
    SET last_seen_incoming_at = NOW(), updated_at = NOW()
    WHERE wa_id = $1
    `,
    [String(waId)]
  );
}

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

function setNoCache(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

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

function isoToMs(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : 0;
}

function withinLastHours(iso, hours) {
  const ms = isoToMs(iso);
  if (!ms) return false;
  return Date.now() - ms <= hours * 3600 * 1000;
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

  if (/(track|tracking|deliver|delivery|ups|fedex|dhl|usps|shipment|物流|派送|签收|运单|快递)/i.test(t)) tags.push("logistics");
  if (/(warranty|broken|issue|problem|fault|defect|return|replace|refund|not work|doesn't work|坏|故障|问题|退货|换货|退款)/i.test(t)) tags.push("after_sales");
  if (/(price|quote|quotation|invoice|pay|payment|discount|availability|lead time|报价|价格|发票|付款|折扣|有货|交期)/i.test(t)) tags.push("pre_sales");

  return tags;
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

async function ensureImageThumb(srcPath, thumbAbs) {
  if (!sharp) return false;
  if (fs.existsSync(thumbAbs)) return true;
  ensureDir(path.dirname(thumbAbs));

  await sharp(srcPath)
    .resize({ width: 520, height: 520, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(thumbAbs);

  return true;
}

// download incoming media by media_id -> save to logs/media/<wa_id>/<media_id>.<ext>
async function downloadIncomingMedia(waId, mediaId) {
  if (!mediaId) return null;

  // 1) get media URL + mime
  const metaResp = await fetch(`https://graph.facebook.com/v25.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  });
  const meta = await metaResp.json();
  if (!metaResp.ok) throw new Error(`Media meta error: ${JSON.stringify(meta)}`);

  const url = meta?.url;
  const mime = meta?.mime_type || null;
  if (!url) throw new Error("Media meta missing url");

  // 2) download bytes
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

  // thumb
  let thumbUrl = null;
  if (sharp && (mime || "").toLowerCase().startsWith("image/")) {
    const stem = fileName.replace(/\.[^.]+$/, "");
    const thumbAbs = path.join(thumbsDir, safeFileName(waId), `${stem}.webp`);
    try {
      await ensureImageThumb(abs, thumbAbs);
      thumbUrl = mediaThumbPath(waId, fileName);
    } catch (e) {
      // fallback to original
      thumbUrl = null;
    }
  }

  return {
    media_id: mediaId,
    mime_type: mime,
    local_file: abs,
    local_original_url: mediaOriginalPath(waId, fileName),
    local_thumb_url: thumbUrl,
  };
}

// upload outgoing media file -> return media id
async function uploadMediaToWhatsApp(filePath, mimeType) {
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

// ========= Probes =========
app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/__version", async (req, res) => {
  let dbOk = false;
  try {
    dbOk = await dbPing();
  } catch (_) {
    dbOk = false;
  }

  return res.json({
    ok: true,
    ts: new Date().toISOString(),
    marker: "FAST_A_DB_COMPAT_2026-03-02_v1",
    node: process.version,
    has_DATABASE_URL: !!DATABASE_URL,
    db_ok: dbOk,
    sharp: !!sharp,
  });
});

// ========= DB init endpoint =========
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

// ========= Webhook receive =========
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

      const waId = String(contact?.wa_id || msg.from || "").trim();
      const profileName = contact?.profile?.name || null;

      const type = msg.type || "unknown";

      let text = null;
      let caption = null;
      let media_id = null;
      let mime_type = null;
      let local_original_url = null;
      let local_thumb_url = null;
      let local_file_path = null;

      if (type === "text") {
        text = msg.text?.body ?? null;
      } else if (type === "image") {
        media_id = msg.image?.id || null;
        mime_type = msg.image?.mime_type || null;
        caption = msg.image?.caption || null;
      } else if (type === "video") {
        media_id = msg.video?.id || null;
        mime_type = msg.video?.mime_type || null;
        caption = msg.video?.caption || null;
      } else if (type === "document") {
        media_id = msg.document?.id || null;
        mime_type = msg.document?.mime_type || null;
        caption = msg.document?.caption || msg.document?.filename || null;
      } else if (type === "audio") {
        media_id = msg.audio?.id || null;
        mime_type = msg.audio?.mime_type || null;
      }

      // download media if present
      if (media_id) {
        try {
          const dl = await downloadIncomingMedia(waId, media_id);
          local_original_url = dl?.local_original_url || null;
          local_thumb_url = dl?.local_thumb_url || null;
          local_file_path = dl?.local_file || null;
          mime_type = dl?.mime_type || mime_type;
        } catch (e) {
          console.error("❌ download media failed:", e?.message || e);
        }
      }

      const tags = getTags(text || caption || "");

      // DB write
      const conv = await getOrCreateConversation(waId, profileName);

      await insertMessage({
        conversation_id: conv.id,
        wa_id: waId,
        direction: "incoming",
        msg_type: type,
        text,
        caption,
        tags,
        wa_message_id: msg.id || null,
        timestamp_wa: msg.timestamp || null,
        media_id,
        mime_type,
        local_original_url,
        local_thumb_url,
        local_file_path,
      });

      console.log(
        "📝 Saved incoming:",
        type,
        waId,
        text || caption || "",
        media_id ? `media=${media_id}` : ""
      );
    } catch (err) {
      console.error("❌ Webhook error:", err);
    }
  })();
});

// ========= Media routes =========
// Original: strong cache (file name is stable)
app.get("/media/original/:wa_id/:filename", (req, res) => {
  try {
    const waId = safeFileName(req.params.wa_id);
    const filename = safeFileName(req.params.filename);

    const abs = path.join(mediaDir, waId, filename);
    if (!abs.startsWith(path.join(mediaDir, waId))) return res.status(400).send("Bad path");
    if (!fs.existsSync(abs)) return res.status(404).send("Not found");

    res.setHeader("Content-Type", guessMimeByExt(filename));
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.sendFile(abs);
  } catch (e) {
    console.error("❌ /media/original error:", e);
    return res.status(500).send("Internal error");
  }
});

// Thumb: webp + strong cache, fallback to original if sharp missing or not image
app.get("/media/thumb/:wa_id/:filename", async (req, res) => {
  try {
    const waId = safeFileName(req.params.wa_id);
    const filename = safeFileName(req.params.filename);

    const src = path.join(mediaDir, waId, filename);
    if (!src.startsWith(path.join(mediaDir, waId))) return res.status(400).send("Bad path");
    if (!fs.existsSync(src)) return res.status(404).send("Not found");

    const mime = guessMimeByExt(filename);
    if (!sharp || !mime.startsWith("image/")) {
      // fallback
      res.setHeader("Content-Type", mime);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(src);
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

// ========= Customer APIs (DB) =========
app.get("/customers", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim().toLowerCase();
    const unreadOnly = (req.query.unread || "").toString() === "1";
    const recent24 = (req.query.recent24 || "").toString() === "1";
    const tag = (req.query.tag || "").toString().trim().toLowerCase();

    const r = await pool.query(`
      SELECT id, wa_id, profile_name, last_message_at, last_seen_incoming_at
      FROM conversations
      ORDER BY COALESCE(last_message_at, updated_at) DESC
      LIMIT 500
    `);

    const out = [];
    for (const c of r.rows) {
      // last message
      const lastMsg = await pool.query(
        `
        SELECT msg_type, direction, text, caption, created_at, tags, local_original_url, local_thumb_url
        FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [c.id]
      );

      const last = lastMsg.rows[0] || null;

      // unread count
      const unreadCount = await countUnread(c.id);

      // filters
      if (unreadOnly && unreadCount <= 0) continue;

      const lastTimeIso = c.last_message_at ? new Date(c.last_message_at).toISOString() : null;
      if (recent24 && lastTimeIso && !withinLastHours(lastTimeIso, 24)) continue;

      const lastText = (last?.text || last?.caption || "") + "";
      const hay = `${c.wa_id} ${c.profile_name || ""} ${lastText}`.toLowerCase();
      if (q && !hay.includes(q)) continue;

      if (tag) {
        const tagsArr = Array.isArray(last?.tags) ? last.tags : (last?.tags || []);
        const hasTag =
          Array.isArray(tagsArr) && tagsArr.map((x) => String(x).toLowerCase()).includes(tag);
        if (!hasTag) continue;
      }

      out.push({
        wa_id: c.wa_id,
        profile_name: c.profile_name,
        last_time: last?.created_at ? new Date(last.created_at).toISOString() : lastTimeIso,
        last_text: last?.text || last?.caption || null,
        last_type: last?.msg_type || null,
        last_direction: last?.direction || null,
        unread_count: unreadCount,
      });
    }

    return res.json({ count: out.length, customers: out });
  } catch (e) {
    console.error("❌ /customers error:", e);
    return res.status(500).json({ error: "internal_error", detail: e?.message || String(e) });
  }
});

app.get("/customers/:wa_id/messages", async (req, res) => {
  try {
    const waId = String(req.params.wa_id || "").trim();
    const limit = Math.min(parseInt(req.query.limit || "500", 10) || 500, 3000);

    const convR = await pool.query(`SELECT id, wa_id FROM conversations WHERE wa_id = $1`, [waId]);
    if (convR.rows.length === 0) return res.json({ wa_id: waId, count: 0, messages: [] });

    const convId = convR.rows[0].id;

    const r = await pool.query(
      `
      SELECT
        id,
        wa_id,
        direction,
        msg_type AS type,
        text,
        caption,
        tags,
        wa_message_id AS message_id,
        timestamp_wa AS timestamp,
        media_id,
        mime_type,
        local_original_url AS local_media_url,
        local_thumb_url,
        created_at
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [convId, limit]
    );

    return res.json({ wa_id: waId, count: r.rows.length, messages: r.rows });
  } catch (e) {
    console.error("❌ /customers/:wa_id/messages error:", e);
    return res.status(500).json({ error: "internal_error", detail: e?.message || String(e) });
  }
});

// ========= UI: Customers list =========
app.get("/ui", async (req, res) => {
  try {
    setNoCache(res);

    const q = (req.query.q || "").toString().trim().toLowerCase();
    const unreadOnly = (req.query.unread || "").toString() === "1";
    const recent24 = (req.query.recent24 || "").toString() === "1";

    const data = await fetchCustomersForUi({ q, unreadOnly, recent24 });

    const currentParams = {
      q: q || "",
      unread: unreadOnly ? "1" : "",
      recent24: recent24 ? "1" : "",
    };
    const unreadLink = buildQueryLink("/ui", currentParams, { unread: unreadOnly ? "" : "1" });
    const recentLink = buildQueryLink("/ui", currentParams, { recent24: recent24 ? "" : "1" });

    const rowsHtml = data.customers
      .map((c) => {
        const unreadBadge =
          (c.unread_count || 0) > 0
            ? `<span class="badge">${c.unread_count}</span>`
            : `<span class="badge ghost">0</span>`;

        const lastDir = c.last_direction
          ? `<span class="pill ${escapeHtml(c.last_direction)}">${escapeHtml(c.last_direction)}</span>`
          : "";

        const preview = escapeHtml(c.last_text || "");
        return `
          <tr>
            <td class="mono"><a href="/ui/customer/${encodeURIComponent(c.wa_id)}">${escapeHtml(c.wa_id)}</a></td>
            <td>${escapeHtml(c.profile_name || "")}</td>
            <td>${escapeHtml(fmtTime(c.last_time))}</td>
            <td>${unreadBadge} ${lastDir} <span class="preview">${preview}</span></td>
          </tr>
        `;
      })
      .join("");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>WhatsApp CS - Customers</title>
  <style>
    :root{
      --bg:#f6f7fb; --card:#ffffff; --text:#111827; --muted:#6b7280; --line:#e5e7eb;
      --blue:#2563eb; --blue2:#1d4ed8; --red:#ef4444; --chip:#f3f4f6;
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
    input{padding:10px 12px; border:1px solid var(--line); border-radius:12px; background:var(--card); min-width:280px;}
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
        <div class="muted">DB-backed • Version: FAST_A_DB_COMPAT_2026-03-02_v1</div>
      </div>

      <div class="controls">
        <a href="/send" class="chip"><b>Send Page</b></a>
        <a href="${unreadLink}" class="chip ${unreadOnly ? "on" : ""}"><b>Unread Only</b></a>
        <a href="${recentLink}" class="chip ${recent24 ? "on" : ""}"><b>Last 24h</b></a>
      </div>

      <form method="get" action="/ui" class="controls">
        <input name="q" placeholder="Search wa_id / name / last text" value="${escapeHtml(q)}"/>
        <input type="hidden" name="unread" value="${unreadOnly ? "1" : ""}"/>
        <input type="hidden" name="recent24" value="${recent24 ? "1" : ""}"/>
        <button type="submit">Apply</button>
        <a class="muted" href="/ui">Clear</a>
      </form>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>wa_id</th>
            <th>Name</th>
            <th>Last time</th>
            <th>Last message</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || `<tr><td colspan="4" class="muted">No customers found.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="footerNote">Tips: open /__db_init once after deploy if needed.</div>
  </div>
</body>
</html>`;

    return res.status(200).send(html);
  } catch (e) {
    console.error("❌ /ui error:", e);
    return res.status(500).send("Internal error");
  }
});

async function fetchCustomersForUi({ q, unreadOnly, recent24 }) {
  const r = await pool.query(`
    SELECT id, wa_id, profile_name, last_message_at, last_seen_incoming_at
    FROM conversations
    ORDER BY COALESCE(last_message_at, updated_at) DESC
    LIMIT 500
  `);

  const customers = [];
  for (const c of r.rows) {
    const lastMsg = await pool.query(
      `
      SELECT msg_type, direction, text, caption, created_at
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [c.id]
    );
    const last = lastMsg.rows[0] || null;
    const unreadCount = await countUnread(c.id);

    if (unreadOnly && unreadCount <= 0) continue;

    const lastTimeIso = last?.created_at ? new Date(last.created_at).toISOString() : null;
    if (recent24 && lastTimeIso && !withinLastHours(lastTimeIso, 24)) continue;

    const lastText = (last?.text || last?.caption || "") + "";
    const hay = `${c.wa_id} ${c.profile_name || ""} ${lastText}`.toLowerCase();
    if (q && !hay.includes(q)) continue;

    customers.push({
      wa_id: c.wa_id,
      profile_name: c.profile_name,
      last_time: lastTimeIso,
      last_text: last?.text || last?.caption || null,
      last_type: last?.msg_type || null,
      last_direction: last?.direction || null,
      unread_count: unreadCount,
    });
  }

  return { customers };
}

// ========= UI: Customer chat =========
app.get("/ui/customer/:wa_id", async (req, res) => {
  try {
    setNoCache(res);

    const waId = String(req.params.wa_id || "").trim();
    const q = (req.query.q || "").toString().trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit || "800", 10) || 800, 3000);
    const recent24 = (req.query.recent24 || "").toString() === "1";
    const unreadOnly = (req.query.unread || "").toString() === "1";
    const tag = (req.query.tag || "").toString().trim().toLowerCase();

    const convR = await pool.query(`SELECT id, wa_id, profile_name, last_seen_incoming_at FROM conversations WHERE wa_id = $1`, [waId]);
    if (convR.rows.length === 0) return res.status(404).send("Conversation not found");

    const conv = convR.rows[0];
    const convId = conv.id;
    const lastSeen = conv.last_seen_incoming_at ? new Date(conv.last_seen_incoming_at).toISOString() : null;
    const lastSeenMs = isoToMs(lastSeen);

    const msgsR = await pool.query(
      `
      SELECT
        id,
        direction,
        msg_type AS type,
        text,
        caption,
        tags,
        local_original_url AS local_media_url,
        local_thumb_url,
        media_id,
        mime_type,
        created_at
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [convId, limit]
    );

    const rows = msgsR.rows;

    // tag dropdown
    const tagsSet = new Set();
    for (const r0 of rows) {
      const arr = Array.isArray(r0.tags) ? r0.tags : [];
      for (const t0 of arr) tagsSet.add(String(t0));
    }
    const allTags = Array.from(tagsSet).sort();

    // filters
    const filtered = rows.filter((r0) => {
      const text0 = (r0.text || "").toString();
      const cap0 = (r0.caption || "").toString();
      const tags0 = Array.isArray(r0.tags) ? r0.tags.join(",") : "";
      const hay = `${text0} ${cap0} ${tags0}`.toLowerCase();

      if (q && !hay.includes(q)) return false;

      const timeIso = r0.created_at ? new Date(r0.created_at).toISOString() : null;
      if (recent24 && timeIso && !withinLastHours(timeIso, 24)) return false;

      if (tag) {
        const arr = Array.isArray(r0.tags) ? r0.tags : [];
        const has = arr.map((x) => String(x).toLowerCase()).includes(tag);
        if (!has) return false;
      }

      if (unreadOnly) {
        if (r0.direction !== "incoming") return false;
        const ms = isoToMs(timeIso);
        if (!ms || ms <= lastSeenMs) return false;
      }

      return true;
    });

    // mark seen when open page
    await markConversationSeen(waId);

    const sentFlag = (req.query.sent || "").toString();
    const errMsg = (req.query.err || "").toString();
    const notice = errMsg
      ? `<div class="alert err">❌ ${escapeHtml(errMsg)}</div>`
      : sentFlag
      ? `<div class="alert ok">✅ Sent</div>`
      : "";

    function renderMsgContent(r0) {
      const type0 = r0.type || "";
      const text0 = r0.text || "";
      const caption0 = r0.caption || "";
      const originalUrl = r0.local_media_url || null;
      const thumbUrl = r0.local_thumb_url || null;

      if (type0 === "text") {
        return `<div class="text">${escapeHtml(text0)}</div>`;
      }

      if (originalUrl) {
        if (type0 === "image") {
          const imgSrc = thumbUrl || originalUrl;
          return `
            ${caption0 ? `<div class="text">${escapeHtml(caption0)}</div>` : ""}
            <div class="media">
              <a href="${originalUrl}" target="_blank" rel="noreferrer">
                <img src="${imgSrc}" alt="image"/>
              </a>
              <div class="mediaActions">
                <a href="${originalUrl}" target="_blank" rel="noreferrer">Open / Download</a>
              </div>
            </div>
          `;
        }
        if (type0 === "video") {
          return `
            ${caption0 ? `<div class="text">${escapeHtml(caption0)}</div>` : ""}
            <div class="media">
              <video controls src="${originalUrl}" style="max-width:100%; border-radius:12px;"></video>
              <div class="mediaActions"><a href="${originalUrl}" target="_blank" rel="noreferrer">Open / Download</a></div>
            </div>
          `;
        }
        if (type0 === "audio") {
          return `
            <div class="media">
              <audio controls src="${originalUrl}" style="width:100%;"></audio>
              <div class="mediaActions"><a href="${originalUrl}" target="_blank" rel="noreferrer">Open / Download</a></div>
            </div>
          `;
        }
        // document
        return `
          <div class="text">${escapeHtml(caption0 || "Document")}</div>
          <div class="media">
            <div class="fileBox">
              <div class="fileMeta">
                <div><b>${escapeHtml(type0)}</b></div>
                <div class="mutedSmall mono">${escapeHtml(r0.mime_type || "")}</div>
              </div>
              <a class="btnLink" href="${originalUrl}" target="_blank" rel="noreferrer">Download</a>
            </div>
          </div>
        `;
      }

      // no local file
      return `
        <div class="text">${escapeHtml(caption0 || text0 || `[${type0}]`)}</div>
        ${r0.media_id ? `<div class="mutedSmall mono">media_id=${escapeHtml(r0.media_id)}</div>` : ""}
      `;
    }

    const bubbles = filtered
      .map((r0) => {
        const isOut = r0.direction === "outgoing";
        const timeIso = r0.created_at ? new Date(r0.created_at).toISOString() : "";
        const time = fmtTime(timeIso);

        const tagsArr = Array.isArray(r0.tags) ? r0.tags : [];
        const tagsHtml = tagsArr.map((t0) => `<span class="tag">${escapeHtml(t0)}</span>`).join(" ");

        let unreadMark = "";
        if (r0.direction === "incoming") {
          const ms = isoToMs(timeIso);
          if (ms && ms > lastSeenMs) unreadMark = `<span class="dot" title="unread"></span>`;
        }

        return `
          <div class="row ${isOut ? "right" : "left"}">
            <div class="bubble ${isOut ? "out" : "in"}">
              <div class="meta">
                ${unreadMark}
                <span class="time">${escapeHtml(time)}</span>
                <span class="type">${escapeHtml(r0.type || "")}</span>
                ${tagsHtml ? `<span class="tags">${tagsHtml}</span>` : ""}
              </div>
              ${renderMsgContent(r0)}
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
      ...allTags.map((t0) => `<option value="${escapeHtml(t0)}" ${t0.toLowerCase() === tag ? "selected" : ""}>${escapeHtml(t0)}</option>`),
    ].join("");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>WhatsApp CS - ${escapeHtml(waId)}</title>
  <style>
    :root{
      --bg:#f6f7fb; --card:#ffffff; --text:#111827; --muted:#6b7280; --line:#e5e7eb;
      --in:#ffffff; --out:#ecfdf5;
      --blue:#2563eb; --blue2:#1d4ed8; --red:#ef4444; --chip:#f3f4f6;
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

    .reply{padding:14px; border-top:1px solid var(--line);}
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
        <input name="q" placeholder="Search text / tags" value="${escapeHtml(q)}"/>
        <select name="tag">${tagOptions}</select>
        <input name="limit" type="hidden" value="${escapeHtml(String(limit))}"/>
        <input name="recent24" type="hidden" value="${recent24 ? "1" : ""}"/>
        <input name="unread" type="hidden" value="${unreadOnly ? "1" : ""}"/>
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
          <input type="hidden" name="to" value="${escapeHtml(waId)}"/>
          <input type="hidden" name="redirect" value="/ui/customer/${encodeURIComponent(waId)}"/>

          <textarea name="text" rows="3" placeholder="Type reply... (caption for media)"></textarea>

          <div class="row2" style="margin-top:10px;">
            <input type="file" name="file"/>
            <div class="fileHint">Support: image/video/audio/document • Max 25MB</div>
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

    return res.status(200).send(html);
  } catch (e) {
    console.error("❌ /ui/customer error:", e);
    return res.status(500).send("Internal error");
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
      <label class="muted">To (wa_id)</label>
      <input name="to" required/>
      <label class="muted" style="display:block; margin-top:10px;">Text (or caption for media)</label>
      <textarea name="text" rows="4" placeholder="Type message..."></textarea>
      <label class="muted" style="display:block; margin-top:10px;">File (optional)</label>
      <input type="file" name="file"/>
      <div style="margin-top:12px;">
        <button type="submit">Send</button>
      </div>
    </form>
    <p style="margin-top:12px;"><a href="/ui">Back to UI</a></p>
  </div>
</body></html>`);
});

// ===== SEND API =====
app.post("/send", upload.single("file"), async (req, res) => {
  try {
    const to = (req.body.to || "").trim();
    const text = (req.body.text || "").trim();
    const redirectTo = (req.body.redirect || "").trim();

    if (!to) return res.status(400).send("Missing 'to'");

    const hasFile = !!req.file;
    if (!hasFile && !text) return res.status(400).send("Missing 'text' (or upload a file)");

    // build payload
    let payload = null;
    let outType = "text";
    let uploadedMediaId = null;
    let mimeType = null;
    let localOutFile = null;

    if (!hasFile) {
      payload = { messaging_product: "whatsapp", to, type: "text", text: { body: text } };
      outType = "text";
    } else {
      localOutFile = req.file.path;
      mimeType = req.file.mimetype || guessMimeByExt(req.file.originalname);
      const category = classifyMediaType(mimeType);

      uploadedMediaId = await uploadMediaToWhatsApp(localOutFile, mimeType);
      if (!uploadedMediaId) throw new Error("Upload succeeded but missing media id");

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
          document: { id: uploadedMediaId, ...(req.file.originalname ? { filename: req.file.originalname } : {}), ...(text ? { caption: text } : {}) },
        };
      }
    }

    const url = `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Send failed: ${JSON.stringify(data)}`);

    // Save outgoing to DB
    const conv = await getOrCreateConversation(to, null);

    // If media file, keep a copy for preview (ephemeral without volume)
    let localOriginalUrl = null;
    let localThumbUrl = null;
    let localSavedPath = null;

    if (hasFile && localOutFile) {
      const waDir = mediaLocalDirForWaId(to);
      const ext = extFromMime(mimeType);
      const base = safeFileName(path.basename(localOutFile));
      const outName = `outgoing__${base}.${ext}`;
      const dest = path.join(waDir, outName);

      fs.copyFileSync(localOutFile, dest);
      localSavedPath = dest;
      localOriginalUrl = mediaOriginalPath(to, outName);

      // thumb if image + sharp
      if (sharp && (mimeType || "").toLowerCase().startsWith("image/")) {
        const stem = outName.replace(/\.[^.]+$/, "");
        const thumbAbs = path.join(thumbsDir, safeFileName(to), `${stem}.webp`);
        try {
          await ensureImageThumb(dest, thumbAbs);
          localThumbUrl = mediaThumbPath(to, outName);
        } catch (_) {
          localThumbUrl = null;
        }
      }
    }

    await insertMessage({
      conversation_id: conv.id,
      wa_id: to,
      direction: "outgoing",
      msg_type: outType,
      text: outType === "text" ? text : null,
      caption: outType !== "text" ? (text || null) : null,
      tags: getTags(text),
      wa_message_id: data?.messages?.[0]?.id || null,
      timestamp_wa: null,
      media_id: uploadedMediaId,
      mime_type: mimeType,
      local_original_url: localOriginalUrl,
      local_thumb_url: localThumbUrl,
      local_file_path: localSavedPath,
    });

    if (redirectTo) {
      const u = new URL(redirectTo, "http://localhost");
      u.searchParams.set("sent", "1");
      return res.redirect(u.pathname + u.search);
    }

    return res.send(`✅ Sent\n\n${JSON.stringify(data, null, 2)}`);
  } catch (e) {
    console.error("❌ /send error:", e);
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
    console.log("Starting Container");
    await dbPing();
    console.log("✅ DB connected");
    await dbInit();
    console.log("✅ messages table ready");
  } catch (e) {
    console.error("❌ DB init failed:", e);
    // still start server, but UI/API will error; you can check /__version
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