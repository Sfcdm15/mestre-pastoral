// Mestre Pastoral — Bíblia (leitor AT/NT, busca, favoritos, links de referência)
// Texto: Bíblia Livre (BLIVRE) — CC BY 4.0 Brasil — Diego Santos, Mario Sérgio e Marco Teles
const POS_KEY = "mestre-pastoral:pos";
const FAV_KEY = "mestre-pastoral:favs";

let BIBLE = null;           // { meta, books: [{name, abbr, testament, chapters: [[verso, ...], ...]}] }
let pos = loadJSON(POS_KEY, { b: 42, c: 3 }); // padrão: João 3
let selected = new Set();   // números dos versículos selecionados no capítulo atual
let favs = loadJSON(FAV_KEY, []); // ["b.c.v", ...] (mais recentes primeiro)
let pickerTestament = "AT";
let searchIndex = null;     // textos normalizados para busca
let refRegex = null;        // regex para detectar referências nas respostas do Mestre
const nameLookup = new Map(); // variante do nome → índice do livro

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
const saveFavs = () => localStorage.setItem(FAV_KEY, JSON.stringify(favs));
const savePos = () => localStorage.setItem(POS_KEY, JSON.stringify(pos));

// ---------- Referências ----------
function compressVerses(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
    i = j;
  }
  return parts.join(",");
}
function refLabel(b, c, verses) {
  const name = BIBLE.books[b].name;
  return verses && verses.length ? `${name} ${c}:${compressVerses(verses)}` : `${name} ${c}`;
}
const verseText = (b, c, v) => BIBLE.books[b]?.chapters[c - 1]?.[v - 1] ?? "";

// Remove acentos mantendo o mesmo tamanho do texto (para destacar resultados)
function norm(s) {
  let out = "";
  for (const ch of s) out += ch.normalize("NFD")[0].toLowerCase();
  return out;
}
const stripAccents = (s) => s.normalize("NFD").replace(/\p{M}/gu, "");

function buildNameIndex() {
  const romans = ["I", "II", "III"];
  const variants = []; // [texto, índiceLivro, éAbreviação]
  BIBLE.books.forEach((bk, i) => {
    const forms = new Set([bk.name]);
    const m = bk.name.match(/^(\d) (.+)$/);
    if (m) {
      forms.add(m[1] + m[2]).add(`${m[1]}º ${m[2]}`).add(`${m[1]}ª ${m[2]}`).add(`${romans[m[1] - 1]} ${m[2]}`);
    }
    if (bk.name === "Salmos") forms.add("Salmo");
    if (bk.name === "Cantares") forms.add("Cânticos").add("Cântico dos Cânticos").add("Cantares de Salomão");
    if (bk.name === "Atos") forms.add("Atos dos Apóstolos");
    for (const f of [...forms]) forms.add(stripAccents(f));
    forms.forEach((f) => variants.push([f, i, false]));

    const abbrs = new Set([bk.abbr, stripAccents(bk.abbr)]);
    const ma = bk.abbr.match(/^(\d)(.+)$/);
    if (ma) abbrs.add(`${ma[1]} ${ma[2]}`);
    abbrs.forEach((a) => variants.push([a, i, true]));
  });
  for (const [v, i] of variants) nameLookup.set(stripAccents(v).toLowerCase().replace(/\s+/g, ""), i);

  // Nomes completos aceitam "João 4"; abreviações exigem versículo ("Jo 4:1") para evitar falsos positivos
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s");
  const alt = (list) => [...new Set(list)].sort((a, b) => b.length - a.length).map(esc).join("|");
  const full = alt(variants.filter((v) => !v[2]).map((v) => v[0]));
  const abbr = alt(variants.filter((v) => v[2]).map((v) => v[0]));
  const verse = String.raw`[:.](\d{1,3})(?:\s?[-–]\s?(\d{1,3}))?`;
  refRegex = new RegExp(
    String.raw`(?<![\p{L}\d])(?:(${full})\s(\d{1,3})(?:${verse})?|(${abbr})\.?\s?(\d{1,3})${verse})(?![\p{L}\d])`,
    "gu"
  );
}

function bookFromName(name) {
  const key = stripAccents(name).toLowerCase().replace(/[\s.]+/g, "");
  return nameLookup.has(key) ? nameLookup.get(key) : -1;
}

