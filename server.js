const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : undefined
});

const PORT = process.env.PORT || 3000;

// 测试接口
app.get("/", (req, res) => {
  res.send("VLTGO Support API is running 🚀");
});

app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, db: true, now: r.rows[0].now });
  } catch (err) {
    console.error("DB health check failed:", err);
    res.status(500).json({ ok: false, db: false, error: String(err.message || err) });
  }
});

// 初始化数据库（一次性使用）
app.post("/admin/init-db", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        wa_id TEXT UNIQUE NOT NULL,
        display_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'OPEN',
        last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        unread_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(contact_id)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
        msg_type TEXT NOT NULL DEFAULT 'text',
        text TEXT,
        media_url TEXT,
        wa_message_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        raw_payload JSONB
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at);`);

    res.json({ ok: true, message: "DB initialized" });
  } catch (err) {
    console.error("init-db failed:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// WhatsApp webhook 验证
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "test_token";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

// 接收 webhook
app.post("/webhook", (req, res) => {
  console.log("Incoming webhook:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// 最后再启动服务器
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
