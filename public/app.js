// Mestre Pastoral — núcleo do app (navegação, chat com o Mestre)
const $ = (s) => document.querySelector(s);
const chatEl = $("#chat");
const welcomeEl = $("#welcome");
const form = $("#composer");
const input = $("#input");
const sendBtn = $("#send");

const STORAGE_KEY = "mestre-pastoral:v1";
const VIEW_KEY = "mestre-pastoral:view";

const MODES = {
  estudo: {
    placeholder: 'Ex.: João 4, ou o tema "Fé"',
    welcome:
      "Puxe uma cadeira e vamos abrir a Palavra juntos. Diga um capítulo ou tema e eu preparo o estudo e um esboço para pregação.",
    suggestions: ["João 4", "Salmo 23", "O tema Fé", "Romanos 8", "A vida de Davi"],
  },
  duvida: {
    placeholder: "Cole um versículo e pergunte: o que isso quer dizer?",
    welcome:
      "Ficou com alguma dúvida num trecho? Cole o versículo aqui, ou selecione-o na aba Bíblia e toque em “Me explica”.",
    suggestions: [
      "O que quer dizer Romanos 3:25 — “propiciação pela fé no seu sangue”?",
      "Me explica Tiago 2:26: “a fé sem obras é morta”",
      "O que significa Mateus 5:3, “bem-aventurados os pobres de espírito”?",
    ],
  },
};

let state = loadState();
let busy = false;

// ---------- Persistência ----------
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && Array.isArray(s.messages)) return s;
  } catch {}
  return { mode: "estudo", messages: [] };
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- Utilidades ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2000);
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copiado ✅");
  } catch {
    toast("Não foi possível copiar");
  }
}

// ---------- Navegação entre abas ----------
const VIEWS = ["home", "bible", "harpa", "chat", "search", "favs", "oferta"];
const viewHooks = {}; // bible.js registra callbacks ao entrar em cada aba
function setView(name) {
  if (!VIEWS.includes(name)) name = "home";
  for (const v of VIEWS) $("#view-" + v).hidden = v !== name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $("#newChat").hidden = name !== "chat";
  localStorage.setItem(VIEW_KEY, name);
  viewHooks[name]?.();
}
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => setView(t.dataset.view)));
$("#brandHome")?.addEventListener("click", () => setView("home"));
$("#topOfertaBtn")?.addEventListener("click", () => setView("oferta"));
$("#topFavsBtn")?.addEventListener("click", () => setView("favs"));

// ---------- Markdown leve (seguro: escapa HTML antes) ----------
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*)_/g, "$1<em>$2</em>");
}
function renderMarkdown(md) {
  const lines = escapeHtml(md).split(/\r?\n/);
  let html = "";
  let list = null; // "ul" | "ol"
  let para = [];

  const flushPara = () => {
    if (para.length) html += `<p>${inline(para.join("<br>"))}</p>`;
    para = [];
  };
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); closeList();
      const lvl = Math.min(Math.max(m[1].length, 2), 4);
      html += `<h${lvl}>${inline(m[2])}</h${lvl}>`;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); closeList(); html += "<hr>"; continue; }
    if ((m = line.match(/^\s*&gt;\s?(.*)$/))) { flushPara(); closeList(); html += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flushPara();
      if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(m[1])}</li>`;
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(m[1])}</li>`;
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) { // continuação de item de lista
      html = html.replace(/<\/li>$/, `<br>${inline(line.trim())}</li>`);
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara(); closeList();
  // Transforma referências bíblicas em links para o leitor (definido em bible.js)
  return typeof linkifyRefs === "function" ? linkifyRefs(html) : html;
}

// ---------- Chat ----------
function setMode(mode) {
  if (!MODES[mode]) mode = "estudo";
  state.mode = mode;
  saveState();
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  input.placeholder = MODES[mode].placeholder;
  $("#welcomeText").textContent = MODES[mode].welcome;
  const sug = $("#suggestions");
  sug.innerHTML = "";
  for (const s of MODES[mode].suggestions) {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.textContent = s;
    b.onclick = () => send(s);
    sug.appendChild(b);
  }
}

function addMessage(role, text, { error = false } = {}) {
  welcomeEl.hidden = true;
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble" + (error ? " error" : "");
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  updateBubble(bubble, role, text);
  return bubble;
}

function updateBubble(bubble, role, text) {
  if (role === "user") bubble.textContent = text;
  else bubble.innerHTML = renderMarkdown(text);
}