/** Converte "jo 3:16", "Gênesis 1", "1co 13.4-7" em {b, c, v, v2} — ou null */
function parseRef(q) {
  if (!BIBLE) return null;
  const m = q.trim().match(/^((?:[1-3]\s?)?[\p{L}][\p{L}\s.]*?)\s*(\d{1,3})(?:\s*[:.\s]\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?)?$/u);
  if (!m) return null;
  const b = bookFromName(m[1]);
  if (b < 0) return null;
  const c = Number(m[2]);
  const ch = BIBLE.books[b].chapters[c - 1];
  if (!ch) return null;
  const v = m[3] ? Number(m[3]) : null;
  if (v && !ch[v - 1]) return null;
  const v2 = m[4] && Number(m[4]) > v ? Math.min(Number(m[4]), ch.length) : null;
  return { b, c, v, v2 };
}

/** Usado por app.js: transforma referências do texto (HTML já escapado) em links clicáveis */
function linkifyRefs(html) {
  if (!refRegex) return html;
  return html
    .split(/(<[^>]+>)/)
    .map((part) =>
      part.startsWith("<")
        ? part
        : part.replace(refRegex, (match, fName, fC, fV, fV2, aName, aC, aV, aV2) => {
            const b = bookFromName(fName || aName);
            const c = Number(fC || aC);
            const v = fV || aV ? Number(fV || aV) : null;
            const v2 = fV2 || aV2 ? Number(fV2 || aV2) : null;
            const ch = BIBLE.books[b]?.chapters[c - 1];
            if (!ch || (v && !ch[v - 1])) return match;
            return `<a class="bref" href="#" data-b="${b}" data-c="${c}"${v ? ` data-v="${v}"` : ""}${v2 ? ` data-v2="${v2}"` : ""}>${match}</a>`;
          })
    )
    .join("");
}

// ---------- Leitor ----------
const readerEl = $("#reader");

function renderReader() {
  if (!BIBLE) return;
  const bk = BIBLE.books[pos.b];
  const verses = bk.chapters[pos.c - 1];
  selected.clear();
  updateSelBar();

  $("#curRef").textContent = `${bk.name} ${pos.c}`;
  $("#prevCh").disabled = pos.b === 0 && pos.c === 1;
  $("#nextCh").disabled = pos.b === BIBLE.books.length - 1 && pos.c === bk.chapters.length;

  const favSet = new Set(favs);
  let html = `<h2>${escapeHtml(bk.name)} ${pos.c}</h2>
    <div class="testament">${bk.testament === "AT" ? "Antigo Testamento" : "Novo Testamento"} · Bíblia Livre</div>`;
  verses.forEach((t, i) => {
    if (!t) return;
    const v = i + 1;
    const fav = favSet.has(`${pos.b}.${pos.c}.${v}`) ? " fav" : "";
    html += `<p class="verse${fav}" data-v="${v}"><sup>${v}</sup>${escapeHtml(t)}</p>`;
  });
  html += `<div class="chapter-nav">
      <button data-go="-1" ${$("#prevCh").disabled ? "hidden" : ""}>‹ Anterior</button>
      <button data-go="1" ${$("#nextCh").disabled ? "hidden" : ""}>Próximo ›</button>
    </div>
    <p class="credits">Texto bíblico: <strong>${BIBLE.meta.name}</strong> (BLIVRE), ${BIBLE.meta.version}.<br>
      ${BIBLE.meta.copyright}.<br>
      <a href="${BIBLE.meta.licenseUrl}" target="_blank" rel="noopener">${BIBLE.meta.license}</a> ·
      <a href="${BIBLE.meta.source}" target="_blank" rel="noopener">fonte</a></p>`;
  readerEl.innerHTML = html;
  readerEl.scrollTop = 0;
  savePos();
}

function goChapter(delta) {
  let { b, c } = pos;
  c += delta;
  if (c < 1) {
    if (b === 0) return;
    b--; c = BIBLE.books[b].chapters.length;
  } else if (c > BIBLE.books[b].chapters.length) {
    if (b === BIBLE.books.length - 1) return;
    b++; c = 1;
  }
  pos = { b, c };
  renderReader();
}

