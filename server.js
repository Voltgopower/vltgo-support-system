/**
 * WhatsApp Webhook Server (Stable + File Logging + Tags + Per-User Logs)
 * GET  /            -> Health check
 * GET  /webhook     -> Meta verification
 * POST /webhook     -> Receive webhook events and save to local files (jsonl)
 *
 * .env required:
 *   VERIFY_TOKEN=voltgo_webhook_verify
 *   PORT=8080
 * optional:
 *   APP_SECRET=xxxxx  // enable webhook signature verification
 */

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

// IMPORTANT: must be before routes (parse JSON + keep raw body for signature check)
app.use(express.json({ verify: rawBodySaver }));
// ========= Basic Auth (protect UI + send) =========
const UI_USER = process.env.UI_USER;
const UI_PASS = process.env.UI_PASS;

function unauthorized(res) {
  res.set("WWW-Authenticate", 'Basic realm="WhatsApp CS"');
  return res.status(401).send("Authentication required");
}

function basicAuth(req, res, next) {
  // allow webhook endpoints without auth (Meta calls)
  if (req.path === "/webhook") return next();

  // protect these routes (UI + read APIs + send)
  const protectedPrefixes = ["/ui", "/customers", "/send"];
  if (!protectedPrefixes.some((p) => req.path.startsWith(p))) return next();

  if (!UI_USER || !UI_PASS) {
    // If not configured, block to avoid accidental public exposure
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
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 8080;
const APP_SECRET = process.env.APP_SECRET || null; // optional

if (!VERIFY_TOKEN) {
  console.error("Missing .env variable: VERIFY_TOKEN");
  process.exit(1);
}

/** Save raw body for signature verification (optional) */
function rawBodySaver(req, res, buf) {
  req.rawBody = buf;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendJsonl(filePath, obj) {
  const line = JSON.stringify(obj) + "\n";
  fs.appendFile(filePath, line, (err) => {
    if (err) console.error("❌ log write failed:", err.message);
  });
}

function todayFileName() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `messages-${yyyy}-${mm}-${dd}.jsonl`;
}

// Keep filenames safe on Windows/macOS/Linux
function safeFileName(name) {
  return String(name || "")
    .replace(/[\\\/:*?"<>|]/g, "_")
    .trim();
}

/** Optional: verify Meta webhook signature */
function isValidSignature(req) {
  if (!APP_SECRET) return true; // not enabled
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

// Very simple keyword tagging (no auto-reply)
function getTags(text) {
  const t = (text || "").toLowerCase();
  const tags = [];

  // logistics
  if (/(track|tracking|deliver|delivery|ups|fedex|dhl|usps|shipment|物流|派送|签收|运单|快递)/i.test(t)) {
    tags.push("logistics");
  }

  // after sales
  if (/(warranty|broken|issue|problem|fault|defect|return|replace|refund|not work|doesn't work|坏|故障|问题|退货|换货|退款)/i.test(t)) {
    tags.push("after_sales");
  }

  // pre sales
  if (/(price|quote|quotation|invoice|pay|payment|discount|availability|lead time|报价|价格|发票|付款|折扣|有货|交期)/i.test(t)) {
    tags.push("pre_sales");
  }

  return tags;
}

// ========= Health check =========
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// ========= GET webhook verify =========
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

// ========= POST webhook receive =========
app.post("/webhook", (req, res) => {
  // Always ACK quickly
  res.sendStatus(200);

  try {
    // Optional signature verification (only if APP_SECRET is set)
    if (!isValidSignature(req)) {
      console.warn("❌ Invalid webhook signature");
      return;
    }

    const body = req.body;
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const field = change?.field;

    // Only handle message events
    if (field !== "messages" || !value?.messages?.length) return;

    const msg = value.messages[0];
    const contact = value.contacts?.[0];

    const record = {
      received_at: new Date().toISOString(),
      waba_id: entry?.id,
      phone_number_id: value?.metadata?.phone_number_id,
      display_phone_number: value?.metadata?.display_phone_number,

      from: msg.from,
      wa_id: contact?.wa_id || msg.from || null,
      profile_name: contact?.profile?.name || null,

      message_id: msg.id,
      timestamp: msg.timestamp,
      type: msg.type,

      text: msg.text?.body ?? null,
      tags: getTags(msg.text?.body ?? ""),
      raw: msg,
    };

    const baseDir = path.join(__dirname, "logs");
    const byDateDir = path.join(baseDir, "by-date");
    const byUserDir = path.join(baseDir, "by-user");

    ensureDir(byDateDir);
    ensureDir(byUserDir);

    // 1) daily full log
    appendJsonl(path.join(byDateDir, todayFileName()), record);

    // 2) per-user log (use wa_id)
    const customerKey = safeFileName(record.wa_id || record.from);
    appendJsonl(path.join(byUserDir, `${customerKey}.jsonl`), record);

    console.log("📝 saved message:", record.type, record.from, record.text || "", record.tags?.length ? `tags=${record.tags.join(",")}` : "");
  } catch (e) {
    console.error("❌ webhook handler error:", e);
  }
});
// ========= Customer history APIs (read-only) =========

const baseLogsDir = path.join(__dirname, "logs");
const byUserDir = path.join(baseLogsDir, "by-user");

// read last N lines from a file (simple + safe for small/medium logs)
function readJsonlLastN(filePath, n = 200) {
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

// summarize a customer's log file
function summarizeCustomer(filePath, waId) {
  const rows = readJsonlLastN(filePath, 200); // last 200 is enough for summary
  if (rows.length === 0) return null;

  const last = rows[rows.length - 1];
  const tagCounts = {};
  for (const r of rows) {
    for (const tag of r.tags || []) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  }

  return {
    wa_id: waId,
    profile_name: last.profile_name || null,
    last_time: last.received_at || null,
    last_text: last.text || null,
    last_type: last.type || null,
    tags: tagCounts,
  };
}

// GET /customers -> list recent customers
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

    // sort by last_time desc
    customers.sort((a, b) => {
      const ta = a.last_time ? Date.parse(a.last_time) : 0;
      const tb = b.last_time ? Date.parse(b.last_time) : 0;
      return tb - ta;
    });

    res.json({ count: customers.length, customers });
  } catch (e) {
    console.error("❌ /customers error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /customers/:wa_id/messages?limit=200
app.get("/customers/:wa_id/messages", (req, res) => {
  try {
    const waId = safeFileName(req.params.wa_id);
    const limit = Math.min(parseInt(req.query.limit || "200", 10) || 200, 2000);

    const filePath = path.join(byUserDir, `${waId}.jsonl`);
    const rows = readJsonlLastN(filePath, limit);

    // return newest last (chronological). If you prefer newest-first, reverse().
    res.json({ wa_id: waId, count: rows.length, messages: rows });
  } catch (e) {
    console.error("❌ /customers/:wa_id/messages error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});
// ========= Simple Web UI (read-only) =========

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

app.get("/ui", (req, res) => {
  try {
    ensureDir(byUserDir);
    const q = (req.query.q || "").toString().trim().toLowerCase();

    const files = fs.readdirSync(byUserDir).filter((f) => f.endsWith(".jsonl"));
    const customers = [];

    for (const f of files) {
      const waId = f.replace(/\.jsonl$/i, "");
      const filePath = path.join(byUserDir, f);
      const summary = summarizeCustomer(filePath, waId);
      if (!summary) continue;

      const hay = `${summary.wa_id} ${summary.profile_name || ""} ${summary.last_text || ""}`.toLowerCase();
      if (q && !hay.includes(q)) continue;

      customers.push(summary);
    }

    customers.sort((a, b) => {
      const ta = a.last_time ? Date.parse(a.last_time) : 0;
      const tb = b.last_time ? Date.parse(b.last_time) : 0;
      return tb - ta;
    });

    const rowsHtml = customers
      .map((c) => {
        const tags = Object.entries(c.tags || {})
          .map(([k, v]) => `<span class="tag">${escapeHtml(k)}:${v}</span>`)
          .join(" ");
        return `
          <tr>
            <td class="mono"><a href="/ui/customer/${encodeURIComponent(c.wa_id)}">${escapeHtml(c.wa_id)}</a></td>
            <td>${escapeHtml(c.profile_name || "")}</td>
            <td>${escapeHtml(fmtTime(c.last_time))}</td>
            <td>${escapeHtml(c.last_text || "")}</td>
            <td>${tags}</td>
          </tr>
        `;
      })
      .join("");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp CS - Customers</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
    input { padding: 8px 10px; min-width: 260px; }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; }
    th, td { border-bottom: 1px solid #eee; padding: 10px; text-align: left; vertical-align: top; }
    th { background: #fafafa; position: sticky; top: 0; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .tag { display:inline-block; padding:2px 6px; border:1px solid #ddd; border-radius: 999px; margin-right: 6px; font-size: 12px; }
    .muted { color: #777; font-size: 13px; }
    a { text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="top">
    <div>
      <h2 style="margin:0;">Customers</h2>
      <div class="muted">Read-only. Data source: logs/by-user/*.jsonl</div>
    </div>
    <form method="get" action="/ui">
      <input name="q" placeholder="Search wa_id / name / last text" value="${escapeHtml(q)}" />
      <button type="submit">Search</button>
      <a class="muted" href="/ui" style="margin-left:10px;">Clear</a>
    </form>
  </div>

  <table>
    <thead>
      <tr>
        <th>wa_id</th>
        <th>Name</th>
        <th>Last time</th>
        <th>Last message</th>
        <th>Tags (last 200)</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || `<tr><td colspan="5" class="muted">No customers found.</td></tr>`}
    </tbody>
  </table>
</body>
</html>`;

    res.status(200).send(html);
  } catch (e) {
    console.error("❌ /ui error:", e);
    res.status(500).send("Internal error");
  }
});

app.get("/ui/customer/:wa_id", (req, res) => {
  try {
    const waId = safeFileName(req.params.wa_id);
    const q = (req.query.q || "").toString().trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit || "500", 10) || 500, 5000);

    const filePath = path.join(byUserDir, `${waId}.jsonl`);
    const rows = readJsonlLastN(filePath, limit);

    const filtered = q
      ? rows.filter((r) =>
          `${r.text || ""} ${(r.tags || []).join(",")}`
            .toLowerCase()
            .includes(q)
        )
      : rows;

    const items = filtered
      .map((r) => {
        const tags = (r.tags || [])
          .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
          .join(" ");
        return `
          <div class="msg">
            <div class="meta">
              <span class="mono">${escapeHtml(r.received_at)}</span>
              <span class="mono">type=${escapeHtml(r.type || "")}</span>
              <span class="mono">from=${escapeHtml(r.from || "")}</span>
              <span>${tags}</span>
            </div>
            <div class="text">${escapeHtml(r.text || "")}</div>
          </div>
        `;
      })
      .join("");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp CS - ${escapeHtml(waId)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .top { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap; }
    .mono { font-family: ui-monospace, monospace; }
    .muted { color: #777; font-size: 13px; }
    input, textarea { padding: 8px 10px; }
    .tag { display:inline-block; padding:2px 6px; border:1px solid #ddd; border-radius:999px; margin-right:6px; font-size:12px; }
    .msg { border:1px solid #eee; border-radius:10px; padding:10px 12px; margin-top:10px; }
    .meta { display:flex; gap:10px; flex-wrap:wrap; font-size:12px; color:#444; }
    .text { margin-top:8px; white-space: pre-wrap; }
    textarea { width:100%; box-sizing:border-box; }
    button { padding:6px 12px; }
  </style>
</head>
<body>
  <div class="top">
    <div>
      <h2 style="margin:0;">Customer: <span class="mono">${escapeHtml(waId)}</span></h2>
      <div class="muted">
        <a href="/ui">← Back</a> | Showing last ${filtered.length} messages
      </div>
    </div>
    <form method="get" action="/ui/customer/${encodeURIComponent(waId)}">
      <input name="q" placeholder="Search..." value="${escapeHtml(q)}" />
      <input name="limit" type="hidden" value="${escapeHtml(String(limit))}" />
      <button type="submit">Search</button>
      <a href="/ui/customer/${encodeURIComponent(waId)}">Clear</a>
    </form>
  </div>

  ${items || `<div class="muted" style="margin-top:12px;">No messages found.</div>`}

  <!-- Reply Box -->
  <div style="margin-top:20px; padding:12px; border:1px solid #ddd; border-radius:10px;">
    <form method="post" action="/send">
      <input type="hidden" name="to" value="${escapeHtml(waId)}" />
      <input type="hidden" name="redirect" value="/ui/customer/${encodeURIComponent(waId)}" />
      <textarea name="text" rows="4" required placeholder="Type reply..."></textarea>
      <div style="margin-top:10px;">
        <button type="submit">Send</button>
      </div>
    </form>
  </div>

</body>
</html>`;

    res.status(200).send(html);
  } catch (e) {
    console.error("❌ /ui/customer error:", e);
    res.status(500).send("Internal error");
  }
});// ===== SEND PAGE =====
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

app.use(express.urlencoded({ extended: false }));

// ===== SEND API =====
app.post("/send", async (req, res) => {
  try {
    const to = (req.body.to || "").trim();
    const text = (req.body.text || "").trim();

    // 可选：从表单带过来的“发送后跳回哪里”
    const redirectTo = (req.body.redirect || "").trim();

    if (!to || !text) {
      // 缺参数：如果有 redirect 就带错误信息跳回；否则直接提示
      if (redirectTo) {
        const url = new URL(redirectTo, "http://localhost"); // 只是为了拼 query，用什么域名都行
        url.searchParams.set("err", "Missing to/text");
        return res.redirect(url.pathname + url.search);
      }
      return res.status(400).send("Missing 'to' or 'text'");
    }

    // ====== 你原本的发送代码（这里是标准 WhatsApp Cloud API 发文本） ======
    const url = `https://graph.facebook.com/v25.0/${process.env.PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();

    if (!r.ok) {
      console.error("❌ Send error:", data);

      if (redirectTo) {
        const url2 = new URL(redirectTo, "http://localhost");
        url2.searchParams.set("err", "Send failed");
        return res.redirect(url2.pathname + url2.search);
      }

      return res.status(500).send(`Error: ${JSON.stringify(data)}`);
    }

    // ====== ✅ 发送成功后的行为：有 redirect 就跳回去，否则显示成功页 ======
    if (redirectTo) {
      const url3 = new URL(redirectTo, "http://localhost");
      url3.searchParams.set("sent", "1");
      return res.redirect(url3.pathname + url3.search);
    }

    return res.send(`✅ Sent successfully\n\n${JSON.stringify(data, null, 2)}`);
  } catch (e) {
    console.error("❌ /send exception:", e);
    return res.status(500).send("Internal error");
  }
});
app.listen(PORT, () => {
  console.log("=====================================");
  console.log("🚀 WhatsApp Webhook Server Starting");
  console.log("NODE VERSION:", process.version);
  console.log("PORT:", PORT);
  console.log("VERIFY_TOKEN SET:", VERIFY_TOKEN ? "YES" : "NO");
  console.log("APP_SECRET SET:", APP_SECRET ? "YES" : "NO");
  console.log("=====================================");
  console.log(`✅ Server running on port ${PORT}`);
});