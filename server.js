const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : undefined
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