/** Abre o leitor em um livro/capítulo e destaca os versículos (usado por links, busca e favoritos) */
function openInReader(b, c, v = null, v2 = null) {
  if (!BIBLE) return;
  setView("bible");
  if (pos.b !== b || pos.c !== c || !readerEl.querySelector(".verse")) {
    pos = { b, c };
    renderReader();
  }
  if (!v) return;
  const last = v2 || v;
  requestAnimationFrame(() => {
    for (let i = v; i <= last; i++) {
      const el = readerEl.querySelector(`.verse[data-v="${i}"]`);
      if (!el) continue;
      if (i === v) el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    }
  });
}

readerEl.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) return goChapter(Number(go.dataset.go));
  const p = e.target.closest(".verse");
  if (!p) return;
  const v = Number(p.dataset.v);
  if (selected.has(v)) selected.delete(v);
  else selected.add(v);
  p.classList.toggle("selected", selected.has(v));
  updateSelBar();
});

function updateSelBar() {
  const bar = $("#selBar");
  bar.hidden = selected.size === 0;
  if (!selected.size) return;
  $("#selInfo").textContent = refLabel(pos.b, pos.c, [...selected]);
  const allFav = [...selected].every((v) => favs.includes(`${pos.b}.${pos.c}.${v}`));
  $("#selFav").textContent = allFav ? "☆ Desfavoritar" : "⭐ Favoritar";
}

function selectedPassage() {
  const verses = [...selected].sort((a, b) => a - b);
  const ref = refLabel(pos.b, pos.c, verses);
  const plain = verses.map((v) => verseText(pos.b, pos.c, v)).join(" ");
  const numbered = verses.map((v) => `${v} ${verseText(pos.b, pos.c, v)}`).join("\n");
  return { verses, ref, plain, numbered };
}

function clearSelection() {
  selected.clear();
  readerEl.querySelectorAll(".verse.selected").forEach((el) => el.classList.remove("selected"));
  updateSelBar();
}

function explainPassage(ref, plain, numbered) {
  const shown = plain.length > 500 ? plain.slice(0, 500).trimEnd() + "…" : plain;
  askMaster(`Me explica ${ref}: “${shown}”`, "duvida", { ref, text: numbered });
}

$("#selExplain").onclick = () => {
  const { ref, plain, numbered } = selectedPassage();
  explainPassage(ref, plain, numbered);
  clearSelection();
};
$("#selCopy").onclick = () => {
  const { ref, plain } = selectedPassage();
  copyText(`“${plain}” — ${ref} (BLIVRE)`);
  clearSelection();
};
$("#selFav").onclick = () => {
  const keys = [...selected].map((v) => `${pos.b}.${pos.c}.${v}`);
  const allFav = keys.every((k) => favs.includes(k));
  if (allFav) favs = favs.filter((k) => !keys.includes(k));
  else favs = [...keys.filter((k) => !favs.includes(k)).reverse(), ...favs];
  saveFavs();
  for (const v of selected) {
    readerEl.querySelector(`.verse[data-v="${v}"]`)?.classList.toggle("fav", !allFav);
  }
  toast(allFav ? "Removido dos favoritos" : "Salvo nos favoritos ⭐");
  clearSelection();
};
$("#selClear").onclick = clearSelection;
$("#prevCh").onclick = () => goChapter(-1);
$("#nextCh").onclick = () => goChapter(1);
$("#studyCh").onclick = () => {
  if (!BIBLE) return;
  const ref = refLabel(pos.b, pos.c);
  const text = BIBLE.books[pos.b].chapters[pos.c - 1].map((t, i) => `${i + 1} ${t}`).join("\n");
  askMaster(ref, "estudo", { ref, text });
};

// Teclado: setas mudam de capítulo
document.addEventListener("keydown", (e) => {
  if ($("#view-bible").hidden || !$("#picker").hidden || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === "ArrowLeft") goChapter(-1);
  if (e.key === "ArrowRight") goChapter(1);
  if (e.key === "Escape") clearSelection();
});

// ---------- Seletor de livro/capítulo ----------
const picker = $("#picker");
const grid = $("#pickerGrid");

