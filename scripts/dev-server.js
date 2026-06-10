// Throwaway local dev wrapper — runs the lambda handler under HTTP on :3002
// so supabase_node can hit it during local testing. Not for prod.
require("dotenv").config();
const http = require("http");
const url = require("url");
const handler = require("../index").handler;

const PORT = process.env.DEV_PORT || 3002;

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const event = {
        requestContext: { http: { method: req.method, path: parsed.pathname } },
        headers: req.headers,
        queryStringParameters: parsed.query,
        body: body || null,
      };
      const out = await handler(event);
      res.writeHead(out.statusCode || 200, { "Content-Type": "application/json", ...(out.headers || {}) });
      res.end(out.body || "");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message, stack: e.stack }));
    }
  });
});

server.listen(PORT, () => console.log(`[dev-server] lambda handler bound at http://localhost:${PORT}`));
