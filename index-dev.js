/**
 * Local dev entry point.
 *
 * Wraps the Lambda handler in an Express server so you can hit the routes
 * locally with curl/Postman. Uses .env via dotenv. Set USE_LOCAL_ENV=true in
 * .env to skip the AWS Secrets Manager fetch.
 *
 * Run: node index-dev.js  (defaults to port 3001)
 */

require("dotenv").config();
process.env.USE_LOCAL_ENV = process.env.USE_LOCAL_ENV || "true";

const http = require("http");
const { handler } = require("./index");

const PORT = parseInt(process.env.DEV_PORT || "3001", 10);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");

    // Synthesize an API Gateway HTTP API v2 event
    const event = {
      version: "2.0",
      routeKey: `${req.method} ${req.url.split("?")[0]}`,
      rawPath: req.url.split("?")[0],
      rawQueryString: req.url.split("?")[1] || "",
      headers: req.headers,
      requestContext: {
        http: {
          method: req.method,
          path: req.url.split("?")[0],
          protocol: "HTTP/1.1",
          sourceIp: "127.0.0.1",
          userAgent: req.headers["user-agent"] || "",
        },
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
      },
      body: body || undefined,
      isBase64Encoded: false,
    };

    try {
      const result = await handler(event);
      res.writeHead(result.statusCode || 200, result.headers || {});
      res.end(result.body || "");
    } catch (err) {
      console.error("[dev server] handler threw:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Handler error: ${err.message}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[dev server] listening on http://localhost:${PORT}`);
  console.log(`Try: curl http://localhost:${PORT}/version`);
});