function showBooks() {
  $("#pickerTitle").textContent = "Escolha o livro";
  $("#pickerBack").hidden = true;
  $("#pickerTabs").hidden = false;
  document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.t === pickerTestament));
  grid.className = "picker-grid scroll";
  grid.innerHTML = "";
  BIBLE.books.forEach((bk, i) => {
    if (bk.testament !== pickerTestament) return;
    const btn = document.createElement("button");
    btn.className = i === pos.b ? "current" : "";
    btn.innerHTML = `${escapeHtml(bk.name)}<small>${bk.chapters.length} cap.</small>`;
    btn.onclick = () => (bk.chapters.length === 1 ? choose(i, 1) : showChapters(i));
    grid.appendChild(btn);
  });
  grid.scrollTop = 0;
}

function showChapters(b) {
  const bk = BIBLE.books[b];
  $("#pickerTitle").textContent = bk.name;
  $("#pickerBack").hidden = false;
  $("#pickerTabs").hidden = true;
  grid.className = "picker-grid chapters scroll";
  grid.innerHTML = "";
  bk.chapters.forEach((_, i) => {
    const btn = document.createElement("button");
    btn.textContent = i + 1;
    if (b === pos.b && i + 1 === pos.c) btn.className = "current";
    btn.onclick = () => choose(b, i + 1);
    grid.appendChild(btn);
  });
  grid.scrollTop = 0;
}

function choose(b, c) {
  picker.hidden = true;
  pos = { b, c };
  renderReader();
}

$("#openPicker").onclick = () => {
  if (!BIBLE) return;
  pickerTestament = BIBLE.books[pos.b].testament;
  picker.hidden = false;
  showBooks();
};
$("#pickerClose").onclick = () => (picker.hidden = true);
$("#pickerBack").onclick = showBooks;
document.querySelectorAll(".seg-btn").forEach((b) => (b.onclick = () => { pickerTestament = b.dataset.t; showBooks(); }));

// ---------- Busca ----------
const resultsEl = $("#searchResults");
const searchInput = $("#searchInput");
let searchTimer;

function ensureIndex() {
  if (searchIndex) return;
  searchIndex = [];
  BIBLE.books.forEach((bk, b) =>
    bk.chapters.forEach((vs, ci) => vs.forEach((t, vi) => t && searchIndex.push({ b, c: ci + 1, v: vi + 1, t, n: norm(t) })))
  );
}

function runSearch() {
  const q = searchInput.value.trim();
  const scope = $("#searchScope").value;
  if (!BIBLE) { resultsEl.innerHTML = `<p class="empty">Carregando a Bíblia…</p>`; return; }

  let html = "";
  const ref = parseRef(q);
  if (ref) {
    const label = refLabel(ref.b, ref.c, ref.v ? (ref.v2 ? range(ref.v, ref.v2) : [ref.v]) : null);
    html += `<button class="goto" data-b="${ref.b}" data-c="${ref.c}" data-v="${ref.v || ""}" data-v2="${ref.v2 || ""}">📖 Abrir ${escapeHtml(label)}</button>`;
  }
  const nq = norm(q);
  if (nq.length < 3) {
    resultsEl.innerHTML = html || `<p class="empty">Digite pelo menos 3 letras para buscar em toda a Bíblia.</p>`;
    return;
  }

  ensureIndex();
  const hits = [];
  for (const it of searchIndex) {
    if (scope !== "ALL" && BIBLE.books[it.b].testament !== scope) continue;
    if (it.n.includes(nq)) hits.push(it);
  }
  const MAX = 200;
  html += `<p class="count">${hits.length ? `${hits.length.toLocaleString("pt-BR")} versículo(s) encontrado(s)` : "Nenhum versículo encontrado."}${hits.length > MAX ? ` — mostrando os ${MAX} primeiros` : ""}</p>`;
  for (const it of hits.slice(0, MAX)) {
    html += `<div class="item" data-b="${it.b}" data-c="${it.c}" data-v="${it.v}">
      <div class="ref">${escapeHtml(refLabel(it.b, it.c, [it.v]))}</div>
      <div class="txt">${highlight(it.t, it.n, nq)}</div></div>`;
  }
  resultsEl.innerHTML = html;
  resultsEl.scrollTop = 0;
}

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function highlight(text, normText, nq) {
  let out = "", i = 0, idx;
  while ((idx = normText.indexOf(nq, i)) >= 0) {
    out += escapeHtml(text.slice(i, idx)) + "<mark>" + escapeHtml(text.slice(idx, idx + nq.length)) + "</mark>";
    i = idx + nq.length;
  }
  return out + escapeHtml(text.slice(i));
}

