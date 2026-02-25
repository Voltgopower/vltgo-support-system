const express = require("express");
const crypto = require("crypto");

const app = express();

// 如果你要校验 Meta webhook 签名（推荐），需要保留 raw body
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf; // for signature verification
    },
  })
);

// 环境变量（云平台一定要用 PORT）
const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "12345"; // 你之前用的 12345
const APP_SECRET = process.env.META_APP_SECRET || ""; // 可选：Meta App Secret，用于签名校验

// 主页测试
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// 1) Meta Webhook 验证：GET /webhook
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("➡️ GET /webhook verify:", { mode, token });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  } else {
    console.log("❌ Webhook verify failed");
    return res.sendStatus(403);
  }
});

// （可选）2) 校验签名：X-Hub-Signature-256
function verifySignature(req) {
  if (!APP_SECRET) return true; // 没配置就跳过
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// 3) 接收消息：POST /webhook
app.post("/webhook", (req, res) => {
  // 先快速回 200，避免 Meta 重试（但我们也打印日志）
  if (!verifySignature(req)) {
    console.log("❌ Invalid signature");
    return res.sendStatus(403);
  }

  console.log("🔥 POST /webhook HIT");
  console.log(JSON.stringify(req.body, null, 2));

  return res.sendStatus(200);
});

// 关键：云平台必须监听 0.0.0.0
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});
