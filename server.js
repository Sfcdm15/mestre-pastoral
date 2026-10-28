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
const PRIMARY_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const MODEL_FALLBACK_LIST = [
  PRIMARY_MODEL,
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
].filter((m, i, arr) => arr.indexOf(m) === i);

const ADMIN_PIN = process.env.ADMIN_PIN || "pastor2026";
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "prompt.md"), "utf8");
const PUBLIC_DIR = path.join(__dirname, "public");
const OFERTA_DIR = path.join(__dirname, "OFERTA");
const OFERTA_FILE = path.join(OFERTA_DIR, "config.json");

// Descompacta blivre.json e harpa.json automaticamente se apenas o .gz tiver sido enviado ao servidor
for (const name of ["blivre.json", "harpa.json"]) {
  const jsonPath = path.join(PUBLIC_DIR, "bible", name);
  const gzPath = jsonPath + ".gz";
  if (!fs.existsSync(jsonPath) && fs.existsSync(gzPath)) {
    fs.writeFileSync(jsonPath, require("zlib").gunzipSync(fs.readFileSync(gzPath)));
  }
}

const MODE_HINTS = {
  estudo: "[O usuário escolheu o MÓDULO DE ESTUDO — use o FLUXO 1]\n",
  duvida: "[O usuário escolheu o MINI-CHAT DE DÚVIDAS — use o FLUXO 2]\n",
  cifra: "[O usuário solicitou a CIFRA MUSICAL deste hino da Harpa Cristã — use o FLUXO 3: informe o Tom, a Intro e a letra cifrada completa]\n",
  louvor: "[O usuário solicitou a MÚSICA COMPLETA DE LOUVOR PARA A BANDA DA IGREJA — use o FLUXO 4: Forneça a música 100% COMPLETA e integral do início ao fim (todas as estrofes, todos os refrões repetidos por extenso, todas as pontes e finalização, sem cortes, sem resumos e sem atalhos como '(repete)' ou '2x') em [METADADOS], [LETRA] e [CIFRA]]\n",
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

  let upstream = null;
  let lastStatus = 502;
  let lastErrorDetail = "";
  let activeModel = PRIMARY_MODEL;

  for (let i = 0; i < MODEL_FALLBACK_LIST.length; i++) {
    const candidateModel = MODEL_FALLBACK_LIST[i];
    const isGemma = candidateModel.toLowerCase().startsWith("gemma");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${candidateModel}:streamGenerateContent?alt=sse`;

    let requestBody;
    if (isGemma) {
      const gemmaContents = contents.map((c) => ({
        role: c.role,
        parts: c.parts.map((p) => ({ ...p })),
      }));
      if (gemmaContents.length > 0 && gemmaContents[0].role === "user") {
        gemmaContents[0].parts[0].text = `[DIRETRIZES DE PASTOR/ESTUDO BÍBLICO]\n${SYSTEM_PROMPT}\n[FIM DAS DIRETRIZES]\n\n${gemmaContents[0].parts[0].text || ""}`;
      } else {
        gemmaContents.unshift({
          role: "user",
          parts: [{ text: `[DIRETRIZES DE PASTOR/ESTUDO BÍBLICO]\n${SYSTEM_PROMPT}\n[FIM DAS DIRETRIZES]` }],
        });
      }
      requestBody = {
        contents: gemmaContents,
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
      };
    } else {
      requestBody = {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
      };
    }

    try {
      const resAttempt = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
        body: JSON.stringify(requestBody),
      });

      if (resAttempt.ok) {
        upstream = resAttempt;
        activeModel = candidateModel;
        if (i > 0) {
          console.log(`[Rodízio IA] Alternado em milissegundos para ${candidateModel} (modelo anterior esgotado/ocupado).`);
        }
        break;
      }

      lastStatus = resAttempt.status;
      lastErrorDetail = await resAttempt.text();
      console.warn(`[Rodízio IA] Modelo ${candidateModel} retornou status ${resAttempt.status}. Alternando para o próximo...`);
    } catch (err) {
      lastStatus = 502;
      lastErrorDetail = err.message;
      console.warn(`[Rodízio IA] Falha de conexão com ${candidateModel}: ${err.message}. Alternando para o próximo...`);
    }
  }

  if (!upstream || !upstream.ok) {
    console.error("Todos os modelos da fila falharam:", lastStatus, lastErrorDetail);
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(`Erro da API (${lastStatus}). Todos os 6 modelos de rodízio foram testados.`);
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

function loadOfertaConfig() {
  try {
    if (fs.existsSync(OFERTA_FILE)) {
      return JSON.parse(fs.readFileSync(OFERTA_FILE, "utf8"));
    }
  } catch {}
  return {
    title: "Ajude Famílias e Mantenha Esta Obra no Ar",
    subtitle:
      "Sua oferta de amor transforma vidas através de cestas básicas para famílias necessitadas e mantém o Mestre Pastoral gratuito e ativo para todos.",
    pixKey: process.env.OFERTA_PIX_KEY || "",
    pixType: "Chave PIX (Nubank)",
    pixHolder: process.env.OFERTA_PIX_HOLDER || "",
    pixBank: process.env.OFERTA_PIX_BANK || "Nubank",
    pixCity: "SAO PAULO",
    paymentLink: process.env.OFERTA_PAYMENT_LINK || "",
    autoRedirect: false,
    goalText: "Arrecadação de cestas básicas para famílias carentes e custeio do servidor do aplicativo.",
  };
}

async function handleOferta(req, res) {
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(JSON.stringify(loadOfertaConfig()));
  }
  if (req.method === "POST") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("JSON inválido.");
    }
    if (String(body.pin || "").trim() !== ADMIN_PIN) {
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Senha de administrador incorreta.");
    }
    if (body.checkOnly) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, config: loadOfertaConfig() }));
    }
    const current = loadOfertaConfig();
    const updated = {
      title: String(body.title ?? current.title).slice(0, 140),
      subtitle: String(body.subtitle ?? current.subtitle).slice(0, 400),
      pixKey: String(body.pixKey ?? current.pixKey).trim().slice(0, 140),
      pixType: String(body.pixType ?? current.pixType).trim().slice(0, 60),
      pixHolder: String(body.pixHolder ?? current.pixHolder).trim().slice(0, 80),
      pixBank: String(body.pixBank ?? current.pixBank).trim().slice(0, 60),
      pixCity: String(body.pixCity ?? current.pixCity).trim().slice(0, 40),
      paymentLink: String(body.paymentLink ?? current.paymentLink).trim().slice(0, 500),
      autoRedirect: Boolean(body.autoRedirect),
      goalText: String(body.goalText ?? current.goalText).trim().slice(0, 300),
    };
    fs.mkdirSync(OFERTA_DIR, { recursive: true });
    fs.writeFileSync(OFERTA_FILE, JSON.stringify(updated, null, 2));
    try {
      const mirrorDir = path.join(__dirname, "enviar-para-github", "OFERTA");
      if (fs.existsSync(path.join(__dirname, "enviar-para-github"))) {
        fs.mkdirSync(mirrorDir, { recursive: true });
        fs.writeFileSync(path.join(mirrorDir, "config.json"), JSON.stringify(updated, null, 2));
      }
    } catch {}
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, config: updated }));
  }
  res.writeHead(405);
  res.end();
}

function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/\u200B/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function isChordToken(tok) {
  return /^[A-G][#b]?(?:m|maj|min|dim|aug|sus|add|7M|7|9|11|13|6|5|4|2|M|\d|[+\-\/()])*$/.test(tok);
}

function extractLyricsFromCifra(cifraText) {
  const lines = String(cifraText || "").split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (/^\[(Tom|Intro|Tab|Solo|Capotraste|Acordes)/i.test(trimmed)) continue;
    if (/^[EBGDAEebgdae]\|[-0-9hpb/~\s|xX]+/.test(trimmed)) continue;
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      out.push(trimmed);
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    const isChordLine = tokens.every((t) => isChordToken(t) || t === "|" || t === "/" || /^\(\d+x\)$/i.test(t));
    if (!isChordLine) {
      out.push(trimmed);
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function resolveCompleteSong(rawInput) {
  const url = String(rawInput || "").trim();
  let youtubeId = null;
  let artist = "";
  let title = "";
  let ccArtistSlug = "";
  let ccSongSlug = "";

  // 1. Check if YouTube URL
  const ytMatch = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
  if (ytMatch) {
    youtubeId = ytMatch[1];
    try {
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${youtubeId}&format=json`, {
        signal: AbortSignal.timeout(4000),
      });
      if (oembedRes.ok) {
        const data = await oembedRes.json();
        title = data.title || "";
        artist = (data.author_name || "")
          .replace(/\s*-\s*Topic$/i, "")
          .replace(/\s*(?:Oficial|VEVO|Music)$/i, "")
          .trim();
      }
    } catch {}

    if (title.includes(" - ")) {
      const parts = title.split(" - ");
      artist = parts[0].trim();
      title = parts.slice(1).join(" - ");
    }
    title = title
      .replace(/\s*[\(\[][^\)\]]*(?:oficial|official|clipe|video|vídeo|ao vivo|live|remaster|lyric|áudio|audio|hd|4k|dvd)[^\)\]]*[\)\]]/gi, "")
      .replace(/\s*-\s*(?:ao vivo|clipe oficial|vídeo oficial|oficial).*$/gi, "")
      .trim();
  }

  // 2. Check if Cifra Club URL
  const ccMatch = url.match(/cifraclub\.com\.br\/([^\/\?#]+)\/([^\/\?#]+)/i);
  if (ccMatch) {
    ccArtistSlug = ccMatch[1];
    ccSongSlug = ccMatch[2];
    const formatSlug = (s) =>
      s
        .split("-")
        .map((w) => (["e", "de", "da", "do", "das", "dos", "em", "para", "com", "a", "o"].includes(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(" ");
    artist = formatSlug(ccArtistSlug);
    title = formatSlug(ccSongSlug);
  }

  const searchQuery = title ? (artist ? `${artist} ${title}` : title) : url;

  // 3. Search Cifra Club Solr if we don't have exact slugs
  if (!ccArtistSlug || !ccSongSlug) {
    try {
      const solrRes = await fetch(`https://solr.sscdn.co/cc/h2/?q=${encodeURIComponent(searchQuery)}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (solrRes.ok) {
        const text = await solrRes.text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          const docs = data?.response?.docs || [];
          const songDoc = docs.find((d) => d.t === "2" && d.d && d.u);
          if (songDoc) {
            ccArtistSlug = songDoc.d;
            ccSongSlug = songDoc.u;
            if (!title) title = songDoc.m || "";
            if (!artist) artist = songDoc.a || "";
          }
        }
      }
    } catch {}
  }

  // 4. Fetch Cifra Club page if slugs found
  let cifraText = "";
  let tom = "G";
  let capo = "";
  if (ccArtistSlug && ccSongSlug) {
    try {
      const ccUrl = `https://www.cifraclub.com.br/${ccArtistSlug}/${ccSongSlug}/`;
      const ccRes = await fetch(ccUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(5000),
      });
      if (ccRes.ok) {
        const html = await ccRes.text();
        const pageTitleMatch = html.match(/<title>([^<]+?)\s+-\s+([^<]+?)\s+-\s+Cifra Club<\/title>/i);
        if (pageTitleMatch) {
          title = decodeHtmlEntities(pageTitleMatch[1]).trim();
          artist = decodeHtmlEntities(pageTitleMatch[2]).trim();
        }
        const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
        if (preMatch) {
          let rawPre = preMatch[1]
            .replace(/<span class="tablatura">[\s\S]*?<\/span>/gi, "")
            .replace(/<[^>]+>/g, "");
          rawPre = decodeHtmlEntities(rawPre)
            .split(/\r?\n/)
            .filter((line) => !/^\[Tab\s*-/i.test(line.trim()) && !/^[EBGDAEebgdae]\|[-0-9hpb/~\s|xX]+/.test(line.trim()))
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();

          const tomInHtml = html.match(/cifra_tom[^>]*>[\s\S]*?<a[^>]*>([A-G][#b]?m?)<\/a>/i);
          if (tomInHtml) {
            tom = tomInHtml[1].trim();
          } else {
            const withoutTags = rawPre.replace(/\[[^\]]*\]/g, "");
            const firstChord = withoutTags.match(/\b([A-G][#b]?m?)(?:7M|7|9|11|13|6|4|2|sus|dim|aug|add|\/|\s|$)/);
            if (firstChord) tom = firstChord[1];
          }

          cifraText = `[Tom: ${tom}]\n\n` + rawPre;
        }
        if (!youtubeId) {
          const ytInCc = html.match(/ytimg\.com\/vi\/([a-zA-Z0-9_-]{11})/i);
          if (ytInCc) youtubeId = ytInCc[1];
        }
      }
    } catch {}
  }

  // 5. Fetch Official Lyrics from Letras.mus.br Solr + Page
  let lyricsText = "";
  try {
    const lQuery = title ? `${artist} ${title}` : searchQuery;
    const lSolrRes = await fetch(`https://solr.sscdn.co/letras/m1/?q=${encodeURIComponent(lQuery)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (lSolrRes.ok) {
      const lText = await lSolrRes.text();
      const lJsonMatch = lText.match(/\{[\s\S]*\}/);
      if (lJsonMatch) {
        const lData = JSON.parse(lJsonMatch[0]);
        const lDoc = (lData?.response?.docs || []).find((d) => d.t === "2" && d.dns && d.url);
        if (lDoc) {
          if (!title) title = lDoc.txt || "";
          if (!artist) artist = lDoc.art || "";
          const lPageRes = await fetch(`https://www.letras.mus.br/${lDoc.dns}/${lDoc.url}/`, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(4000),
          });
          if (lPageRes.ok) {
            const lHtml = await lPageRes.text();
            const lyricDiv = lHtml.match(/<div class="lyric-original[^"]*">([\s\S]*?)<\/div>/i);
            if (lyricDiv) {
              lyricsText = decodeHtmlEntities(
                lyricDiv[1]
                  .replace(/<\/p>/gi, "\n\n")
                  .replace(/<br\s*\/?>/gi, "\n")
                  .replace(/<[^>]+>/g, "")
              ).trim();
            }
          }
        }
      }
    }
  } catch {}

  if (!lyricsText && cifraText) {
    lyricsText = extractLyricsFromCifra(cifraText);
  }

  // 6. Find YouTube video ID if still missing
  if (!youtubeId && (title || searchQuery)) {
    try {
      const ytQ = encodeURIComponent(title ? `${artist} ${title}` : searchQuery);
      const ytRes = await fetch(`https://www.youtube.com/results?search_query=${ytQ}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(4000),
      });
      if (ytRes.ok) {
        const ytHtml = await ytRes.text();
        const vidMatch = ytHtml.match(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
        if (vidMatch) youtubeId = vidMatch[1];
      }
    } catch {}
  }

  return {
    foundCifra: Boolean(cifraText),
    foundLyrics: Boolean(lyricsText),
    title: title || searchQuery,
    artist: artist || "Ministério de Louvor",
    youtubeId,
    tom,
    capo,
    lyrics: lyricsText,
    cifra: cifraText,
    query: title ? (artist ? `${artist} - ${title}` : title) : searchQuery,
  };
}

async function handleResolveLink(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "JSON inválido." }));
  }

  const rawUrl = String(body.url || body.query || "").trim();
  if (!rawUrl) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "URL ou busca não informada." }));
  }

  try {
    const resolved = await resolveCompleteSong(rawUrl);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(resolved));
  } catch (err) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ foundCifra: false, foundLyrics: false, query: rawUrl }));
  }
}

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
    if (req.method === "POST" && req.url === "/api/resolve-link") return handleResolveLink(req, res);
    if (req.url === "/api/oferta") return handleOferta(req, res);
    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, primaryModel: PRIMARY_MODEL, models: MODEL_FALLBACK_LIST, apiKey: Boolean(API_KEY) }));
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
    console.log(`   Modelos (Fila de 6 com Rodízio): ${MODEL_FALLBACK_LIST.join(" -> ")}`);
    console.log(`   Chave da API: ${API_KEY ? "OK" : "FALTANDO (.env)"}\n`);
  });