$("#searchForm").onsubmit = (e) => { e.preventDefault(); clearTimeout(searchTimer); runSearch(); };
searchInput.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); };
$("#searchScope").onchange = runSearch;
resultsEl.addEventListener("click", (e) => {
  const el = e.target.closest("[data-b]");
  if (!el) return;
  openInReader(Number(el.dataset.b), Number(el.dataset.c), Number(el.dataset.v) || null, Number(el.dataset.v2) || null);
});

// ---------- Favoritos ----------
const favEl = $("#favList");

function renderFavs() {
  if (!BIBLE) { favEl.innerHTML = `<p class="empty">Carregando a Bíblia…</p>`; return; }
  if (!favs.length) {
    favEl.innerHTML = `<p class="empty">Você ainda não marcou nenhum versículo.<br>Na aba <strong>Bíblia</strong>, toque em um versículo e escolha ⭐ Favoritar.</p>`;
    return;
  }
  favEl.innerHTML = `<p class="count">${favs.length} versículo(s) favorito(s)</p>` +
    favs.map((k) => {
      const [b, c, v] = k.split(".").map(Number);
      return `<div class="item" data-k="${k}">
        <div class="ref">${escapeHtml(refLabel(b, c, [v]))}</div>
        <div class="txt">${escapeHtml(verseText(b, c, v))}</div>
        <div class="item-actions">
          <button data-act="open">📖 Abrir</button>
          <button data-act="explain">💬 Me explica</button>
          <button data-act="copy">📋 Copiar</button>
          <button data-act="remove">🗑️ Remover</button>
        </div></div>`;
    }).join("");
}

favEl.addEventListener("click", (e) => {
  const item = e.target.closest(".item");
  if (!item) return;
  const k = item.dataset.k;
  const [b, c, v] = k.split(".").map(Number);
  const act = e.target.closest("[data-act]")?.dataset.act || "open";
  const ref = refLabel(b, c, [v]);
  const t = verseText(b, c, v);
  if (act === "open") openInReader(b, c, v);
  if (act === "explain") explainPassage(ref, t, `${v} ${t}`);
  if (act === "copy") copyText(`“${t}” — ${ref} (BLIVRE)`);
  if (act === "remove") {
    favs = favs.filter((x) => x !== k);
    saveFavs();
    renderFavs();
    toast("Removido dos favoritos");
  }
});

// ---------- Página Inicial (Home) ----------
const DAILY_VERSES = [
  { b: 18, c: 119, v: 105, fallback: "Lâmpada para os meus pés é a tua palavra, e luz para o meu caminho." },
  { b: 18, c: 23, v: 1, fallback: "O SENHOR é meu pastor, nada me faltará." },
  { b: 42, c: 3, v: 16, fallback: "Porque Deus amou ao mundo de tal maneira, que deu o seu Filho unigênito; para que todo aquele que nele crê não pereça, mas tenha a vida eterna." },
  { b: 44, c: 8, v: 28, fallback: "E sabemos que todas as coisas contribuem juntamente para o bem daqueles que amam a Deus, daqueles que são chamados por seu decreto." },
  { b: 22, c: 40, v: 31, fallback: "Mas os que esperam no SENHOR renovarão suas forças; subirão com asas como águias; correrão, e não se cansarão; caminharão, e não se fatigarão." },
  { b: 5, c: 1, v: 9, fallback: "Não te mandei eu? Esforça-te, e tem bom ânimo; não temas, nem te espantes; porque o SENHOR teu Deus é contigo, por onde quer que andares." },
  { b: 49, c: 4, v: 6, fallback: "Não estejais inquietos por coisa alguma; antes as vossas petições sejam em tudo conhecidas diante de Deus pela oração e súplica, com ação de graças." },
  { b: 19, c: 3, v: 5, fallback: "Confia no SENHOR de todo o teu coração, e não te estribes no teu próprio entendimento." },
  { b: 57, c: 11, v: 1, fallback: "Ora, a fé é o firme fundamento das coisas que se esperam, e a prova das coisas que se não veem." },
  { b: 39, c: 11, v: 28, fallback: "Vinde a mim, todos os que estais cansados e oprimidos, e eu vos aliviarei." },
  { b: 23, c: 29, v: 11, fallback: "Porque eu bem sei os pensamentos que tenho a vosso respeito, diz o SENHOR; pensamentos de paz, e não de mal, para vos dar o fim que esperais." },
  { b: 24, c: 3, v: 22, fallback: "As misericórdias do SENHOR são a causa de não sermos consumidos, porque as suas compaixões não têm fim." },
];

