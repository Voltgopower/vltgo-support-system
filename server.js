/**
 * WhatsApp Webhook Server (DB Version - Clean Stable)
 */

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { Pool } = require("pg");

// ===== Optional sharp =====
let sharp = null;
try {
  sharp = require("sharp");
  console.log("✅ sharp enabled");
} catch {
  console.log("⚠️ sharp not installed (thumb fallback)");
}

// ==========================
// ENV
// ==========================
const {
  VERIFY_TOKEN,
  WA_TOKEN,
  PHONE_NUMBER_ID,
  UI_USER,
  UI_PASS,
  PORT = 8080,
  DATABASE_URL
} = process.env;

// ==========================
// PostgreSQL
// ==========================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    await pool.query("SELECT 1");
    console.log("✅ DB connected");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        wa_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        type TEXT,
        text TEXT,
        caption TEXT,
        media_id TEXT,
        mime_type TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    console.log("✅ messages table ready");
  } catch (err) {
    console.error("❌ DB init failed:", err);
  }
}

// ==========================
// Express
// ==========================
const app = express();
app.use(express.json());

// ==========================
// Version probe
// ==========================
app.get("/__version", (req, res) => {
  res.json({
    ok: true,
    marker: "DB_CLEAN_VERSION_2026-03-02",
    node: process.version,
    has_DATABASE_URL: !!process.env.DATABASE_URL
  });
});

// ==========================
// Webhook verify
// ==========================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ==========================
// Webhook receive
// ==========================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value?.messages?.length) return;

    const msg = value.messages[0];
    const wa_id = msg.from;
    const type = msg.type;

    let text = null;
    let caption = null;
    let media_id = null;
    let mime_type = null;

    if (type === "text") {
      text = msg.text?.body || null;
    }

    if (type === "image") {
      media_id = msg.image?.id || null;
      mime_type = msg.image?.mime_type || null;
      caption = msg.image?.caption || null;
    }

    await pool.query(
      `
      INSERT INTO messages
      (wa_id, direction, type, text, caption, media_id, mime_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      `,
      [wa_id, "incoming", type, text, caption, media_id, mime_type]
    );

    console.log("📝 Saved incoming:", type, wa_id);
  } catch (err) {
    console.error("❌ Webhook error:", err);
  }
});

// ==========================
// Send message (text only for now)
// ==========================
app.post("/send", async (req, res) => {
  try {
    const { to, text } = req.body;

    if (!to || !text) {
      return res.status(400).send("Missing to/text");
    }

    const r = await fetch(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text }
        })
      }
    );

    const data = await r.json();

    if (!r.ok) {
      console.error("❌ Send error:", data);
      return res.status(500).send("Send failed");
    }

    await pool.query(
      `
      INSERT INTO messages
      (wa_id, direction, type, text)
      VALUES ($1,$2,$3,$4)
      `,
      [to, "outgoing", "text", text]
    );

    console.log("📝 Saved outgoing:", to);
    res.send("Sent");
  } catch (err) {
    console.error("❌ Send exception:", err);
    res.status(500).send("Internal error");
  }
});

// ==========================
// Simple DB viewer (test)
// ==========================
app.get("/messages/:wa_id", async (req, res) => {
  const { wa_id } = req.params;

  const result = await pool.query(
    "SELECT * FROM messages WHERE wa_id=$1 ORDER BY created_at ASC",
    [wa_id]
  );

  res.json(result.rows);
});

// ==========================
// Start server
// ==========================
(async () => {
  await initDB();

  app.listen(PORT, () => {
    console.log("=================================");
    console.log("🚀 Server running");
    console.log("PORT:", PORT);
    console.log("DATABASE_URL SET:", !!DATABASE_URL);
    console.log("=================================");
  });
})();