function addActions(bubble, text) {
  const bar = document.createElement("div");
  bar.className = "actions";
  const copy = document.createElement("button");
  copy.textContent = "📋 Copiar";
  copy.onclick = () => copyText(text);
  const share = document.createElement("button");
  share.textContent = "📤 Compartilhar";
  share.onclick = () => {
    if (navigator.share) navigator.share({ title: "Mestre Pastoral", text }).catch(() => {});
    else window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank");
  };
  bar.append(copy, share);
  bubble.appendChild(bar);
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function renderAll() {
  chatEl.querySelectorAll(".msg").forEach((n) => n.remove());
  welcomeEl.hidden = state.messages.length > 0;
  for (const m of state.messages) {
    const b = addMessage(m.role, m.text);
    if (m.role === "model") addActions(b, m.text);
  }
  scrollToBottom();
}

// Links de referência bíblica nas respostas → abre no leitor
chatEl.addEventListener("click", (e) => {
  const a = e.target.closest("a.bref");
  if (!a) return;
  e.preventDefault();
  if (typeof openInReader === "function") {
    openInReader(Number(a.dataset.b), Number(a.dataset.c), a.dataset.v ? Number(a.dataset.v) : null,
      a.dataset.v2 ? Number(a.dataset.v2) : null);
  }
});

/**
 * Envia uma mensagem ao Mestre Pastoral.
 * @param {string} text  mensagem do usuário
 * @param {object} [opts]
 * @param {{ref:string,text:string}} [opts.context] texto bíblico de referência (Bíblia Livre)
 */
async function send(text, opts = {}) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  sendBtn.disabled = true;
  input.value = "";
  autoResize();

  state.messages.push({ role: "user", text });
  saveState();
  addMessage("user", text);

  const bubble = addMessage("model", "");
  bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  scrollToBottom();

  let answer = "";
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: state.mode, messages: state.messages, context: opts.context || null }),
    });
    if (!res.ok) throw new Error(await res.text());

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const nearBottom = () => chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      answer += decoder.decode(value, { stream: true });
      const stick = nearBottom();
      updateBubble(bubble, "model", answer);
      if (stick) scrollToBottom();
    }
    if (!answer.trim()) throw new Error("A resposta veio vazia. Tente novamente.");

    state.messages.push({ role: "model", text: answer });
    saveState();
    addActions(bubble, answer);
  } catch (err) {
    bubble.classList.add("error");
    bubble.innerHTML = renderMarkdown(
      "**Desculpe, meu irmão(ã), algo deu errado na conexão.**\n\n" + (err.message || err)
    );
    // remove a pergunta sem resposta do histórico para não confundir o contexto
    state.messages.pop();
    saveState();
  } finally {
    busy = false;
    sendBtn.disabled = false;
  }
}

/** Usado pelo leitor bíblico: vai para a aba Mestre, escolhe o modo e envia. */
function askMaster(text, mode, context) {
  if (busy) return toast("Aguarde o Mestre terminar a resposta atual 🙏");
  setView("chat");
  setMode(mode);
  send(text, { context });
}

function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}

// ---------- Eventos ----------
form.addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});
input.addEventListener("input", autoResize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(input.value);
  }
});
document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$("#newChat").onclick = () => {
  if (busy) return;
  if (state.messages.length && !confirm("Começar uma nova conversa? A atual será apagada.")) return;
  state.messages = [];
  saveState();
  renderAll();
};
viewHooks.chat = () => scrollToBottom();

// ---------- Registro do Service Worker e Limpeza de Cache Antigo ----------
if ("caches" in window) {
  caches.keys().then((keys) => {
    keys.filter((k) => k !== "mestre-pastoral-v6").forEach((k) => caches.delete(k));
  }).catch(() => {});
}
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js?v=15", { updateViaCache: "none" })
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {});
  });
}

let deferredInstallPrompt = null;
const installBtn = $("#installApp");
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (installBtn) installBtn.hidden = false;
});
if (installBtn) {
  installBtn.onclick = async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === "accepted") installBtn.hidden = true;
    deferredInstallPrompt = null;
  };
}
window.addEventListener("appinstalled", () => {
  if (installBtn) installBtn.hidden = true;
  deferredInstallPrompt = null;
  toast("Aplicativo instalado com sucesso! 🙌");
});

setMode(state.mode);
renderAll();