const HOME_THEMES = {
  pregacao: [
    { title: "A Fonte da Água Viva", ref: "João 4", query: "João 4", desc: "Jesus quebra barreiras culturais e sacia a sede mais profunda da alma." },
    { title: "Mais que Vencedores", ref: "Romanos 8", query: "Romanos 8", desc: "A vida no Espírito e a certeza de que nada nos separa do amor de Deus." },
    { title: "O Pastor que Cuida", ref: "Salmo 23", query: "Salmo 23", desc: "Provisão, descanso, direção e consolo nos vales da caminhada cristã." },
    { title: "Fé em Tempos Difíceis", ref: "Hebreus 11", query: "Hebreus 11", desc: "A galeria dos heróis da fé e como permanecer firme nas promessas." },
    { title: "A Armadura de Deus", ref: "Efésios 6:10-18", query: "Efésios 6", desc: "Como revestir a igreja para vencer as batalhas espirituais do dia a dia." },
    { title: "O Abraço do Pai", ref: "Lucas 15", query: "Lucas 15", desc: "Graça, arrependimento e restauração na parábola do Filho Pródigo." },
  ],
  personagens: [
    { title: "Davi: Coração Segundo Deus", ref: "1 Samuel 16–17", query: "A vida de Davi", desc: "Do pastoreio de ovelhas ao trono: fé, quedas, arrependimento e adoração." },
    { title: "Ester: Para um Tempo como Este", ref: "Ester 4", query: "Ester 4", desc: "Coragem, jejum e a providência invisível de Deus na história do Seu povo." },
    { title: "Moisés e a Sarça Ardente", ref: "Êxodo 3", query: "Êxodo 3", desc: "Quando Deus chama na rotina e transforma fraqueza em libertação." },
    { title: "Elias no Monte Carmelo e em Horebe", ref: "1 Reis 18–19", query: "1 Reis 19", desc: "Do grande triunfo espiritual ao cuidado de Deus no cansaço da alma." },
    { title: "Rute: Lealdade e Redenção", ref: "Rute 1–4", query: "O livro de Rute", desc: "Fidelidade familiar e a figura do Redentor que restaura a esperança." },
    { title: "Paulo em Atenas", ref: "Atos 17", query: "Atos 17", desc: "Como anunciar o Evangelho com sabedoria e clareza à cultura ao redor." },
  ],
  pastoral: [
    { title: "Vencendo a Ansiedade", ref: "Filipenses 4:6-7", query: "Como vencer a ansiedade segundo Filipenses 4", desc: "A paz de Deus que excede todo entendimento através da oração grata." },
    { title: "O Poder do Perdão", ref: "Mateus 18:21-35", query: "O perdão em Mateus 18", desc: "Curando feridas na família e na igreja através da graça que recebemos." },
    { title: "Esperança no Luto e na Dor", ref: "1 Tessalonicenses 4:13-18", query: "1 Tessalonicenses 4 consolo no luto", desc: "Como consolar corações enlutados com a bendita esperança da ressurreição." },
    { title: "Edificando o Lar sobre a Rocha", ref: "Salmo 127 e Efésios 5", query: "A família cristã em Efésios 5", desc: "Princípios bíblicos para o casamento, criação de filhos e harmonia no lar." },
    { title: "Renovando as Forças no Cansaço", ref: "Isaías 40:28-31", query: "Isaías 40", desc: "Mensagem de ânimo para irmãos sobrecarregados com as lutas da semana." },
    { title: "Sabedoria nas Decisões", ref: "Tiago 1:5-8", query: "Tiago 1", desc: "Como buscar a direção de Deus com fé em momentos de encruzilhada." },
  ],
};

