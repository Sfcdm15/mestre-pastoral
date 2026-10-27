// Mestre Pastoral — servidor sem dependências (Node 18+)
// Uso: defina GEMINI_API_KEY no arquivo .env e rode `node server.js`
const http = require("http");
const fs = require("fs");
const path = require("path");

// --- Carrega .env (simples) ---
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "prompt.md"), "utf8");
const PUBLIC_DIR = path.join(__dirname, "public");

// Descompacta blivre.json automaticamente se apenas o .gz tiver sido enviado ao servidor
const bibleJsonPath = path.join(PUBLIC_DIR, "bible", "blivre.json");
const bibleGzPath = bibleJsonPath + ".gz";
if (!fs.existsSync(bibleJsonPath) && fs.existsSync(bibleGzPath)) {
  fs.writeFileSync(bibleJsonPath, require("zlib").gunzipSync(fs.readFileSync(bibleGzPath)));
}

const MODE_HINTS = {
  estudo: "[O usuário escolheu o MÓDULO DE ESTUDO — use o FLUXO 1]\n",
  duvida: "[O usuário escolheu o MINI-CHAT DE DÚVIDAS — use o FLUXO 2]\n",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) reject(new Error("Requisição muito grande"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleChat(req, res) {
  if (!API_KEY) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("GEMINI_API_KEY não configurada no servidor (.env).");
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("JSON inválido.");
  }

  const history = Array.isArray(payload.messages) ? payload.messages.slice(-20) : [];
  if (!history.length) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Nenhuma mensagem enviada.");
  }

  // Texto bíblico de referência (Bíblia Livre) enviado pelo leitor do app
  const ctx = payload.context && typeof payload.context === "object" ? payload.context : null;
  const contextBlock = ctx && ctx.text
    ? `\n\n[TEXTO BÍBLICO DE REFERÊNCIA — ${String(ctx.ref || "").slice(0, 100)} — Bíblia Livre (BLIVRE)]\n` +
      String(ctx.text).slice(0, 30000) +
      "\n[FIM DO TEXTO DE REFERÊNCIA]"
    : "";

  const contents = history.map((m, i) => {
    let text = String(m.text || "").slice(0, 8000);
    if (i === history.length - 1 && m.role === "user") {
      if (MODE_HINTS[payload.mode]) text = MODE_HINTS[payload.mode] + text;
      text += contextBlock;
    }
    return { role: m.role === "model" ? "model" : "user", parts: [{ text }] };
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
      }),
    });
  } catch (err) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Não foi possível conectar à API do Gemini: " + err.message);
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    console.error("Erro Gemini:", upstream.status, detail);
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(`Erro da API do Gemini (${upstream.status}). Veja o console do servidor.`);
  }

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });

  // Converte o SSE do Gemini em texto puro transmitido ao navegador
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        try {
          const json = JSON.parse(line.slice(5));
          const parts = json.candidates?.[0]?.content?.parts || [];
          const text = parts.map((p) => p.text || "").join("");
          if (text) res.write(text);
        } catch {
          /* linha incompleta — ignora */
        }
      }
    }
  } catch (err) {
    console.error("Erro no streaming:", err);
  }
  res.end();
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  const type = MIME[path.extname(filePath)] || "application/octet-stream";
  const isBible = filePath.startsWith(path.join(PUBLIC_DIR, "bible"));
  const cache = isBible ? "public, max-age=604800" : "no-cache";

  // Usa a versão pré-compactada (.gz) quando existir e o navegador aceitar
  const gzPath = filePath + ".gz";
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "") && fs.existsSync(gzPath)) {
    res.writeHead(200, { "Content-Type": type, "Content-Encoding": "gzip", "Cache-Control": cache, Vary: "Accept-Encoding" });
    return fs.createReadStream(gzPath).pipe(res);
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Não encontrado");
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, model: MODEL, apiKey: Boolean(API_KEY) }));
    }
    if (req.method === "GET") return serveStatic(req, res);
    res.writeHead(405);
    res.end();
  })
  .listen(PORT, "0.0.0.0", () => {
    const nets = require("os").networkInterfaces();
    const ipv4s = Object.values(nets)
      .flat()
      .filter((n) => n && n.family === "IPv4" && !n.internal)
      .map((n) => n.address);
    const lan = ipv4s.find((ip) => ip.startsWith("192.168.") || ip.startsWith("10.")) || ipv4s[0];
    console.log(`\n📖 Mestre Pastoral rodando:`);
    console.log(`   Computador: http://localhost:${PORT}`);
    if (lan) console.log(`   Celular (mesmo Wi-Fi): http://${lan}:${PORT}`);
    console.log(`   Modelo: ${MODEL} | Chave da API: ${API_KEY ? "OK" : "FALTANDO (.env)"}\n`);
  });
