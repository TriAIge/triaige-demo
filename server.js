// Servidor local da demo: serve a página e repassa as chamadas para a API do TriAIge.
// Sem dependências — só Node 18+.
//
// Por que existe: o orchestrator não tem CORS liberado e o token do escritório não deve
// ficar no navegador. O navegador fala só com este servidor; ele injeta o token e
// encaminha para o ALB (e para a URL pré-assinada do S3, no upload).

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 5500);
const API_URL = (process.env.TRIAIGE_API_URL || "http://alb-triaige-910390865.us-east-1.elb.amazonaws.com").replace(/\/$/, "");
const API_BASE = `${API_URL}/api/orchestrator/v1`;
const API_TOKEN = process.env.TRIAIGE_API_TOKEN || "";

const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && STATIC_FILES[url.pathname]) {
      const [file, type] = STATIC_FILES[url.pathname];
      res.writeHead(200, { "Content-Type": type });
      return fs.createReadStream(path.join(__dirname, file)).pipe(res);
    }

    // /api/sessions/... -> {ALB}/api/orchestrator/v1/sessions/...
    if (url.pathname.startsWith("/api/")) {
      const token = currentToken();
      if (!token) {
        return sendJson(res, 500, { message: "TRIAIGE_API_TOKEN não configurado no .env da demo." });
      }
      const target = API_BASE + url.pathname.slice("/api".length) + url.search;
      const headers = { Authorization: `Bearer ${token}` };
      if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
      if (req.headers["idempotency-key"]) headers["Idempotency-Key"] = req.headers["idempotency-key"];

      const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
      const upstream = await fetch(target, { method: req.method, headers, body });
      return relay(res, upstream);
    }

    // PUT /upload?url=<url pré-assinada do S3>
    if (req.method === "PUT" && url.pathname === "/upload") {
      const presigned = new URL(url.searchParams.get("url") || "");
      if (!presigned.hostname.endsWith(".amazonaws.com")) {
        return sendJson(res, 400, { message: "URL de upload inválida." });
      }
      const body = await readBody(req);
      const upstream = await fetch(presigned, {
        method: "PUT",
        // O Content-Type precisa bater com o enviado no presign (faz parte da assinatura).
        headers: { "Content-Type": req.headers["content-type"] },
        body,
      });
      return relay(res, upstream);
    }

    sendJson(res, 404, { message: "Não encontrado." });
  } catch (err) {
    console.error(err);
    sendJson(res, 502, { message: `Falha ao falar com a API: ${err.message}` });
  }
});

server.listen(PORT, () => {
  console.log(`Demo do escritório rodando em http://localhost:${PORT}`);
  console.log(`API: ${API_BASE}`);
  if (!API_TOKEN) console.warn("Atenção: TRIAIGE_API_TOKEN vazio — configure o .env.");
});

async function relay(res, upstream) {
  // Alguns erros do orchestrator (filtro de auth) saem em Latin-1; normaliza tudo para UTF-8.
  const bytes = Buffer.from(await upstream.arrayBuffer());
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = bytes.toString("latin1");
  }
  const type = (upstream.headers.get("content-type") || "text/plain").split(";")[0];
  res.writeHead(upstream.status, { "Content-Type": `${type}; charset=utf-8` });
  res.end(text);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Relê o .env a cada chamada: dá para trocar o token sem reiniciar o servidor.
function currentToken() {
  const file = path.join(__dirname, ".env");
  if (fs.existsSync(file)) {
    const m = fs.readFileSync(file, "utf8").match(/^\s*TRIAIGE_API_TOKEN\s*=\s*(.*?)\s*$/m);
    if (m && m[1]) return m[1].replace(/^["']|["']$/g, "");
  }
  return API_TOKEN;
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
