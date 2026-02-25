const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false },
});

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
res.send("VLTGO Support API is running");
});

app.get("/health", async (req, res) => {
try {
const r = await pool.query("SELECT NOW() as now");
res.json({ ok: true, db: true, now: r.rows[0].now });
} catch (err) {
res.status(500).json({ ok: false });
}
});

app.post("/admin/init-db", async (req, res) => {
try {
await pool.query(
"CREATE TABLE IF NOT EXISTS contacts (id SERIAL PRIMARY KEY, wa_id TEXT UNIQUE NOT NULL, display_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());"
);

await pool.query(
  "CREATE TABLE IF NOT EXISTS conversations (id SERIAL PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'OPEN', last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), unread_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(contact_id));"
);

await pool.query(
  "CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')), msg_type TEXT NOT NULL DEFAULT 'text', text TEXT, media_url TEXT, wa_message_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), raw_payload JSONB);"
);

res.json({ ok: true });

} catch (err) {
res.status(500).json({ ok: false });
}
});

app.get("/webhook", (req, res) => {
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "test_token";
const mode = req.query["hub.mode"];
const token = req.query["hub.verify_token"];
const challenge = req.query["hub.challenge"];

if (mode === "subscribe" && token === VERIFY_TOKEN) {
return res.status(200).send(challenge);
}
return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
try {
const body = req.body;
const entry = body?.entry?.[0];
const change = entry?.changes?.[0];
const value = change?.value;

if (!value || value.messaging_product !== "whatsapp") {
  return res.sendStatus(200);
}

const messages = value.messages;
if (!messages || messages.length === 0) {
  return res.sendStatus(200);
}

const msg = messages[0];
const wa_id = msg.from;
const wa_message_id = msg.id;
const display_name = value?.contacts?.[0]?.profile?.name || null;

let msg_type = msg.type || "text";
let text = null;

if (msg_type === "text") {
  text = msg.text?.body || null;
} else {
  text = "[" + msg_type + " received]";
}

const contactResult = await pool.query(
  "INSERT INTO contacts (wa_id, display_name) VALUES ($1, $2) ON CONFLICT (wa_id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, contacts.display_name) RETURNING id;",
  [wa_id, display_name]
);

const contact_id = contactResult.rows[0].id;

const convResult = await pool.query(
  "INSERT INTO conversations (contact_id, status, last_message_at, unread_count) VALUES ($1, 'OPEN', NOW(), 1) ON CONFLICT (contact_id) DO UPDATE SET last_message_at = NOW(), unread_count = conversations.unread_count + 1 RETURNING id;",
  [contact_id]
);

const conversation_id = convResult.rows[0].id;

await pool.query(
  "INSERT INTO messages (conversation_id, direction, msg_type, text, wa_message_id, raw_payload) VALUES ($1, 'inbound', $2, $3, $4, $5);",
  [conversation_id, msg_type, text, wa_message_id, body]
);

return res.sendStatus(200);

} catch (err) {
return res.sendStatus(200);
}
});

app.listen(PORT, () => {
console.log("Server running on port " + PORT);
});