const DIVISIONS = {
  pentateuco: [0, 4],
  historicos: [5, 16],
  poeticos: [17, 21],
  profetas: [22, 38],
  evangelhos: [39, 43],
  cartas: [44, 65],
};

let vodIndex = Math.floor(Date.now() / 86400000) % DAILY_VERSES.length;
let curThemeCat = "pregacao";
let curDivision = "pentateuco";

function renderVod() {
  const item = DAILY_VERSES[vodIndex % DAILY_VERSES.length];
  const txt = BIBLE ? verseText(item.b, item.c, item.v) || item.fallback : item.fallback;
  const bName = BIBLE ? BIBLE.books[item.b].name : "";
  $("#vodText").textContent = `“${txt}”`;
  $("#vodRef").textContent = bName ? `${bName} ${item.c}:${item.v} (BLIVRE)` : "";
}

function renderContinueCard() {
  if (!BIBLE) return;
  const bk = BIBLE.books[pos.b];
  if (!bk) return;
  $("#homeContinueRef").textContent = `${bk.name} ${pos.c}`;
  const v1 = bk.chapters[pos.c - 1]?.[0] || "";
  $("#homeContinuePreview").textContent = v1 ? `“${v1}”` : `${bk.chapters.length} capítulos disponíveis.`;
}

function renderThemes() {
  const gridEl = $("#themeGrid");
  if (!gridEl) return;
  const items = HOME_THEMES[curThemeCat] || [];
  gridEl.innerHTML = items
    .map(
      (t, idx) => `<button type="button" class="theme-card" data-idx="${idx}">
        <div class="t-top">
          <span class="t-title">${escapeHtml(t.title)}</span>
          <span class="t-ref">${escapeHtml(t.ref)}</span>
        </div>
        <div class="t-desc">${escapeHtml(t.desc)}</div>
      </button>`
    )
    .join("");
}

function renderDivisionBooks() {
  const stripEl = $("#divisionBooks");
  if (!stripEl || !BIBLE) return;
  const [start, end] = DIVISIONS[curDivision] || [0, 4];
  let html = "";
  for (let i = start; i <= end && i < BIBLE.books.length; i++) {
    const bk = BIBLE.books[i];
    html += `<button type="button" class="book-chip" data-b="${i}">
      <strong>${escapeHtml(bk.name)}</strong>
      <small>${bk.chapters.length} cap.</small>
    </button>`;
  }
  stripEl.innerHTML = html;
}

function updateHome() {
  const h = new Date().getHours();
  const greet = h < 12 ? "Bom dia, graça e paz!" : h < 18 ? "Boa tarde, graça e paz!" : "Boa noite, graça e paz!";
  $("#homeGreeting").textContent = greet;
  try {
    const dStr = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
    $("#homeDate").textContent = dStr.charAt(0).toUpperCase() + dStr.slice(1);
  } catch {}
  renderVod();
  renderContinueCard();
  renderThemes();
  renderDivisionBooks();
}

