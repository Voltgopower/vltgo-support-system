/**
 * server.js (with fingerprint logs)
 * - GET  /webhook  : Meta webhook verification
 * - POST /webhook  : Receive webhook events
 * - GET  /         : Health check
 *
 * Tips:
 * 1) Start (Windows PowerShell):
 *    $env:PORT=3000
 *    $env:WEBHOOK_VERIFY_TOKEN="12345"
 *    node .\server.js
 *
 * 2) Local test:
 *    curl.exe -i "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=12345&hub.challenge=hello"
 */

const express = require("express");
const crypto = require("crypto");

const app = express();

// Keep raw body for signature verification (optional)
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Env vars
const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "12345";
const APP_SECRET = process.env.META_APP_SECRET || ""; // optional: Meta App Secret

// ✅ Fingerprint logs (VERY IMPORTANT for debugging)
console.log("✅ LOADED FILE:", __filename);
console.log("✅ NODE VERSION:", process.version);
console.log("✅ PORT:", PORT);
console.log("✅ VERIFY_TOKEN NOW:", VERIFY_TOKEN ? "[SET]" : "[EMPTY]");
console.log("✅ APP_SECRET:", APP_SECRET ? "[SET]" : "[EMPTY]");

// Health check
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// GET /webhook for Meta verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  // ✅ request log (so you can see whether Meta/NGROK hit you)
  console.log("➡️ GET /webhook", { mode, token, challenge });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  } else {
    console.log("❌ Webhook verify failed. expected token:", VERIFY_TOKEN);
    return res.sendStatus(403);
  }
});

// Optional signature verification
function verifySignature(req) {
  if (!APP_SECRET) return true; // if not configured, skip

  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !req.rawBody) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

// POST /webhook for receiving events
app.post("/webhook", (req, res) => {
  if (!verifySignature(req)) {
    console.log("❌ Invalid signature");
    return res.sendStatus(403);
  }

  console.log("🔥 POST /webhook HIT");
  console.log(JSON.stringify(req.body, null, 2));

  return res.sendStatus(200);
});

// Listen on all interfaces (important for cloud; harmless locally)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});