function initHomeEvents() {
  $("#shuffleVerse").onclick = () => {
    vodIndex = (vodIndex + 1) % DAILY_VERSES.length;
    renderVod();
  };
  $("#vodRead").onclick = () => {
    const it = DAILY_VERSES[vodIndex % DAILY_VERSES.length];
    openInReader(it.b, it.c, it.v);
  };
  $("#vodExplain").onclick = () => {
    const it = DAILY_VERSES[vodIndex % DAILY_VERSES.length];
    const txt = BIBLE ? verseText(it.b, it.c, it.v) : it.fallback;
    const ref = BIBLE ? refLabel(it.b, it.c, [it.v]) : "";
    explainPassage(ref, txt, `${it.v} ${txt}`);
  };
  $("#vodSermon").onclick = () => {
    const it = DAILY_VERSES[vodIndex % DAILY_VERSES.length];
    if (!BIBLE) return askMaster(`Salmo 119`, "estudo");
    const ref = refLabel(it.b, it.c, [it.v]);
    const chText = BIBLE.books[it.b].chapters[it.c - 1].map((t, i) => `${i + 1} ${t}`).join("\n");
    askMaster(ref, "estudo", { ref: refLabel(it.b, it.c), text: chText });
  };
  $("#homeQuickForm").onsubmit = (e) => {
    e.preventDefault();
    const q = $("#homeQuickInput").value.trim();
    if (!q) return;
    $("#homeQuickInput").value = "";
    const isDoubt = /\?$/.test(q) || /^(o que|me explica|qual|como|por que|porque|significa)\b/i.test(q);
    const ref = parseRef(q);
    if (ref && BIBLE) {
      const chText = BIBLE.books[ref.b].chapters[ref.c - 1].map((t, i) => `${i + 1} ${t}`).join("\n");
      askMaster(q, ref.v ? "duvida" : "estudo", { ref: refLabel(ref.b, ref.c), text: chText });
    } else {
      askMaster(q, isDoubt ? "duvida" : "estudo");
    }
  };
  $("#homeContinueBtn").onclick = () => openInReader(pos.b, pos.c);
  $("#homeContinueStudy").onclick = () => {
    if (!BIBLE) return;
    const ref = refLabel(pos.b, pos.c);
    const text = BIBLE.books[pos.b].chapters[pos.c - 1].map((t, i) => `${i + 1} ${t}`).join("\n");
    askMaster(ref, "estudo", { ref, text });
  };
  $("#homeGoStudy").onclick = () => {
    setView("chat");
    setMode("estudo");
    setTimeout(() => $("#input").focus(), 60);
  };
  $("#homeGoDoubt").onclick = () => {
    setView("chat");
    setMode("duvida");
    setTimeout(() => $("#input").focus(), 60);
  };
  $("#themeFilter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    curThemeCat = b.dataset.cat;
    document.querySelectorAll("#themeFilter .pill").forEach((p) => p.classList.toggle("active", p === b));
    renderThemes();
  });
  $("#themeGrid").addEventListener("click", (e) => {
    const card = e.target.closest(".theme-card");
    if (!card) return;
    const item = HOME_THEMES[curThemeCat]?.[Number(card.dataset.idx)];
    if (!item) return;
    const ref = parseRef(item.query);
    if (ref && BIBLE) {
      const chText = BIBLE.books[ref.b].chapters[ref.c - 1].map((t, i) => `${i + 1} ${t}`).join("\n");
      askMaster(item.query, "estudo", { ref: refLabel(ref.b, ref.c), text: chText });
    } else {
      askMaster(item.query, "estudo");
    }
  });
  $("#divisionFilter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-div]");
    if (!b) return;
    curDivision = b.dataset.div;
    document.querySelectorAll("#divisionFilter .pill").forEach((p) => p.classList.toggle("active", p === b));
    renderDivisionBooks();
  });
  $("#divisionBooks").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-b]");
    if (!chip || !BIBLE) return;
    const b = Number(chip.dataset.b);
    openInReader(b, 1);
    if (BIBLE.books[b].chapters.length > 1) {
      picker.hidden = false;
      showChapters(b);
    }
  });
}

// ---------- Inicialização ----------
viewHooks.home = updateHome;
viewHooks.favs = renderFavs;
viewHooks.search = () => setTimeout(() => searchInput.focus(), 50);
viewHooks.bible = () => { if (BIBLE && !readerEl.querySelector(".verse")) renderReader(); };

initHomeEvents();
updateHome();

async function loadBible() {
  try {
    const res = await fetch("bible/blivre.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    BIBLE = await res.json();
  } catch (err) {
    readerEl.innerHTML = `<p class="empty">Não foi possível carregar a Bíblia (${escapeHtml(err.message)}).<br>Verifique se o servidor está rodando.</p>`;
    $("#curRef").textContent = "Bíblia indisponível";
    return;
  }
  if (!BIBLE.books[pos.b]?.chapters[pos.c - 1]) pos = { b: 42, c: 3 };
  buildNameIndex();
  renderReader();
  updateHome();
  if (!busy && state.messages.length) renderAll(); // ativa os links de referência no histórico
  if (!$("#view-favs").hidden) renderFavs();
  if (searchInput.value) runSearch();
}

setView(location.hash.slice(1) || "home");
loadBible();
