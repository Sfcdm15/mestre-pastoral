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
  $("#homeGoHarpa").onclick = () => {
    setView("harpa");
    showHarpaIndex();
    setTimeout(() => $("#harpaSearchInput").focus(), 60);
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

// ---------- Harpa Cristã (524 Hinos + Pesquisa por Número ou Nome) ----------
const HARPA_FAV_KEY = "mestre-pastoral:harpa-favs";
let HARPA = null; // [{ n, title, lyrics, normTitle, normLyrics, firstLine }]
let harpaFavs = loadJSON(HARPA_FAV_KEY, []); // [n, ...]
let curHarpaRange = "ALL";
let curHymnNum = 1;
const saveHarpaFavs = () => localStorage.setItem(HARPA_FAV_KEY, JSON.stringify(harpaFavs));

function isChorusStanza(stanza) {
  if (/^\d{1,2}[\s.]/.test(stanza.trim())) return false;
  const letters = stanza.replace(/[^a-zA-ZÀ-ÿ]/g, "");
  if (letters.length < 10) return false;
  const upper = letters.replace(/[^A-ZÀ-Ý]/g, "").length;
  return upper / letters.length > 0.75;
}

function showHarpaIndex() {
  $("#harpaIndexView").hidden = false;
  $("#harpaReaderView").hidden = true;
  renderHarpaList();
}

// ---------- Central de Louvor para a Banda da Igreja ----------
const WORSHIP_STORAGE_KEY = "mestre-pastoral:worship-library";
const CIFRA_STORAGE_PREFIX = "mestre-pastoral:cifra:";

let curBandMode = "duo"; // 'duo' | 'cantor' | 'violao' | 'teclado' | 'bateria'
let curSongData = null; // objeto normalizado da música atual
let curCifraSemitones = 0;
let curCifraFontSize = 15;
let cifraAutoScrollTimer = null;
let isCifraAutoScrolling = false;
let curAutoScrollSpeed = 1;
let isYtCollapsed = false;

function extractYoutubeId(input) {
  if (!input) return null;
  const str = String(input).trim();
  const m = str.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(str) && !/^\d+$/.test(str)) return str;
  return null;
}

function buildYoutubePlayerHtml(s) {
  const activeYtId = s.youtubeId || localStorage.getItem("worship_yt_" + s.id) || null;
  if (!activeYtId) return "";

  return `
    <div class="youtube-player-card" id="ytPlayerCard">
      <div class="youtube-card-header">
        <div class="youtube-card-title">
          <svg viewBox="0 0 24 24" width="22" height="22" style="flex-shrink:0"><path fill="#e62117" d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
          <div>
            <b>YouTube Oficial:</b> ${escapeHtml(s.artist ? s.artist + " — " : "")}${escapeHtml(s.title)}
          </div>
        </div>
        <div class="youtube-card-actions">
          <button type="button" class="cifra-tool-btn" id="btnToggleYtCollapse" title="Recolher ou Expandir o Vídeo">
            ${isYtCollapsed ? "▶️ Expandir Vídeo" : "➖ Recolher Vídeo"}
          </button>
          <button type="button" class="cifra-tool-btn" id="btnEditYtLink" title="Alterar ou colar outro link do YouTube">
            🔗 Alterar Link
          </button>
          <a href="https://www.youtube.com/watch?v=${encodeURIComponent(activeYtId)}" target="_blank" rel="noopener" class="cifra-tool-btn" title="Abrir no app do YouTube">
            ↗ Assistir no YouTube
          </a>
        </div>
      </div>
      <div class="youtube-iframe-box" id="ytIframeBox" style="${isYtCollapsed ? "display:none;" : ""}">
        <iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(activeYtId)}?enablejsapi=1" title="${escapeHtml(s.title)}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
      </div>
    </div>
  `;
}

// Metrônomo para Bateria
let metronomeTimer = null;
let isMetronomeRunning = false;
let currentBeatIndex = 0;
let audioCtx = null;

const NOTES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTES_FLAT  = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

const CHORD_NOTES_MAP = {
  "C": "Dó - Mi - Sol",
  "Cm": "Dó - Mib - Sol",
  "C7": "Dó - Mi - Sol - Sib",
  "C9": "Dó - Mi - Sol - Ré",
  "C#": "Dó# - Fá - Sol#",
  "C#m": "Dó# - Mi - Sol#",
  "Db": "Réb - Fá - Láb",
  "D": "Ré - Fá# - Lá",
  "Dm": "Ré - Fá - Lá",
  "D7": "Ré - Fá# - Lá - Dó",
  "D9": "Ré - Mi - Fá# - Lá",
  "D#": "Ré# - Sol - Lá#",
  "D#m": "Ré# - Fá# - Lá#",
  "Eb": "Mib - Sol - Sib",
  "E": "Mi - Sol# - Si",
  "Em": "Mi - Sol - Si",
  "E7": "Mi - Sol# - Si - Ré",
  "F": "Fá - Lá - Dó",
  "Fm": "Fá - Láb - Dó",
  "F#": "Fá# - Lá# - Dó#",
  "F#m": "Fá# - Lá - Dó#",
  "F#7": "Fá# - Lá# - Dó# - Mi",
  "Gb": "Solb - Sib - Réb",
  "G": "Sol - Si - Ré",
  "Gm": "Sol - Sib - Ré",
  "G7": "Sol - Si - Ré - Fá",
  "G9": "Sol - Lá - Si - Ré",
  "G#": "Sol# - Dó - Ré#",
  "G#m": "Sol# - Si - Ré#",
  "Ab": "Láb - Dó - Mib",
  "A": "Lá - Dó# - Mi",
  "Am": "Lá - Dó - Mi",
  "A7": "Lá - Dó# - Mi - Sol",
  "A9": "Lá - Si - Dó# - Mi",
  "A#": "Lá# - Ré - Fá",
  "A#m": "Lá# - Dó# - Fá",
  "Bb": "Sib - Ré - Fá",
  "B": "Si - Ré# - Fá#",
  "Bm": "Si - Ré - Fá#",
  "B7": "Si - Ré# - Fá# - Lá"
};

const GUITAR_CHORD_TABS = {
  "C": "X 3 2 0 1 0",
  "C#": "X 4 6 6 6 4",
  "C#m": "X 4 6 6 5 4",
  "C#m7": "X 4 6 4 5 4",
  "C7": "X 3 2 3 1 0",
  "C9": "X 3 2 0 3 0",
  "C/E": "0 3 2 0 1 0",
  "D": "X X 0 2 3 2",
  "Dm": "X X 0 2 3 1",
  "D7": "X X 0 2 1 2",
  "D9": "X X 0 2 3 0",
  "D/F#": "2 X 0 2 3 2",
  "D#": "X 6 8 8 8 6",
  "Eb": "X 6 8 8 8 6",
  "E": "0 2 2 1 0 0",
  "Em": "0 2 2 0 0 0",
  "Em7": "0 2 2 0 3 0",
  "E7": "0 2 0 1 0 0",
  "F": "1 3 3 2 1 1",
  "Fm": "1 3 3 1 1 1",
  "F7M": "X X 3 2 1 0",
  "F#": "2 4 4 3 2 2",
  "F#m": "2 4 4 2 2 2",
  "F#7": "2 4 2 3 2 2",
  "G": "3 2 0 0 0 3",
  "Gm": "3 5 5 3 3 3",
  "G7": "3 2 0 0 0 1",
  "G9": "3 X 0 2 0 3",
  "G/B": "X 2 0 0 3 3",
  "G#": "4 6 6 5 4 4",
  "G#m": "4 6 6 4 4 4",
  "Ab": "4 6 6 5 4 4",
  "A": "X 0 2 2 2 0",
  "Am": "X 0 2 2 1 0",
  "Am7": "X 0 2 0 1 0",
  "A7": "X 0 2 0 2 0",
  "A9": "X 0 2 2 0 0",
  "A/B": "X 2 2 2 2 0",
  "Bb": "X 1 3 3 3 1",
  "B": "X 2 4 4 4 2",
  "Bm": "X 2 4 4 3 2",
  "B7": "X 2 1 2 0 2"
};

function buildCifraClubChordsBar(transposedCifra, s) {
  const uniqueChords = extractUniqueChords(transposedCifra);
  if (!uniqueChords || uniqueChords.length === 0) return "";

  const chordBoxesHtml = uniqueChords.map(ch => {
    const shape = GUITAR_CHORD_TABS[ch] || GUITAR_CHORD_TABS[ch.replace(/m|7|9/g, "")] || "Violão";
    const notes = CHORD_NOTES_MAP[ch] || CHORD_NOTES_MAP[ch.replace(/m|7|9/g, "")] || "Acorde";
    return `
      <div class="cifraclub-chord-box" title="Acorde ${escapeHtml(ch)}: ${escapeHtml(notes)}">
        <span class="cc-chord-name">${escapeHtml(ch)}</span>
        <span class="cc-chord-shape">${escapeHtml(shape)}</span>
        <span class="cc-chord-notes">${escapeHtml(notes)}</span>
      </div>
    `;
  }).join("");

  const capoHtml = s.capo ? `<span class="cifra-capo-pill">🎸 Capotraste: ${escapeHtml(s.capo)}</span>` : "";

  return `
    <div class="cifraclub-chords-bar">
      <div class="cifraclub-chords-header">
        <div class="cifraclub-chords-label">
          🎸 <b>Acordes da Música (Padrão Cifra Club):</b>
        </div>
        ${capoHtml}
      </div>
      <div class="cifraclub-chords-list">
        ${chordBoxesHtml}
      </div>
    </div>
  `;
}

const BUILTIN_LOUVORES = [
  {
    id: "louvor:tudo-e-perda",
    title: "Tudo É Perda",
    artist: "Felipe Rodrigues",
    youtubeId: "9Sj0manxV_8",
    tom: "C",
    capo: "1ª casa (Tom original: C#)",
    bpm: 68,
    compasso: "4/4",
    estilo: "Worship / Adoração",
    batidaViolao: "Dedilhado suave na primeira parte; levada worship 4/4 crescente no refrão (↓  ↓↑  ↑↓↑)",
    teclado: "Pad ambiente atmosférico sustentando acordes de C, Am, G e F; condução suave no piano acústico",
    bateria: "Começo suave com pratos e aro de caixa; dinâmica crescente a partir da segunda parte e bumbo marcado no refrão",
    lyrics: `[Intro]
C  Am  G  F

[Primeira Parte]
Tudo é perda se não tenho a Ti
A Tua graça é o que me basta
Sem Você, não sei pra onde ir
Sem Tua presença, nada importa

[Segunda Parte]
Do que adianta eu ganhar o mundo inteiro
E a minha alma se perder sem Ti, Senhor?
Do que adianta eu juntar os meus tesouros
E me esquecer daquele que me amou?

[Refrão]
Se eu não tenho a Ti, não tenho nada
Nada eu serei sem Ti, Senhor
Só Tua presença é o que me basta
Eu Te levarei por onde eu for

[Interlúdio]
Dm  G  C/E  F
Dm  G  C/E  F

[Ponte]
Tua presença é o que me basta
Quem sou eu sem Teu amor, Senhor?
Tua presença é o que me basta
Quem sou eu sem Teu amor, Senhor?

[Refrão Final]
Se eu não tenho a Ti, não tenho nada
Nada eu serei sem Ti, Senhor
Só Tua presença é o que me basta
Eu Te levarei por onde eu for

[Final]
Se eu não tenho a Ti, não tenho nada
Eu Te levarei por onde eu for
Por onde eu for!`,
    cifra: `[Tom: C]
[Capotraste: 1ª casa (Tom original: C#)]

[Intro]
C  Am  G  F

[Primeira Parte]
C                   Am
Tudo é perda se não tenho a Ti
G                         F
A Tua graça é o que me basta
C                   Am
Sem Você, não sei pra onde ir
G                           F
Sem Tua presença, nada importa

[Segunda Parte]
F                                  G
Do que adianta eu ganhar o mundo inteiro
C/E                                     F
E a minha alma se perder sem Ti, Senhor?
F                                    G
Do que adianta eu juntar os meus tesouros
C/E                                  F
E me esquecer daquele que me amou?

[Refrão]
Dm    C           G
Se eu não tenho a Ti, não tenho nada
C/E                         F
Nada eu serei sem Ti, Senhor
Dm    C             G
Só Tua presença é o que me basta
C/E                          F
Eu Te levarei por onde eu for

[Interlúdio]
Dm  G  C/E  F
Dm  G  C/E  F

[Ponte]
Dm                    G
Tua presença é o que me basta
C/E                                   F
Quem sou eu sem Teu amor, Senhor?
Dm                    G
Tua presença é o que me basta
C/E                                   F
Quem sou eu sem Teu amor, Senhor?

[Refrão Final]
Dm    C           G
Se eu não tenho a Ti, não tenho nada
C/E                         F
Nada eu serei sem Ti, Senhor
Dm    C             G
Só Tua presença é o que me basta
C/E                          F
Eu Te levarei por onde eu for

[Final]
Dm    C           G
Se eu não tenho a Ti, não tenho nada
C/E                          F
Eu Te levarei por onde eu for
C
Por onde eu for!`
  },
  {
    id: "louvor:bondade-de-deus",
    title: "Bondade de Deus",
    artist: "Isaías Saad",
    youtubeId: "vBf4u5QZ5-c",
    tom: "G",
    bpm: 70,
    compasso: "4/4",
    estilo: "Worship / Balada",
    batidaViolao: "Dedilhado suave nas estrofes (P-i-m-a); batida 4/4 crescente no refrão (↓  ↓↑  ↑↓↑)",
    teclado: "Pad atmosférico sustentando a harmonia; piano com notas de apoio e arpejos nas passagens",
    bateria: "Verso 1 em silêncio; verso 2 entra com bumbo macio e tom-tons; refrão com condução no prato e bumbo marcante",
    lyrics: `[Verso 1]
Te amarei, Senhor, Tua graça nunca falha
Todos os meus dias em Tuas mãos estão
Desde o amanhecer até o sol se pôr
Eu cantarei da bondade de Deus

[Coro]
És fiel em todo o tempo
Em todo o tempo Tu és tão, tão bom
Com todo o fôlego que tenho
Eu cantarei da bondade de Deus

[Verso 2]
Tua voz me guia através do fogo
Na escuridão, Tua presença é paz
Eu Te conheço como Pai e amigo
Eu tenho vivido na bondade de Deus

[Coro]
És fiel em todo o tempo
Em todo o tempo Tu és tão, tão bom
Com todo o fôlego que tenho
Eu cantarei da bondade de Deus

[Ponte]
Tua bondade me seguirá, me seguirá, Senhor
Tua bondade me seguirá, me seguirá, Senhor
Eu me rendo a Ti, Te dou o meu ser, entrego tudo a Ti
Tua bondade me seguirá, me seguirá, Senhor

[Ponte]
Tua bondade me seguirá, me seguirá, Senhor
Tua bondade me seguirá, me seguirá, Senhor
Eu me rendo a Ti, Te dou o meu ser, entrego tudo a Ti
Tua bondade me seguirá, me seguirá, Senhor

[Coro]
És fiel em todo o tempo
Em todo o tempo Tu és tão, tão bom
Com todo o fôlego que tenho
Eu cantarei da bondade de Deus

[Final]
Eu cantarei da bondade de Deus
Eu cantarei da bondade de Deus`,
    cifra: `[Tom: G]

[Intro: G  C  G  C]

[Verso 1]
       G             C
Te amarei, Senhor, Tua graça nunca falha
       G                      D
Todos os meus dias em Tuas mãos estão
               Em         C
Desde o amanhecer até o sol se pôr
       G      D         G
Eu cantarei da bondade de Deus

[Coro]
 C                      G
És fiel em todo o tempo
 C                     G           D
Em todo o tempo Tu és tão, tão bom
 C                       Em
Com todo o fôlego que tenho
       G      D         G
Eu cantarei da bondade de Deus

[Verso 2]
         G               C
Tua voz me guia através do fogo
        G                   D
Na escuridão, Tua presença é paz
          Em             C
Eu Te conheço como Pai e amigo
        G       D          G
Eu tenho vivido na bondade de Deus

[Coro]
 C                      G
És fiel em todo o tempo
 C                     G           D
Em todo o tempo Tu és tão, tão bom
 C                       Em
Com todo o fôlego que tenho
       G      D         G
Eu cantarei da bondade de Deus

[Ponte]
       C                 D
Tua bondade me seguirá, me seguirá, Senhor
       C                 D
Tua bondade me seguirá, me seguirá, Senhor
       G/B            C
Eu me rendo a Ti, Te dou o meu ser
       D
Entrego tudo a Ti
       C                 D            G
Tua bondade me seguirá, me seguirá, Senhor

[Ponte]
       C                 D
Tua bondade me seguirá, me seguirá, Senhor
       C                 D
Tua bondade me seguirá, me seguirá, Senhor
       G/B            C
Eu me rendo a Ti, Te dou o meu ser
       D
Entrego tudo a Ti
       C                 D            G
Tua bondade me seguirá, me seguirá, Senhor

[Coro]
 C                      G
És fiel em todo o tempo
 C                     G           D
Em todo o tempo Tu és tão, tão bom
 C                       Em
Com todo o fôlego que tenho
       G      D         G
Eu cantarei da bondade de Deus

[Final]
       Em     D         C
Eu cantarei da bondade de Deus
       G      D         G
Eu cantarei da bondade de Deus`
  },
  {
    id: "louvor:nao-ha-barreiras",
    title: "Não Há Barreiras",
    artist: "Álvaro Tito",
    youtubeId: "TVlBJwDZu0M",
    tom: "E",
    bpm: 72,
    compasso: "4/4",
    estilo: "Balada Gospel / Clássico",
    batidaViolao: "Dedilhado suave nas estrofes; levada balada 4/4 crescente no refrão (↓  ↓↑  ↑↓↑)",
    teclado: "Piano acústico expressivo com Pad de fundo em Mi e modulação em Fá",
    bateria: "Entrada suave com prato e aro de caixa nos versos; condução cheia e bumbo marcado no refrão",
    lyrics: `[Verso 1]
Sei que os problemas vão surgir
Sei que provações virão
Põe a tua fé no intercessor que é Jesus
Que sempre te estende a forte mão
Sei que as muralhas do temor
Hão de intimidar teu ser
Mas põe a tua fé no intercessor que é Jesus
E as barreiras tu irás romper

[Coro]
Pois não há barreiras
Para aquele revestido do poder
Que vem de Deus destruindo todo mal e dor
As mais altas barreiras tu irás transpor

[Verso 2]
Sei que não há nada nem ninguém
Que consiga separar, separar
O cristão de Deus e de uma vida mais além
No céu onde os temores vão cessar
É intransponível esse amor
Que Jesus tem pelos seus
Dando livramento em plena luta, em plena dor
Jesus é o nosso grande intercessor

[Coro]
Pois não há barreiras
Para aquele revestido do poder
Que vem de Deus destruindo todo mal e dor
As mais altas barreiras tu irás transpor

[Modulação para Fá Maior - Coro]
Pois não há barreiras
Para aquele revestido do poder
Que vem de Deus destruindo todo mal e dor
As mais altas barreiras tu irás transpor

[Final]
As mais altas barreiras tu irás transpor
Que vem de Deus destruindo todo mal e dor
As mais altas barreiras tu irás transpor
As mais altas barreiras tu irás transpor!`,
    cifra: `[Tom: E]

[Intro: E  C#m  A  B  E  C#m  A  B]

[Verso 1]
E           B         C#m    B
Sei que os problemas vão surgir
A                     B           E
Sei que provações virão
A               B/A                       G#m   C#m
Põe a tua fé no intercessor que é Jesus
F#m                   B
Que sempre te estende a forte mão
E         B         C#m
Sei que as muralhas do temor
A                    E
Hão de intimidar teu ser
A                   B/A                   G#m  C#m
Mas põe a tua fé no intercessor que é Jesus
A                 B             A  E
E as barreiras tu irás romper

[Coro]
A           B         E
Pois não há barreiras
F#m          B          D     E
Para aquele revestido do poder
A           B                G#m          C#m
Que vem de Deus destruindo todo mal e dor
A                     B                     A   E
As mais altas barreiras tu irás transpor

[Verso 2]
E           B         C#m    B
Sei que não há nada nem ninguém
A                    E
Que consiga separar, separar
A                     B                  G#m     C#m
O cristão de Deus e de uma vida mais além
F#m                    B
No céu onde os temores vão cessar
E         B         C#m
É intransponível esse amor
A                     E
Que Jesus tem pelos seus
A                   B/A                     G#m  C#m
Dando livramento em plena luta, em plena dor
A                    B            A  E
Jesus é o nosso grande intercessor

[Coro]
A           B         E
Pois não há barreiras
F#m          B          D     E
Para aquele revestido do poder
A           B                G#m          C#m
Que vem de Deus destruindo todo mal e dor
A                     B                     A   E
As mais altas barreiras tu irás transpor

[Ponte Instrumental - Modulação para F]
Bb  C  Bb  C

[Coro Final - Tom: F]
Bb          C         F
Pois não há barreiras
Gm           C          Eb    F
Para aquele revestido do poder
Bb          C                Am           Dm
Que vem de Deus destruindo todo mal e dor
Bb                    C                     Bb   F
As mais altas barreiras tu irás transpor

[Final]
Bb                    C                     Dm
As mais altas barreiras tu irás transpor
Bb          C                Am           Dm
Que vem de Deus destruindo todo mal e dor
Bb                    C                     Bb
As mais altas barreiras tu irás transpor
Bb                    C                     F
As mais altas barreiras tu irás transpor!`
  },
  {
    id: "louvor:a-casa-e-sua",
    title: "A Casa É Sua",
    artist: "Casa Worship",
    youtubeId: "1-J_0V7u0p0",
    tom: "G",
    bpm: 68,
    compasso: "4/4",
    estilo: "Worship Contemporâneo",
    batidaViolao: "Dedilhado no verso; batida worship com dinâmica crescente a partir do refrão",
    teclado: "Ambiência com Pad em Sol e notas em oitavas no piano",
    bateria: "Começa suave com aro de caixa e bumbo discreto; explosão dinâmica na ponte e refrão final",
    lyrics: `[Verso 1]
Você é bem-vindo aqui, a casa é Sua, pode entrar
Me esvazio de mim, me esvazio de mim
Sopra Teu vento aqui, toma o Teu lugar
Me esvazio de mim, me esvazio de mim

[Coro]
Essa casa é Sua casa, nós deixamos ela pra Você, Jesus
Essa casa é Sua casa, nós deixamos ela pra Você, Jesus

[Verso 2]
Você é bem-vindo aqui, a casa é Sua, pode entrar
Me esvazio de mim, me esvazio de mim
Sopra Teu vento aqui, toma o Teu lugar
Me esvazio de mim, me esvazio de mim

[Coro]
Essa casa é Sua casa, nós deixamos ela pra Você, Jesus
Essa casa é Sua casa, nós deixamos ela pra Você, Jesus

[Ponte]
Apareça, que o Teu nome cresça
Enche este lugar, enche este lugar
Apareça, que o Teu nome cresça
Vem, Filho de Deus, enche este lugar

[Ponte]
Apareça, que o Teu nome cresça
Enche este lugar, enche este lugar
Apareça, que o Teu nome cresça
Vem, Filho de Deus, enche este lugar

[Coro]
Essa casa é Sua casa, nós deixamos ela pra Você, Jesus
Essa casa é Sua casa, nós deixamos ela pra Você, Jesus

[Final]
Essa casa é Sua casa, Jesus
Deixamos ela pra Você`,
    cifra: `[Tom: G]

[Intro: G  C  Em  D]

[Verso 1]
       G                             C
Você é bem-vindo aqui, a casa é Sua, pode entrar
       Em            D
Me esvazio de mim, me esvazio de mim
       G                           C
Sopra Teu vento aqui, toma o Teu lugar
       Em            D
Me esvazio de mim, me esvazio de mim

[Coro]
      C                 G
Essa casa é Sua casa, nós deixamos ela pra Você, Jesus
      Em                D
Essa casa é Sua casa, nós deixamos ela pra Você, Jesus

[Verso 2]
       G                             C
Você é bem-vindo aqui, a casa é Sua, pode entrar
       Em            D
Me esvazio de mim, me esvazio de mim
       G                           C
Sopra Teu vento aqui, toma o Teu lugar
       Em            D
Me esvazio de mim, me esvazio de mim

[Coro]
      C                 G
Essa casa é Sua casa, nós deixamos ela pra Você, Jesus
      Em                D
Essa casa é Sua casa, nós deixamos ela pra Você, Jesus

[Ponte]
     C              G
Apareça, que o Teu nome cresça
     Em             D
Enche este lugar, enche este lugar
     C              G
Apareça, que o Teu nome cresça
     Em             D
Vem, Filho de Deus, enche este lugar

[Ponte]
     C              G
Apareça, que o Teu nome cresça
     Em             D
Enche este lugar, enche este lugar
     C              G
Apareça, que o Teu nome cresça
     Em             D
Vem, Filho de Deus, enche este lugar

[Coro]
      C                 G
Essa casa é Sua casa, nós deixamos ela pra Você, Jesus
      Em                D
Essa casa é Sua casa, nós deixamos ela pra Você, Jesus

[Final]
      C                 G
Essa casa é Sua casa, Jesus
       Em          D    G
Deixamos ela pra Você`
  },
  {
    id: "louvor:raridade",
    title: "Raridade",
    artist: "Anderson Freire",
    youtubeId: "T8Ww_9Jc8tM",
    tom: "G",
    bpm: 72,
    compasso: "4/4",
    estilo: "Balada Gospel",
    batidaViolao: "Batida pop/balada (↓  ↓↑  ↑↓↑)",
    teclado: "Arpejos clássicos de piano gospel e cordas/strings de fundo",
    bateria: "Caixa no tempo 2 e 4 com bumbo firme no tempo 1",
    lyrics: `[Verso 1]
Não consigo ir além do Teu olhar
Tudo o que eu consigo é me apaixonar
Chego a pensar que o Teu amor por mim é uma ilusão
Eu não consigo entender

[Verso 2]
O ouro se desfaz, você não se desfez
A dor te castigou, mas você ficou de pé
Deus não te esqueceu, Ele te chamou pelo nome
O Senhor é quem sustenta a sua fé

[Coro]
Você é um espelho que reflete a imagem do Senhor
Não chore se o mundo ainda não notou
Já é o bastante Deus reconhecer o seu valor
Você é precioso, mais raro que o ouro puro de Ofir
Se você desistiu, Deus não vai desistir
Você é uma joia que o Senhor fez com as próprias mãos

[Verso 3]
Não pare de adorar, você foi feito pra vencer
Deus vai restituir tudo o que você perdeu
A tua história não termina aqui no chão
Levante a cabeça, Deus cuida de ti

[Coro]
Você é um espelho que reflete a imagem do Senhor
Não chore se o mundo ainda não notou
Já é o bastante Deus reconhecer o seu valor
Você é precioso, mais raro que o ouro puro de Ofir
Se você desistiu, Deus não vai desistir
Você é uma joia que o Senhor fez com as próprias mãos

[Final]
Você é uma joia que o Senhor fez com as próprias mãos!`,
    cifra: `[Tom: G]

[Intro: G  D/F#  Em  C]

[Verso 1]
       G              D/F#
Não consigo ir além do Teu olhar
       Em               C
Tudo o que eu consigo é me apaixonar
       G             D/F#
Chego a pensar que o Teu amor por mim
       Em               C
É uma ilusão, eu não consigo entender

[Verso 2]
        G               D/F#
O ouro se desfaz, você não se desfez
         Em                C
A dor te castigou, mas você ficou de pé
       G                D/F#
Deus não te esqueceu, Ele te chamou pelo nome
       Em               C
O Senhor é quem sustenta a sua fé

[Coro]
       G                       D/F#
Você é um espelho que reflete a imagem do Senhor
       Em                      C
Não chore se o mundo ainda não notou
       G                       D/F#
Já é o bastante Deus reconhecer o seu valor
       Em                      C
Você é precioso, mais raro que o ouro puro de Ofir
       G               D/F#
Se você desistiu, Deus não vai desistir
       Em            C
Você é uma joia que o Senhor fez com as próprias mãos

[Verso 3]
       G                 D/F#
Não pare de adorar, você foi feito pra vencer
       Em                 C
Deus vai restituir tudo o que você perdeu
       G                D/F#
A tua história não termina aqui no chão
       Em                C
Levante a cabeça, Deus cuida de ti

[Coro]
       G                       D/F#
Você é um espelho que reflete a imagem do Senhor
       Em                      C
Não chore se o mundo ainda não notou
       G                       D/F#
Já é o bastante Deus reconhecer o seu valor
       Em                      C
Você é precioso, mais raro que o ouro puro de Ofir
       G               D/F#
Se você desistiu, Deus não vai desistir
       Em            C
Você é uma joia que o Senhor fez com as próprias mãos

[Final]
       G               D/F#
Você é precioso, mais raro que o ouro de Ofir
       Em            C                       G
Você é uma joia que o Senhor fez com as próprias mãos!`
  }
];

function getWorshipLibrary() {
  const custom = loadJSON(WORSHIP_STORAGE_KEY, []);
  return [...BUILTIN_LOUVORES, ...custom];
}

function saveCustomWorship(song) {
  const list = loadJSON(WORSHIP_STORAGE_KEY, []).filter((s) => s.id !== song.id);
  list.unshift(song);
  localStorage.setItem(WORSHIP_STORAGE_KEY, JSON.stringify(list));
}

const BUILTIN_CIFRAS = {
  1: `[Tom: G]\n\n[Intro: G  D  C  D  G]\n\n      G\n1. Deus prometeu com certeza\n                  D\nChuvas de graça mandar;\n       G\nEle nos dá fortaleza\n  C          D         G\nE ricas bênçãos sem par.\n\n[Coro]\n           D\nChuvas de graça,\n  C        D      G\nChuvas pedimos, Senhor!\n             C\nManda-nos já chuvas mansas,\n G         D       G\nChuvas do Consolador!`,
  6: `[Tom: G]\n\n[Intro: G  D  Em  C  G  D  G]\n\n      G                D\n1. Tu na maldição da cruz,\n      C         D    G\nElevaste o Teu amor,\n                   D\nEm rogar, Senhor Jesus:\n        C       D       G\n"Pai, perdoa ao transgressor!"\n\n[Coro]\n G\nQueres, queres, com vigor,\n       C          D\nMuitas almas despertar;\n G\nQueres, queres, ó Senhor!\n       C         D   G\nTransformar, remir, curar;\n     C          G\nOh! sim!   Oh! sim!\n        D            G\nQueres todos renovar!`,
  15: `[Tom: E]\n\n[Intro: E  B7  A  B7  E]\n\n       E\n1. Oh! Quão cego andei e perdido vaguei,\n                           B7\nLonge, longe do meu Salvador!\n        E               A\nMas da glória desceu e seu sangue verteu\n         E         B7       E\nPra salvar um tão pobre pecador.\n\n[Coro]\n        E                      B7\nFoi na cruz, foi na cruz onde um dia eu vi\n       A        B7        E\nMeu pecado castigado em Jesus;\n        A                    E\nFoi ali pela fé que meus olhos abri,\n       E        B7          E\nE agora me alegro em sua luz!`,
  187: `[Tom: G]\n\n[Intro: G  D  C  G  D  G]\n\n       G   C        G\n1. Mais perto quero estar,\n            D\nMeu Deus, de Ti!\n     G   C        G\nInda que seja a dor\n    D      G\nQue me una a Ti,\n       C         G\nSempre hei de suplicar:\n        G   C        G\nMais perto quero estar,\n     D       G\nMais perto, ó Deus, de Ti!`,
  545: `[Tom: G]\n\n[Intro: G  C  G  D  G]\n\n      G           C\n1. Deus enviou seu Filho amado\n      G               D\nPara morrer no meu lugar;\n        G           C\nNa cruz pagou por meus pecados,\n        G     D          G\nMas vivo está e vida eterna dá.\n\n[Coro]\n           G           C\nPorque Ele vive, posso crer no amanhã,\n           G           D\nPorque Ele vive, temor não há;\n         G            C\nMas eu bem sei, eu sei, que a minha vida\n         G      D            G\nEstá nas mãos do meu Jesus, que vivo está!`
};

function transposeNote(note, semitones) {
  let idx = NOTES_SHARP.indexOf(note);
  if (idx === -1) idx = NOTES_FLAT.indexOf(note);
  if (idx === -1) return note;
  let newIdx = (idx + semitones) % 12;
  if (newIdx < 0) newIdx += 12;
  return NOTES_SHARP[newIdx];
}

function transposeChord(chord, semitones) {
  return chord.replace(/([A-G][#b]?)/g, (m) => transposeNote(m, semitones));
}

function transposeCifraText(rawText, semitones) {
  if (!semitones) return rawText;
  const lines = rawText.split(/\r?\n/);
  const chordTokenRegex = /\b([A-G][#b]?(?:m|maj|min|dim|aug|sus[24]?|[2-9]|1[13])*(?:\/[A-G][#b]?)?)\b/g;

  return lines
    .map((line) => {
      if (/^\[Tom:\s*([A-G][#b]?m?)\]/i.test(line.trim())) {
        return line.replace(/(\b[A-G][#b]?m?\b)/g, (c) => transposeChord(c, semitones));
      }
      if (/^\[Intro:\s*(.+)\]/i.test(line.trim())) {
        return line.replace(chordTokenRegex, (c) => transposeChord(c, semitones));
      }
      if (/^\[.*\]$/.test(line.trim())) return line;

      const words = line.trim().split(/\s+/).filter(Boolean);
      if (!words.length) return line;
      const isChordWord = (w) => /^[A-G][#b]?(?:m|maj|min|dim|aug|sus[24]?|[2-9]|1[13])*(?:\/[A-G][#b]?)?$/.test(w);
      const chordCount = words.filter(isChordWord).length;
      if (chordCount >= words.length * 0.6) {
        return line.replace(chordTokenRegex, (c) => transposeChord(c, semitones));
      }
      return line;
    })
    .join("\n");
}

function formatCifraHTML(cifraText) {
  const lines = cifraText.split(/\r?\n/);
  const chordTokenRegex = /\b([A-G][#b]?(?:m|maj|min|dim|aug|sus[24]?|[2-9]|1[13])*(?:\/[A-G][#b]?)?)\b/g;

  return lines
    .map((rawLine) => {
      const line = escapeHtml(rawLine);
      const trimmed = line.trim();
      if (!trimmed) return "<br>";
      if (/^\[(Tom|Intro|Coro|Estrofe|Ponte|\d+).*\]$/i.test(trimmed)) {
        return `<span class="chord-header">${line}</span>`;
      }
      const words = trimmed.split(/\s+/).filter(Boolean);
      const isChordWord = (w) => /^[A-G][#b]?(?:m|maj|min|dim|aug|sus[24]?|[2-9]|1[13])*(?:\/[A-G][#b]?)?$/.test(w);
      const chordCount = words.filter(isChordWord).length;
      if (chordCount >= words.length * 0.6) {
        const highlighted = line.replace(chordTokenRegex, '<span class="chord">$1</span>');
        return `<div class="chord-line">${highlighted}</div>`;
      }
      return `<div class="lyrics-line">${line}</div>`;
    })
    .join("");
}

function extractCifraKey(rawText, semitones = 0) {
  const m = rawText.match(/\[Tom:\s*([A-G][#b]?m?)\]/i) || rawText.match(/\b([A-G][#b]?m?)\b/);
  const base = m ? m[1] : "G";
  return transposeChord(base, semitones);
}

function extractUniqueChords(cifraText) {
  const chordTokenRegex = /\b([A-G][#b]?(?:m|maj|min|dim|aug|sus[24]?|[2-9]|1[13])*(?:\/[A-G][#b]?)?)\b/g;
  const set = new Set();
  let m;
  while ((m = chordTokenRegex.exec(cifraText)) !== null) {
    const raw = m[1].split("/")[0]; // remove baixo
    set.add(raw);
  }
  return Array.from(set).slice(0, 8);
}

// Metrônomo Áudio & Visual
function playMetronomeTick(isFirst) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = isFirst ? 1100 : 800;
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.04);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.04);
  } catch {}
}

function startMetronome(bpm = 70, beatsPerBar = 4) {
  stopMetronome();
  isMetronomeRunning = true;
  currentBeatIndex = 0;
  const intervalMs = (60 / bpm) * 1000;

  const btn = $("#btnToggleMetronome");
  if (btn) {
    btn.classList.add("active");
    btn.textContent = "⏸ Pausar Metrônomo";
  }

  function tick() {
    const dots = document.querySelectorAll(".metronome-beat-dot");
    dots.forEach((d, i) => {
      d.classList.remove("flash-one", "flash-sub");
      if (i === currentBeatIndex) {
        d.classList.add(i === 0 ? "flash-one" : "flash-sub");
      }
    });
    playMetronomeTick(currentBeatIndex === 0);
    currentBeatIndex = (currentBeatIndex + 1) % beatsPerBar;
  }

  tick();
  metronomeTimer = setInterval(tick, intervalMs);
}

function stopMetronome() {
  if (metronomeTimer) clearInterval(metronomeTimer);
  metronomeTimer = null;
  isMetronomeRunning = false;
  const btn = $("#btnToggleMetronome");
  if (btn) {
    btn.classList.remove("active");
    btn.textContent = "▶ Ligar Metrônomo";
  }
  document.querySelectorAll(".metronome-beat-dot").forEach((d) => d.classList.remove("flash-one", "flash-sub"));
}

function toggleCifraAutoScroll() {
  const reader = $("#harpaReader");
  const btn = $("#btnAutoScroll");
  if (isCifraAutoScrolling) {
    clearInterval(cifraAutoScrollTimer);
    isCifraAutoScrolling = false;
    if (btn) {
      btn.classList.remove("active");
      btn.textContent = "▶ Rolar Tela";
    }
  } else {
    isCifraAutoScrolling = true;
    if (btn) {
      btn.classList.add("active");
      btn.textContent = "⏸ Pausar";
    }
    const speedMs = Math.max(15, Math.round(45 / curAutoScrollSpeed));
    cifraAutoScrollTimer = setInterval(() => {
      if (!isCifraAutoScrolling || !reader) return;
      reader.scrollTop += 1;
      if (reader.scrollTop + reader.clientHeight >= reader.scrollHeight) {
        toggleCifraAutoScroll();
      }
    }, speedMs);
  }
}

function openCifraModal(song, text) {
  const modal = $("#cifraEditModal");
  if (!modal) return;
  $("#cifraEditTitle").textContent = `Cifra: ${song.title}`;
  $("#cifraEditText").value = text || song.cifra || `[Tom: G]\n\n[Intro: G  D  C  D  G]\n\n      G\n1. ...`;
  modal.hidden = false;
  $("#cifraEditText").focus();
}

function parseAIWorshipResponse(text, originalQuery) {
  const metaMatch = text.match(/\[METADADOS\]([\s\S]*?)\[FIM_METADADOS\]/i);
  const letraMatch = text.match(/\[LETRA\]([\s\S]*?)\[FIM_LETRA\]/i);
  const cifraMatch = text.match(/\[CIFRA\]([\s\S]*?)\[FIM_CIFRA\]/i);

  const metaText = metaMatch ? metaMatch[1] : "";
  const getField = (field, fallback) => {
    const m = metaText.match(new RegExp(`(?:${field})\\s*:\\s*(.+)`, "i"));
    return m ? m[1].trim() : fallback;
  };

  const title = getField("Titulo", originalQuery || "Louvor Congregacional");
  const artist = getField("Artista", "Ministério de Louvor");
  const tom = getField("Tom", "G");
  const bpm = Number(getField("BPM", "70")) || 70;
  const compasso = getField("Compasso", "4/4");
  const estilo = getField("Estilo", "Worship / Balada");
  const batidaViolao = getField("Batida Violao|Batida", "Dedilhado suave nos versos, levada 4/4 crescente no refrão");
  const teclado = getField("Teclado", "Pad ambiente sustentando acordes e piano acústico");
  const bateria = getField("Bateria", "Condução suave no chimbal, bumbo no 1 e 3, crescer dinâmico no refrão");

  const lyrics = letraMatch ? letraMatch[1].trim() : text.trim();
  const cifra = cifraMatch ? cifraMatch[1].trim() : text.trim();

  const ytRaw = getField("YouTube|Video|Link", "");
  const youtubeId = extractYoutubeId(ytRaw) || extractYoutubeId(originalQuery) || null;
  const capo = getField("Capotraste|Capo", "");

  const id = "custom:" + norm(title).replace(/[^a-z0-9]+/g, "-");
  return {
    id,
    isHarpa: false,
    n: null,
    title,
    artist,
    youtubeId,
    tom,
    capo,
    bpm,
    compasso,
    estilo,
    batidaViolao,
    teclado,
    bateria,
    lyrics,
    cifra
  };
}

async function handleSongLinkInput(url) {
  if (!url) return;
  setView("harpa");
  $("#harpaIndexView").hidden = true;
  $("#harpaReaderView").hidden = false;
  stopMetronome();
  if (isCifraAutoScrolling) toggleCifraAutoScroll();

  const reader = $("#harpaReader");
  reader.innerHTML = `
    <h2>🔗 Link Detectado: Analisando…</h2>
    <div class="testament">Carregando informações da música e gerando cifra completa no padrão Cifra Club</div>
    <div class="loading" style="padding:40px 10px;text-align:center">
      🎸 Processando link: <i>${escapeHtml(url)}</i>…<br>
      <span style="font-size:.85rem;color:var(--muted)">A IA vai gerar a cifra e a letra completa automaticamente. Aguarde alguns segundos.</span>
    </div>
  `;

  const cleanUrl = url.toLowerCase();

  // Exemplo direto Cifra Club: Tudo É Perda
  if (cleanUrl.includes("tudo-e-perda") || cleanUrl.includes("9sj0manxv_8")) {
    const existing = getWorshipLibrary().find((s) => s.id === "louvor:tudo-e-perda");
    if (existing) {
      toast("Música aberta no padrão Cifra Club! 🎸");
      openSongForBand(existing);
      return;
    }
  }

  // Exemplo direto YouTube: Não Há Barreiras
  if (cleanUrl.includes("tvlbjwdzu0m") || cleanUrl.includes("nao-ha-barreiras")) {
    const existing = getWorshipLibrary().find((s) => s.id === "louvor:nao-ha-barreiras");
    if (existing) {
      toast("Música aberta no padrão Cifra Club! 🎸");
      openSongForBand(existing);
      return;
    }
  }

  // Resolve pelo servidor (título, autor, ID do vídeo)
  let resolved = null;
  try {
    const res = await fetch("/api/resolve-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    if (res.ok) {
      resolved = await res.json();
    }
  } catch (e) {
    console.warn("Erro ao resolver link:", e);
  }

  const query = resolved && resolved.query ? resolved.query : url;
  const youtubeId = (resolved && resolved.youtubeId) ? resolved.youtubeId : extractYoutubeId(url);

  // Verifica se já temos essa música salva
  const normQ = norm(query);
  const matchInLib = getWorshipLibrary().find((s) => norm(s.title).includes(normQ) || normQ.includes(norm(s.title)));
  if (matchInLib) {
    if (youtubeId && !matchInLib.youtubeId) matchInLib.youtubeId = youtubeId;
    toast("Música pronta no padrão Cifra Club! 🎸");
    openSongForBand(matchInLib);
    return;
  }

  await generateAILouvor(query, youtubeId);
}

async function generateAILouvor(query, forcedYoutubeId = null) {
  const ytMatch = forcedYoutubeId || extractYoutubeId(query);
  if (ytMatch === "TVlBJwDZu0M" || query.toLowerCase().includes("nao-ha-barreiras")) {
    const existing = getWorshipLibrary().find((s) => s.youtubeId === "TVlBJwDZu0M" || s.id === "louvor:nao-ha-barreiras");
    if (existing) {
      openSongForBand(existing);
      return;
    }
  }
  if (ytMatch === "9Sj0manxV_8" || query.toLowerCase().includes("tudo-e-perda") || query.toLowerCase().includes("tudo é perda")) {
    const existing = getWorshipLibrary().find((s) => s.id === "louvor:tudo-e-perda");
    if (existing) {
      openSongForBand(existing);
      return;
    }
  }

  setView("harpa");
  $("#harpaIndexView").hidden = true;
  $("#harpaReaderView").hidden = false;
  stopMetronome();
  if (isCifraAutoScrolling) toggleCifraAutoScroll();

  const reader = $("#harpaReader");
  reader.innerHTML = `
    <h2>Buscando Louvor: “${escapeHtml(query)}”…</h2>
    <div class="testament">O Mestre Pastoral está montando a música 100% COMPLETA no padrão Cifra Club</div>
    <div class="loading" style="padding:40px 10px;text-align:center">
      🎸 Gerando Cifra e Letra no padrão Cifra Club com acordes alinhados e todas as partes…<br>
      <span style="font-size:.85rem;color:var(--muted)">Aguarde alguns segundos enquanto a música completa é preparada.</span>
    </div>
  `;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "louvor",
        messages: [{
          role: "user",
          text: `Gere a música e cifra COMPLETA no rigoroso PADRÃO CIFRA CLUB da canção '${query}'. Siga o FLUXO 4: [METADADOS] (com Tom, Capotraste se houver, lista de Acordes, BPM e Batida), [LETRA] completa verso a verso e [CIFRA] 100% integral do início ao fim com todas as etiquetas padrão ([Intro], [Primeira Parte], [Pré-Refrão], [Refrão], [Segunda Parte], [Interlúdio], [Ponte], [Refrão Final], [Final]). Sem resumos nem abreviações.`
        }]
      })
    });

    if (!res.ok) throw new Error("Erro na geração (" + res.status + ")");

    const decoder = new TextDecoder();
    let result = "";
    const stream = res.body.getReader();
    while (true) {
      const { done, value } = await stream.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }

    if (result.trim()) {
      const parsedSong = parseAIWorshipResponse(result, query);
      if (ytMatch) parsedSong.youtubeId = ytMatch;
      saveCustomWorship(parsedSong);
      toast("Cifra gerada no padrão Cifra Club! 🎸");
      openSongForBand(parsedSong);
    }
  } catch (err) {
    reader.innerHTML = `
      <div class="empty">
        Não foi possível gerar este louvor (${escapeHtml(err.message)}).<br><br>
        <button type="button" class="btn-gold" onclick="generateAILouvor('${escapeHtml(query)}')">🔄 Tentar novamente</button>
      </div>
    `;
  }
}

// Renderização dos 4 Modos da Banda
function renderCurrentBandView() {
  if (!curSongData) return;
  const s = curSongData;
  const reader = $("#harpaReader");
  stopMetronome();
  if (isCifraAutoScrolling) toggleCifraAutoScroll();

  document.querySelectorAll(".band-mode-selector .bmode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.bmode === curBandMode);
  });

  const rawCifra = s.cifra || localStorage.getItem(CIFRA_STORAGE_PREFIX + s.n) || BUILTIN_CIFRAS[s.n] || "";
  const currentKey = extractCifraKey(rawCifra, curCifraSemitones) || s.tom || "G";
  const transposedCifra = transposeCifraText(rawCifra, curCifraSemitones);
  const formattedCifraHtml = formatCifraHTML(transposedCifra);

  const isFav = s.isHarpa ? harpaFavs.includes(s.n) : false;

  // Letra formatada para o Cantor
  const stanzas = s.lyrics.split(/\n\n+/);
  const cantorLyricsHtml = stanzas
    .map((st) => {
      const isChorus = isChorusStanza(st) || /coro|refrão/i.test(st);
      return `<div class="cantor-block ${isChorus ? "is-chorus" : ""}">${isChorus ? '<span class="hymn-chorus-tag">🎶 Coro</span>' : ""}${escapeHtml(st)}</div>`;
    })
    .join("");

  const youtubePlayerHtml = buildYoutubePlayerHtml(s);
  const activeYtId = s.youtubeId || localStorage.getItem("worship_yt_" + s.id) || null;
  const cifraClubBarHtml = buildCifraClubChordsBar(transposedCifra, s);

  if (curBandMode === "duo") {
    // ---------------- MODO DUPLO: LETRA NO CANTO & CIFRAS AO LADO ----------------
    reader.innerHTML = `
      <div class="duo-worship-container">
        <h2>${s.isHarpa ? `Hino ${s.n} · ` : ""}${escapeHtml(s.title)}</h2>
        <div class="testament">${escapeHtml(s.artist || "Louvor Congregacional")} · Letra no Canto & Cifras ao Lado (Padrão Cifra Club)</div>

        ${youtubePlayerHtml}

        <div class="cifra-toolbar duo-toolbar">
          <div class="cifra-tool-group">
            <button type="button" class="cifra-tool-btn" id="btnTransposeDown" title="Abaixar meio tom">◀ Tom</button>
            <span class="cifra-key-pill" id="cifraKeyBadge">Tom: ${escapeHtml(currentKey)}</span>
            <button type="button" class="cifra-tool-btn" id="btnTransposeUp" title="Aumentar meio tom">Tom ▶</button>
          </div>
          <div class="cifra-tool-group">
            <button type="button" class="cifra-tool-btn" id="btnFontDown" title="Diminuir fonte">A-</button>
            <button type="button" class="cifra-tool-btn" id="btnFontUp" title="Aumentar fonte">A+</button>
            <button type="button" class="cifra-tool-btn ${isCifraAutoScrolling ? "active" : ""}" id="btnAutoScroll" title="Rolagem automática da tela">${isCifraAutoScrolling ? "⏸ Pausar" : "▶ Rolar Tela"}</button>
            <button type="button" class="cifra-tool-btn" id="btnScrollSpeed" title="Velocidade da rolagem">${curAutoScrollSpeed}x</button>
          </div>
          <div class="cifra-tool-group">
            ${activeYtId ? `<button type="button" class="cifra-tool-btn" id="btnToggleYtCollapse">${isYtCollapsed ? "▶️ Ver Vídeo" : "➖ Ocultar Vídeo"}</button>` : `<button type="button" class="cifra-tool-btn" id="btnEditYtLink">📺 + YouTube</button>`}
            <button type="button" class="cifra-tool-btn" id="btnEditCifra">✏️ Cifra</button>
            <button type="button" class="cifra-tool-btn" id="btnCopyCifra">📋 Copiar</button>
          </div>
        </div>

        <div class="duo-worship-grid">
          <!-- Coluna 1 (Canto): LETRA PARA O CANTOR -->
          <div class="duo-col duo-lyrics-col">
            <div class="duo-col-header">
              <span class="duo-col-badge">🎤 LETRA (CANTOR)</span>
              <span class="duo-col-sub">Letra limpa sem acordes</span>
            </div>
            <div class="cantor-lyrics-box" id="cantorLyricsBox" style="font-size: ${curCifraFontSize + 2}px">
              ${cantorLyricsHtml}
            </div>
          </div>

          <!-- Coluna 2 (Lado): CIFRA PARA O MÚSICO -->
          <div class="duo-col duo-cifra-col">
            <div class="duo-col-header">
              <span class="duo-col-badge">🎸 CIFRA (VIOLÃO / TECLADO)</span>
              <span class="duo-col-sub">Tom: ${escapeHtml(currentKey)} · Padrão Cifra Club</span>
            </div>
            ${cifraClubBarHtml}
            <div class="cifra-view-container" id="cifraViewContainer" style="font-size: ${curCifraFontSize}px">
              ${formattedCifraHtml || '<div class="empty">Cifra não disponível.</div>'}
            </div>
          </div>
        </div>

        <div class="hymn-actions">
          <button type="button" class="btn-outline" data-hact="meditate">☕ Meditar com o Mestre</button>
          ${s.isHarpa ? `<button type="button" class="btn-ghost-gold" data-hact="fav">${isFav ? "★ Favoritado" : "⭐ Favoritar"}</button>` : ""}
          <button type="button" class="btn-ghost-gold" data-hact="copy">📋 Copiar letra</button>
        </div>
        <div class="chapter-nav">
          <button type="button" data-hgo="-1" ${!s.isHarpa || s.n <= 1 ? "hidden" : ""}>‹ Hino anterior</button>
          <button type="button" data-hgo="1" ${!s.isHarpa || s.n >= HARPA?.length ? "hidden" : ""}>Próximo hino ›</button>
        </div>
      </div>
    `;
  } else if (curBandMode === "cantor") {
    // ---------------- MODO 1: CANTOR ----------------
    reader.innerHTML = `
      <h2>${s.isHarpa ? `Hino ${s.n} · ` : ""}${escapeHtml(s.title)}</h2>
      <div class="testament">${escapeHtml(s.artist || "Louvor Congregacional")} · Modo Cantor</div>

      ${youtubePlayerHtml}

      <div class="cantor-meta-bar">
        <span>🎵 Tom: ${escapeHtml(currentKey)}</span>
        <span>⏱️ Andamento: ${s.bpm || 70} BPM</span>
        <div class="cifra-tool-group">
          <button type="button" class="cifra-tool-btn" id="btnFontDown" title="Diminuir fonte">A-</button>
          <button type="button" class="cifra-tool-btn" id="btnFontUp" title="Aumentar fonte">A+</button>
          <button type="button" class="cifra-tool-btn" id="btnAutoScroll" title="Rolagem automática da tela">▶ Rolar</button>
        </div>
      </div>

      <div class="cantor-lyrics-box" id="cantorLyricsBox" style="font-size: ${curCifraFontSize + 2}px">
        ${cantorLyricsHtml}
      </div>

      <div class="hymn-actions">
        <button type="button" class="btn-outline" data-hact="meditate">☕ Meditar com o Mestre</button>
        ${s.isHarpa ? `<button type="button" class="btn-ghost-gold" data-hact="fav">${isFav ? "★ Favoritado" : "⭐ Favoritar"}</button>` : ""}
        <button type="button" class="btn-ghost-gold" data-hact="copy">📋 Copiar letra</button>
      </div>
      <div class="chapter-nav">
        <button type="button" data-hgo="-1" ${!s.isHarpa || s.n <= 1 ? "hidden" : ""}>‹ Hino anterior</button>
        <button type="button" data-hgo="1" ${!s.isHarpa || s.n >= HARPA?.length ? "hidden" : ""}>Próximo hino ›</button>
      </div>
    `;
  } else if (curBandMode === "violao") {
    // ---------------- MODO 2: VIOLÃO & GUITARRA ----------------
    reader.innerHTML = `
      <h2>${s.isHarpa ? `Hino ${s.n} · ` : ""}${escapeHtml(s.title)}</h2>
      <div class="testament">${escapeHtml(s.artist || "Louvor Congregacional")} · Violão & Guitarra</div>

      ${youtubePlayerHtml}

      <div class="instrument-card">
        <div class="instrument-card-head">
          <span>🎸 Levada / Batida do Violão</span>
          <span class="card-tag">Compasso: ${escapeHtml(s.compasso || "4/4")}</span>
        </div>
        <div class="instrument-card-body">
          <b>Ritmo sugerido:</b> ${escapeHtml(s.batidaViolao || "Dedilhado suave nas estrofes; batida cheia e crescente no refrão.")}
        </div>
      </div>

      <div class="cifra-toolbar">
        <div class="cifra-tool-group">
          <button type="button" class="cifra-tool-btn" id="btnTransposeDown" title="Abaixar meio tom">◀ Tom</button>
          <span class="cifra-key-pill" id="cifraKeyBadge">Tom: ${escapeHtml(currentKey)}</span>
          <button type="button" class="cifra-tool-btn" id="btnTransposeUp" title="Aumentar meio tom">Tom ▶</button>
        </div>
        <div class="cifra-tool-group">
          <button type="button" class="cifra-tool-btn" id="btnFontDown">A-</button>
          <button type="button" class="cifra-tool-btn" id="btnFontUp">A+</button>
          <button type="button" class="cifra-tool-btn" id="btnAutoScroll">▶ Rolar</button>
        </div>
        <div class="cifra-tool-group">
          <button type="button" class="cifra-tool-btn" id="btnEditCifra">✏️ Editar</button>
          <button type="button" class="cifra-tool-btn" id="btnCopyCifra">📋 Copiar</button>
        </div>
      </div>

      ${cifraClubBarHtml}

      <div class="cifra-view-container" id="cifraViewContainer" style="font-size: ${curCifraFontSize}px">
        ${formattedCifraHtml || '<div class="empty">Cifra não disponível. Toque em Editar para colar.</div>'}
      </div>

      <div class="hymn-actions">
        <button type="button" class="btn-outline" data-hact="meditate">☕ Meditar com o Mestre</button>
        ${s.isHarpa ? `<button type="button" class="btn-ghost-gold" data-hact="fav">${isFav ? "★ Favoritado" : "⭐ Favoritar"}</button>` : ""}
      </div>
      <div class="chapter-nav">
        <button type="button" data-hgo="-1" ${!s.isHarpa || s.n <= 1 ? "hidden" : ""}>‹ Hino anterior</button>
        <button type="button" data-hgo="1" ${!s.isHarpa || s.n >= HARPA?.length ? "hidden" : ""}>Próximo hino ›</button>
      </div>
    `;
  } else if (curBandMode === "teclado") {
    // ---------------- MODO 3: TECLADO & PIANO ----------------
    const uniqueChords = extractUniqueChords(transposedCifra);
    const chordPills = uniqueChords
      .map((ch) => {
        const notes = CHORD_NOTES_MAP[ch] || CHORD_NOTES_MAP[ch.replace(/m|7|9/g, "")] || "Acorde";
        return `<div class="chord-note-pill"><b>${ch}:</b> ${notes}</div>`;
      })
      .join("");

    reader.innerHTML = `
      <h2>${s.isHarpa ? `Hino ${s.n} · ` : ""}${escapeHtml(s.title)}</h2>
      <div class="testament">${escapeHtml(s.artist || "Louvor Congregacional")} · Teclado & Piano</div>

      ${youtubePlayerHtml}

      <div class="instrument-card">
        <div class="instrument-card-head">
          <span>🎹 Guia de Teclado & Formação dos Acordes</span>
          <span class="card-tag">Tom: ${escapeHtml(currentKey)}</span>
        </div>
        <div class="instrument-card-body">
          <div><b>Dica de Ambiência:</b> ${escapeHtml(s.teclado || "Usar Pad atmosférico com acordes abertos na mão esquerda e condução suave no piano")}</div>
          <div class="chord-pills-row" style="margin-top:10px">
            ${chordPills || '<span style="font-size:.82rem;color:var(--muted)">Acordes em Sol Maior</span>'}
          </div>
        </div>
      </div>

      <div class="cifra-toolbar">
        <div class="cifra-tool-group">
          <button type="button" class="cifra-tool-btn" id="btnTransposeDown" title="Abaixar meio tom">◀ Tom</button>
          <span class="cifra-key-pill" id="cifraKeyBadge">Tom: ${escapeHtml(currentKey)}</span>
          <button type="button" class="cifra-tool-btn" id="btnTransposeUp" title="Aumentar meio tom">Tom ▶</button>
        </div>
        <div class="cifra-tool-group">
          <button type="button" class="cifra-tool-btn" id="btnFontDown">A-</button>
          <button type="button" class="cifra-tool-btn" id="btnFontUp">A+</button>
          <button type="button" class="cifra-tool-btn" id="btnAutoScroll">▶ Rolar</button>
        </div>
        <div class="cifra-tool-group">
          <button type="button" class="cifra-tool-btn" id="btnEditCifra">✏️ Editar</button>
        </div>
      </div>

      ${cifraClubBarHtml}

      <div class="cifra-view-container" id="cifraViewContainer" style="font-size: ${curCifraFontSize}px">
        ${formattedCifraHtml || '<div class="empty">Cifra não disponível.</div>'}
      </div>

      <div class="hymn-actions">
        <button type="button" class="btn-outline" data-hact="meditate">☕ Meditar com o Mestre</button>
      </div>
      <div class="chapter-nav">
        <button type="button" data-hgo="-1" ${!s.isHarpa || s.n <= 1 ? "hidden" : ""}>‹ Hino anterior</button>
        <button type="button" data-hgo="1" ${!s.isHarpa || s.n >= HARPA?.length ? "hidden" : ""}>Próximo hino ›</button>
      </div>
    `;
  } else if (curBandMode === "bateria") {
    // ---------------- MODO 4: BATERIA & RITMO ----------------
    const beatsCount = s.compasso && s.compasso.includes("3") ? 3 : s.compasso && s.compasso.includes("6") ? 6 : 4;
    const dotsHtml = Array.from({ length: beatsCount })
      .map((_, i) => `<div class="metronome-beat-dot" data-beat="${i}"></div>`)
      .join("");

    reader.innerHTML = `
      <h2>${s.isHarpa ? `Hino ${s.n} · ` : ""}${escapeHtml(s.title)}</h2>
      <div class="testament">${escapeHtml(s.artist || "Louvor Congregacional")} · Bateria & Metrônomo</div>

      ${youtubePlayerHtml}

      <div class="bateria-dashboard">
        <div class="bpm-label">Andamento & Compasso (${escapeHtml(s.compasso || "4/4")})</div>
        <div class="bpm-display" id="bpmNumber">${s.bpm || 70} <span style="font-size:1.1rem;color:var(--muted)">BPM</span></div>
        <div class="bpm-controls">
          <button type="button" class="cifra-tool-btn" id="btnBpmDown">- 5 BPM</button>
          <button type="button" class="btn-metronome-toggle" id="btnToggleMetronome">▶ Ligar Metrônomo</button>
          <button type="button" class="cifra-tool-btn" id="btnBpmUp">+ 5 BPM</button>
        </div>
        <div class="metronome-visual-row">
          ${dotsHtml}
        </div>
        <div class="drum-conduction-box">
          <div style="font-weight:700;color:var(--brown);margin-bottom:4px">🥁 Guia de Condução da Bateria:</div>
          <div>${escapeHtml(s.bateria || "Versos suaves no chimbal/shaker. Construa dinâmica na ponte e conduza firme no refrão.")}</div>
          <div style="margin-top:6px;font-size:.82rem;color:var(--muted)"><b>Estilo musical:</b> ${escapeHtml(s.estilo || "Worship")}</div>
        </div>
      </div>

      <div class="cantor-lyrics-box" style="font-size:${curCifraFontSize}px;opacity:.92">
        <h3 style="font-family:'Lora',serif;font-size:1.15rem;color:var(--brown);margin-bottom:12px">Acompanhamento da Letra (Estrutura da Música):</h3>
        ${cantorLyricsHtml}
      </div>

      <div class="hymn-actions">
        <button type="button" class="btn-outline" data-hact="meditate">☕ Meditar com o Mestre</button>
      </div>
      <div class="chapter-nav">
        <button type="button" data-hgo="-1" ${!s.isHarpa || s.n <= 1 ? "hidden" : ""}>‹ Hino anterior</button>
        <button type="button" data-hgo="1" ${!s.isHarpa || s.n >= HARPA?.length ? "hidden" : ""}>Próximo hino ›</button>
      </div>
    `;

    $("#btnToggleMetronome")?.addEventListener("click", () => {
      if (isMetronomeRunning) {
        stopMetronome();
      } else {
        startMetronome(s.bpm || 70, beatsCount);
      }
    });
    $("#btnBpmDown")?.addEventListener("click", () => {
      s.bpm = Math.max(40, (s.bpm || 70) - 5);
      const disp = $("#bpmNumber");
      if (disp) disp.innerHTML = `${s.bpm} <span style="font-size:1.1rem;color:var(--muted)">BPM</span>`;
      if (isMetronomeRunning) startMetronome(s.bpm, beatsCount);
    });
    $("#btnBpmUp")?.addEventListener("click", () => {
      s.bpm = Math.min(220, (s.bpm || 70) + 5);
      const disp = $("#bpmNumber");
      if (disp) disp.innerHTML = `${s.bpm} <span style="font-size:1.1rem;color:var(--muted)">BPM</span>`;
      if (isMetronomeRunning) startMetronome(s.bpm, beatsCount);
    });
  }

  // Eventos comuns aos modos
  $("#btnTransposeDown")?.addEventListener("click", () => {
    curCifraSemitones -= 1;
    renderCurrentBandView();
  });
  $("#btnTransposeUp")?.addEventListener("click", () => {
    curCifraSemitones += 1;
    renderCurrentBandView();
  });
  $("#btnFontDown")?.addEventListener("click", () => {
    if (curCifraFontSize > 11) curCifraFontSize -= 1;
    const cifraBox = $("#cifraViewContainer");
    const lyricsBox = $("#cantorLyricsBox");
    if (cifraBox) cifraBox.style.fontSize = curCifraFontSize + "px";
    if (lyricsBox) lyricsBox.style.fontSize = (curCifraFontSize + 2) + "px";
  });
  $("#btnFontUp")?.addEventListener("click", () => {
    if (curCifraFontSize < 26) curCifraFontSize += 1;
    const cifraBox = $("#cifraViewContainer");
    const lyricsBox = $("#cantorLyricsBox");
    if (cifraBox) cifraBox.style.fontSize = curCifraFontSize + "px";
    if (lyricsBox) lyricsBox.style.fontSize = (curCifraFontSize + 2) + "px";
  });
  $("#btnAutoScroll")?.addEventListener("click", toggleCifraAutoScroll);
  $("#btnScrollSpeed")?.addEventListener("click", () => {
    if (curAutoScrollSpeed === 1) curAutoScrollSpeed = 1.5;
    else if (curAutoScrollSpeed === 1.5) curAutoScrollSpeed = 2;
    else if (curAutoScrollSpeed === 2) curAutoScrollSpeed = 0.75;
    else curAutoScrollSpeed = 1;

    const btn = $("#btnScrollSpeed");
    if (btn) btn.textContent = curAutoScrollSpeed + "x";

    if (isCifraAutoScrolling) {
      clearInterval(cifraAutoScrollTimer);
      const speedMs = Math.max(15, Math.round(45 / curAutoScrollSpeed));
      cifraAutoScrollTimer = setInterval(() => {
        const reader = $("#harpaReader");
        if (!isCifraAutoScrolling || !reader) return;
        reader.scrollTop += 1;
        if (reader.scrollTop + reader.clientHeight >= reader.scrollHeight) {
          toggleCifraAutoScroll();
        }
      }, speedMs);
    }
  });

  $("#btnToggleYtCollapse")?.addEventListener("click", () => {
    isYtCollapsed = !isYtCollapsed;
    const box = $("#ytIframeBox");
    const btn = $("#btnToggleYtCollapse");
    if (box) box.style.display = isYtCollapsed ? "none" : "";
    if (btn) btn.textContent = isYtCollapsed ? "▶️ Expandir Vídeo" : "➖ Recolher Vídeo";
  });

  $("#btnToggleYtEmbed")?.addEventListener("click", () => {
    isYtCollapsed = !isYtCollapsed;
    const box = $("#ytIframeBox");
    const btn = $("#btnToggleYtCollapse");
    if (box) box.style.display = isYtCollapsed ? "none" : "";
    if (btn) btn.textContent = isYtCollapsed ? "▶️ Expandir Vídeo" : "➖ Recolher Vídeo";
    const toggleBtn = $("#btnToggleYtEmbed");
    if (toggleBtn) toggleBtn.textContent = isYtCollapsed ? "📺 Ver Vídeo" : "📺 Ocultar Vídeo";
  });

  $("#btnEditYtLink")?.addEventListener("click", () => {
    const currYt = s.youtubeId || localStorage.getItem("worship_yt_" + s.id) || "";
    const input = prompt(
      "Cole o link do YouTube para este louvor:\n(Exemplo: https://www.youtube.com/watch?v=TVlBJwDZu0M)",
      currYt ? `https://www.youtube.com/watch?v=${currYt}` : ""
    );
    if (input !== null) {
      const vidId = extractYoutubeId(input);
      if (vidId) {
        s.youtubeId = vidId;
        localStorage.setItem("worship_yt_" + s.id, vidId);
        isYtCollapsed = false;
        toast("Vídeo do YouTube configurado! 📺");
        renderCurrentBandView();
      } else if (!input.trim()) {
        s.youtubeId = null;
        localStorage.removeItem("worship_yt_" + s.id);
        toast("Vídeo do YouTube removido.");
        renderCurrentBandView();
      } else {
        toast("Link do YouTube não reconhecido.");
      }
    }
  });

  $("#btnEditCifra")?.addEventListener("click", () => openCifraModal(s, rawCifra));
  $("#btnCopyCifra")?.addEventListener("click", () => {
    copyText(`${s.title}\n\n${transposedCifra}`);
  });
}

function openSongForBand(songData) {
  curSongData = songData;
  curCifraSemitones = 0;
  setView("harpa");
  $("#harpaIndexView").hidden = true;
  $("#harpaReaderView").hidden = false;

  $("#harpaPrevBtn").disabled = !songData.isHarpa || songData.n <= 1;
  $("#harpaNextBtn").disabled = !songData.isHarpa || songData.n >= HARPA?.length;

  renderCurrentBandView();
}

function openHymn(n) {
  if (!HARPA) return;
  const h = HARPA.find((x) => x.n === n);
  if (!h) return;
  curHymnNum = h.n;

  const rawCifra = localStorage.getItem(CIFRA_STORAGE_PREFIX + h.n) || BUILTIN_CIFRAS[h.n] || "";
  const isWaltz = h.lyrics.includes("3/") || /valsa/i.test(h.title);

  const songData = {
    id: "harpa:" + h.n,
    isHarpa: true,
    n: h.n,
    title: h.title,
    artist: "Harpa Cristã (Hino " + h.n + ")",
    tom: "G",
    bpm: isWaltz ? 84 : 76,
    compasso: isWaltz ? "3/4" : "4/4",
    estilo: isWaltz ? "Valsa Tradicional" : "Marcha / Hino Sacro",
    batidaViolao: isWaltz ? "Valsa dedilhada (P - i - m) ou batida 3/4 (↓  ↑↓  ↑↓)" : "Batida tradicional de hino 4/4 (↓  ↓↑  ↑↓↑)",
    teclado: "Acordes cheios com sustentação harmônica de órgão ou piano de cauda",
    bateria: isWaltz ? "Condução 3/4 suave com vassourinha ou chimbal" : "Marcação firme 4/4 no bumbo com caixa no tempo 2 e 4",
    lyrics: h.lyrics,
    cifra: rawCifra
  };

  openSongForBand(songData);
}

function renderHarpaList(submitTriggered = false) {
  const listEl = $("#harpaList");
  if (!HARPA) {
    listEl.innerHTML = `<div class="loading">Carregando os 524 hinos da Harpa Cristã…</div>`;
    return;
  }

  const rawQ = ($("#harpaSearchInput").value || "").trim();
  const numMatch = rawQ.match(/^(?:hino\s*|n[º°]?\s*|#)?(\d{1,3})$/i);
  const exactNum = numMatch ? Number(numMatch[1]) : null;

  // Se o usuário digitou um número exato e apertou Enter, abre o hino direto!
  if (submitTriggered && exactNum && exactNum >= 1 && exactNum <= HARPA.length) {
    openHymn(exactNum);
    return;
  }

  const nq = norm(rawQ);
  const favSet = new Set(harpaFavs);
  const worshipLib = getWorshipLibrary();

  // Se clicou na aba de Louvores Salvos
  if (curHarpaRange === "LOUVORES" && !rawQ) {
    let html = `<p class="count">${worshipLib.length} louvor(es) da igreja disponíveis</p><div class="harpa-grid">`;
    for (const song of worshipLib) {
      const hasYt = song.youtubeId || localStorage.getItem("worship_yt_" + song.id);
      html += `
        <button type="button" class="harpa-card" data-worship="${escapeHtml(song.id)}">
          <div class="harpa-num" style="background:${hasYt ? "#ffe8e8" : "#f4e4c8"};font-size:1.1rem">${hasYt ? "📺" : "🎸"}</div>
          <div class="harpa-info">
            <div class="harpa-title">${escapeHtml(song.title)} ${hasYt ? '<span class="youtube-badge">▶ YouTube</span>' : ""}</div>
            <div class="harpa-snip">${escapeHtml(song.artist || "Louvor da Igreja")} · Tom: ${song.tom || "G"} · ${song.bpm || 70} BPM</div>
          </div>
        </button>
      `;
    }
    html += `</div>`;
    listEl.innerHTML = html;
    listEl.scrollTop = 0;
    return;
  }

  let filtered = HARPA;
  let matchingWorship = [];
  const ytMatch = extractYoutubeId(rawQ);

  if (rawQ) {
    matchingWorship = worshipLib.filter((w) => {
      if (ytMatch && (w.youtubeId === ytMatch || localStorage.getItem("worship_yt_" + w.id) === ytMatch)) return true;
      return norm(w.title).includes(nq) || norm(w.artist || "").includes(nq);
    });
    if (exactNum) {
      const exact = HARPA.filter((h) => h.n === exactNum);
      const partial = HARPA.filter((h) => h.n !== exactNum && String(h.n).includes(String(exactNum)));
      filtered = [...exact, ...partial];
    } else {
      const byTitle = [];
      const byLyrics = [];
      for (const h of HARPA) {
        if (String(h.n) === rawQ || h.normTitle.includes(nq)) byTitle.push(h);
        else if (nq.length >= 2 && h.normLyrics.includes(nq)) byLyrics.push(h);
      }
      filtered = [...byTitle, ...byLyrics];
    }
  } else if (curHarpaRange === "FAV") {
    filtered = HARPA.filter((h) => favSet.has(h.n));
  } else if (curHarpaRange !== "ALL") {
    const [min, max] = curHarpaRange.split("-").map(Number);
    filtered = HARPA.filter((h) => h.n >= min && h.n <= max);
  }

  // Se o usuário digitou Enter numa busca de louvor contemporâneo
  if (submitTriggered && rawQ && !exactNum && matchingWorship.length > 0) {
    openSongForBand(matchingWorship[0]);
    return;
  }

  let html = "";

  // Botão para gerar com IA qualquer louvor digitado fora da Harpa ou link do YouTube
  if (rawQ && rawQ.length >= 2) {
    if (ytMatch && !matchingWorship.length) {
      html += `
        <div class="search-ai-louvor-card youtube-search-card" style="border: 2px solid #e62117; background: #fffcfc;">
          <div style="font-size:2rem;margin-bottom:4px">📺 ▶️</div>
          <div style="font-weight:700;color:#c00;font-size:1.15rem">Música do YouTube Detectada!</div>
          <p style="font-size:.88rem;color:var(--muted);margin:4px 0 14px">O Mestre Pastoral vai carregar o vídeo, montar a <b>Letra no canto</b> e as <b>Cifras ao lado</b> com rolagem para acompanhar ao vivo.</p>
          <button type="button" class="btn-gold" id="btnRunAILouvor" style="background:#e62117;color:#fff;border-color:#b8140c">📺 Abrir Louvor com Vídeo do YouTube</button>
        </div>
      `;
    } else {
      html += `
        <div class="search-ai-louvor-card">
          <div style="font-size:1.9rem;margin-bottom:4px">✨🎸</div>
          <div style="font-weight:700;color:var(--brown);font-size:1.1rem">Música da Igreja: “${escapeHtml(rawQ)}”</div>
          <p style="font-size:.86rem;color:var(--muted);margin:4px 0 14px">O Mestre Pastoral pesquisa e monta a Letra para o Cantor, Cifra para Violão/Teclado e Ritmo/Metrônomo para a Bateria.</p>
          <button type="button" class="btn-gold" id="btnRunAILouvor">🎸 Abrir “${escapeHtml(rawQ)}” para a Banda com IA</button>
        </div>
      `;
    }
  }

  if (matchingWorship.length > 0) {
    html += `<p class="count">Louvores da Igreja encontrados:</p><div class="harpa-grid" style="margin-bottom:20px">`;
    for (const song of matchingWorship) {
      const hasYt = song.youtubeId || localStorage.getItem("worship_yt_" + song.id);
      html += `
        <button type="button" class="harpa-card" data-worship="${escapeHtml(song.id)}">
          <div class="harpa-num" style="background:${hasYt ? "#ffe8e8" : "#f4e4c8"};font-size:1.1rem">${hasYt ? "📺" : "🎸"}</div>
          <div class="harpa-info">
            <div class="harpa-title">${escapeHtml(song.title)} ${hasYt ? '<span class="youtube-badge">▶ YouTube</span>' : ""}</div>
            <div class="harpa-snip">${escapeHtml(song.artist || "Louvor da Igreja")} · Tom: ${song.tom || "G"}</div>
          </div>
        </button>
      `;
    }
    html += `</div>`;
  }

  if (filtered.length > 0) {
    html += `<p class="count">${filtered.length} hino(s) da Harpa ${rawQ ? `encontrado(s) para “${escapeHtml(rawQ)}”` : "na lista"}</p><div class="harpa-grid">`;
    for (const h of filtered) {
      const titleHtml = nq && !exactNum && h.normTitle.includes(nq) ? highlight(h.title, h.normTitle, nq) : escapeHtml(h.title);
      const star = favSet.has(h.n) ? `<span class="harpa-star" title="Favorito">★</span>` : "";
      html += `<button type="button" class="harpa-card" data-hymn="${h.n}">
        <div class="harpa-num">${h.n}</div>
        <div class="harpa-info">
          <div class="harpa-title">${titleHtml}</div>
          <div class="harpa-snip">${escapeHtml(h.firstLine)}</div>
        </div>
        ${star}
      </button>`;
    }
    html += `</div>`;
  } else if (!matchingWorship.length && !rawQ) {
    html += `<p class="empty">Nenhum item encontrado.</p>`;
  }

  listEl.innerHTML = html;
  listEl.scrollTop = 0;

  $("#btnRunAILouvor")?.addEventListener("click", () => {
    if (/https?:\/\//i.test(rawQ) || /cifraclub\.com|youtube\.com|youtu\.be/i.test(rawQ)) {
      handleSongLinkInput(rawQ);
    } else {
      generateAILouvor(rawQ);
    }
  });
}

function initHarpaEvents() {
  let timer;
  const searchInput = $("#harpaSearchInput");

  searchInput?.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    if (text && (/https?:\/\//i.test(text) || /cifraclub\.com|youtube\.com|youtu\.be/i.test(text))) {
      e.preventDefault();
      searchInput.value = text.trim();
      handleSongLinkInput(text.trim());
    }
  });

  $("#btnDemoTudoEPerda")?.addEventListener("click", () => {
    handleSongLinkInput("https://www.cifraclub.com.br/felipe-rodrigues/tudo-e-perda/");
  });

  $("#btnDemoNaoHaBarreiras")?.addEventListener("click", () => {
    handleSongLinkInput("https://www.youtube.com/watch?v=TVlBJwDZu0M");
  });

  $("#harpaSearchForm").onsubmit = (e) => {
    e.preventDefault();
    clearTimeout(timer);
    const q = (searchInput?.value || "").trim();
    if (/https?:\/\//i.test(q) || /cifraclub\.com|youtube\.com|youtu\.be/i.test(q)) {
      handleSongLinkInput(q);
      return;
    }
    renderHarpaList(true);
  };
  $("#harpaSearchInput").oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => renderHarpaList(false), 180);
  };
  $("#harpaFilters").addEventListener("click", (e) => {
    const b = e.target.closest("[data-range]");
    if (!b) return;
    curHarpaRange = b.dataset.range;
    $("#harpaSearchInput").value = "";
    document.querySelectorAll("#harpaFilters .pill").forEach((p) => p.classList.toggle("active", p === b));
    renderHarpaList(false);
  });
  $("#harpaList").addEventListener("click", (e) => {
    const hymnBtn = e.target.closest("[data-hymn]");
    if (hymnBtn) {
      openHymn(Number(hymnBtn.dataset.hymn));
      return;
    }
    const worshipBtn = e.target.closest("[data-worship]");
    if (worshipBtn) {
      const wId = worshipBtn.dataset.worship;
      const song = getWorshipLibrary().find((w) => w.id === wId);
      if (song) openSongForBand(song);
    }
  });

  $("#btnSwitchHarpa")?.addEventListener("click", () => {
    $("#btnSwitchHarpa").classList.add("active");
    $("#btnSwitchWorship").classList.remove("active");
    $("#worshipBanner").hidden = true;
    $("#harpaFilters").hidden = false;
    $("#harpaSearchInput").placeholder = "Digite o número (ex.: 39) ou nome do hino da Harpa…";
    curHarpaRange = "ALL";
    $("#harpaSearchInput").value = "";
    document.querySelectorAll("#harpaFilters .pill").forEach((p, idx) => p.classList.toggle("active", idx === 0));
    renderHarpaList(false);
  });

  $("#btnSwitchWorship")?.addEventListener("click", () => {
    $("#btnSwitchWorship").classList.add("active");
    $("#btnSwitchHarpa").classList.remove("active");
    $("#worshipBanner").hidden = false;
    $("#harpaFilters").hidden = true;
    $("#harpaSearchInput").placeholder = "Cole o link do YouTube, Cifra Club ou digite o nome da música…";
    curHarpaRange = "LOUVORES";
    $("#harpaSearchInput").value = "";
    renderHarpaList(false);
    setTimeout(() => $("#harpaSearchInput").focus(), 80);
  });

  $("#harpaBackBtn").onclick = () => {
    stopMetronome();
    if (isCifraAutoScrolling) toggleCifraAutoScroll();
    showHarpaIndex();
  };
  $("#harpaPrevBtn").onclick = () => {
    if (curSongData?.isHarpa) openHymn(curSongData.n - 1);
  };
  $("#harpaNextBtn").onclick = () => {
    if (curSongData?.isHarpa) openHymn(curSongData.n + 1);
  };

  // Seletor de Modo da Banda (Cantor, Violão, Teclado, Bateria)
  document.querySelectorAll(".band-mode-selector .bmode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      curBandMode = btn.dataset.bmode;
      renderCurrentBandView();
    });
  });

  // Modal de edição de cifra
  $("#cifraEditClose")?.addEventListener("click", () => ($("#cifraEditModal").hidden = true));
  $("#cifraEditCancel")?.addEventListener("click", () => ($("#cifraEditModal").hidden = true));
  $("#cifraEditSave")?.addEventListener("click", () => {
    const val = $("#cifraEditText").value.trim();
    if (!val) {
      toast("A cifra não pode estar vazia");
      return;
    }
    if (curSongData) {
      curSongData.cifra = val;
      if (curSongData.isHarpa) {
        localStorage.setItem(CIFRA_STORAGE_PREFIX + curSongData.n, val);
      } else {
        saveCustomWorship(curSongData);
      }
    }
    $("#cifraEditModal").hidden = true;
    toast("Cifra salva com sucesso! 🎸");
    curCifraSemitones = 0;
    renderCurrentBandView();
  });

  $("#harpaStudyBtn").onclick = () => {
    if (!curSongData) return;
    askMaster(
      `Medite comigo no louvor '${curSongData.title}' (${curSongData.artist || "Harpa Cristã"}) e me mostre como usar sua mensagem em uma pregação.`,
      "estudo",
      { ref: `Louvor — ${curSongData.title}`, text: curSongData.lyrics }
    );
  };

  $("#harpaReader").addEventListener("click", (e) => {
    const go = e.target.closest("[data-hgo]");
    if (go && curSongData?.isHarpa) {
      return openHymn(curSongData.n + Number(go.dataset.hgo));
    }
    const act = e.target.closest("[data-hact]")?.dataset.hact;
    if (!act || !curSongData) return;
    const fullText = `${curSongData.title} — ${curSongData.artist || "Louvor da Igreja"}\n\n${curSongData.lyrics}`;
    if (act === "meditate") {
      $("#harpaStudyBtn").click();
    } else if (act === "copy") {
      copyText(fullText);
    } else if (act === "fav" && curSongData.isHarpa) {
      if (harpaFavs.includes(curSongData.n)) {
        harpaFavs = harpaFavs.filter((x) => x !== curSongData.n);
        toast("Removido dos favoritos da Harpa");
      } else {
        harpaFavs = [curSongData.n, ...harpaFavs];
        toast("Salvo nos favoritos da Harpa ⭐");
      }
      saveHarpaFavs();
      renderCurrentBandView();
    }
  });
}

let harpaLoading = false;
async function loadHarpa() {
  if (HARPA || harpaLoading) return;
  harpaLoading = true;
  try {
    let res = await fetch("bible/harpa.json?v=5");
    if (!res.ok) res = await fetch("bible/harpa.json?v=5", { cache: "reload" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    HARPA = data.hymns.map((h) => {
      const firstLine = (h.lyrics.split(/\r?\n/)[0] || "").replace(/^\d{1,2}[\s.]+/, "");
      return {
        ...h,
        firstLine,
        normTitle: norm(h.title),
        normLyrics: norm(h.lyrics),
      };
    });
    renderHarpaList(false);
  } catch (err) {
    $("#harpaList").innerHTML = `<div class="empty">Não foi possível carregar a Harpa Cristã (${escapeHtml(err.message)}).<br><br><button type="button" class="btn-outline" onclick="loadHarpa()">🔄 Tentar novamente</button></div>`;
  } finally {
    harpaLoading = false;
  }
}

// ---------- Oferta (Ação Social + Custeio + Painel Exclusivo do ADM) ----------
const OFERTA_LOCAL_KEY = "mestre-pastoral:oferta-cache";
let ofertaConfig = loadJSON(OFERTA_LOCAL_KEY, {
  title: "Ajude Famílias e Mantenha Esta Obra no Ar",
  subtitle:
    "Sua oferta de amor transforma vidas através de cestas básicas para famílias necessitadas e mantém o Mestre Pastoral gratuito e ativo para todos.",
  pixKey: "",
  pixType: "Chave PIX",
  pixHolder: "",
  pixBank: "Nubank",
  paymentLink: "",
  autoRedirect: false,
});
let admPinSession = "";
try {
  admPinSession = (typeof sessionStorage !== "undefined" && sessionStorage.getItem("mestre-pastoral:adm-pin")) || "";
} catch {}
let redirectTimer = null;

function stopOfertaRedirect() {
  if (redirectTimer) {
    clearTimeout(redirectTimer);
    redirectTimer = null;
  }
  const notice = $("#ofertaRedirectNotice");
  if (notice) notice.hidden = true;
}

function renderOferta(triggerRedirect = false) {
  stopOfertaRedirect();
  const c = ofertaConfig || {};
  if ($("#ofertaTitle") && c.title) $("#ofertaTitle").textContent = c.title;
  if ($("#ofertaSubtitle") && c.subtitle) $("#ofertaSubtitle").textContent = c.subtitle;

  const hasLink = Boolean(c.paymentLink && c.paymentLink.trim());
  const hasPix = Boolean(c.pixKey && c.pixKey.trim());

  const linkBox = $("#ofertaLinkBox");
  const pixBox = $("#ofertaPixBox");
  const emptyBox = $("#ofertaEmptyBox");

  if (linkBox) {
    linkBox.hidden = !hasLink;
    if (hasLink) {
      $("#ofertaLinkBtn").href = c.paymentLink.trim();
      $("#ofertaBankLabel").textContent = c.pixBank || "Nubank / Cartão / PIX";
    }
  }

  if (pixBox) {
    pixBox.hidden = !hasPix;
    if (hasPix) {
      $("#ofertaPixTypeLabel").textContent = "💠 " + (c.pixType || "Chave PIX Direta");
      $("#ofertaPixBank").textContent = c.pixBank || "Nubank";
      $("#ofertaPixKeyDisplay").textContent = c.pixKey.trim();
      const holderRow = $("#ofertaHolderRow");
      if (c.pixHolder && c.pixHolder.trim()) {
        holderRow.hidden = false;
        $("#ofertaPixHolder").textContent = c.pixHolder.trim();
      } else {
        holderRow.hidden = true;
      }
    }
  }

  if (emptyBox) {
    emptyBox.hidden = hasLink || hasPix;
  }

  // Se o redirecionamento automático estiver ativado pelo ADM e houver link cadastrado
  if (triggerRedirect && c.autoRedirect && hasLink && $("#admPanel")?.hidden) {
    const notice = $("#ofertaRedirectNotice");
    if (notice) {
      notice.hidden = false;
      notice.innerHTML = `<span>💜 Redirecionando em instantes para a página segura de pagamento (${escapeHtml(
        c.pixBank || "Nubank"
      )})…</span> <button type="button" id="cancelRedirectBtn" class="ghost" style="color:#4a157a;border-color:#b98ce0">Permanecer aqui</button>`;
      $("#cancelRedirectBtn")?.addEventListener("click", stopOfertaRedirect);
    }
    redirectTimer = setTimeout(() => {
      window.open(c.paymentLink.trim(), "_blank", "noopener");
      if (notice) {
        notice.innerHTML = `<span>✅ Página de pagamento aberta! Caso não tenha aberto, clique no botão roxo abaixo.</span>`;
      }
    }, 2800);
  }
}

function populateAdmForm() {
  const c = ofertaConfig || {};
  $("#admPaymentLink").value = c.paymentLink || "";
  $("#admAutoRedirect").checked = Boolean(c.autoRedirect);
  $("#admPixKey").value = c.pixKey || "";
  $("#admPixBank").value = c.pixBank || "Nubank";
  $("#admPixHolder").value = c.pixHolder || "";
  $("#admPixType").value = c.pixType || "Chave PIX (Nubank)";
  $("#admTitle").value = c.title || "Ajude Famílias e Mantenha Esta Obra no Ar";
  $("#admSubtitle").value =
    c.subtitle ||
    "Sua oferta de amor transforma vidas através de cestas básicas para famílias necessitadas e mantém o Mestre Pastoral gratuito e ativo para todos.";
}

async function loadOferta(triggerRedirect = false) {
  try {
    const res = await fetch("/api/oferta", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      ofertaConfig = { ...ofertaConfig, ...data };
      localStorage.setItem(OFERTA_LOCAL_KEY, JSON.stringify(ofertaConfig));
    }
  } catch {}
  renderOferta(triggerRedirect);
}

function isAdmDevice() {
  try {
    const host = typeof location !== "undefined" ? location.hostname : "";
    const search = typeof location !== "undefined" ? location.search : "";
    if (host === "localhost" || host === "127.0.0.1" || host.startsWith("192.168.")) return true;
    if (search.includes("adm")) return true;
    if (localStorage.getItem("mestre-pastoral:is-adm") === "1") return true;
  } catch {}
  return false;
}

function initOfertaEvents() {
  const admBtn = $("#toggleAdmBtn");
  if (admBtn) {
    admBtn.hidden = !isAdmDevice();
  }

  // Atalho secreto: tocar 5 vezes no selo "❤️ Generosidade que Transforma Vidas" revela o botão do ADM em qualquer aparelho
  let secretClicks = 0;
  $("#ofertaSecretBadge")?.addEventListener("click", () => {
    secretClicks++;
    if (secretClicks >= 5 && admBtn) {
      admBtn.hidden = false;
      admBtn.click();
      secretClicks = 0;
    }
  });

  $("#homeOfertaBanner")?.addEventListener("click", () => setView("oferta"));
  $("#homeOfertaBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setView("oferta");
  });

  $("#copyPixKeyBtn")?.addEventListener("click", () => {
    if (ofertaConfig.pixKey) {
      copyText(ofertaConfig.pixKey.trim());
      toast("Chave PIX copiada! Deus abençoe sua oferta 🙏");
    }
  });

  $("#toggleAdmBtn")?.addEventListener("click", async () => {
    stopOfertaRedirect();
    const panel = $("#admPanel");
    if (!panel.hidden) {
      panel.hidden = true;
      return;
    }
    const pin = admPinSession || prompt("🔒 Área restrita do Administrador (ADM).\nDigite a senha de ADM para configurar o PIX / Link:");
    if (!pin) return;

    try {
      const res = await fetch("/api/oferta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: pin.trim(), checkOnly: true }),
      });
      if (!res.ok) {
        admPinSession = "";
        try { sessionStorage.removeItem("mestre-pastoral:adm-pin"); } catch {}
        toast("Senha de ADM incorreta ❌");
        return;
      }
      admPinSession = pin.trim();
      try {
        sessionStorage.setItem("mestre-pastoral:adm-pin", admPinSession);
        localStorage.setItem("mestre-pastoral:is-adm", "1");
      } catch {}
      populateAdmForm();
      panel.hidden = false;
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
      toast("Painel do ADM desbloqueado 🔓");
    } catch {
      toast("Erro ao verificar senha no servidor");
    }
  });

  $("#closeAdmBtn")?.addEventListener("click", () => {
    $("#admPanel").hidden = true;
  });

  $("#admForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      pin: admPinSession,
      paymentLink: $("#admPaymentLink").value.trim(),
      autoRedirect: $("#admAutoRedirect").checked,
      pixKey: $("#admPixKey").value.trim(),
      pixBank: $("#admPixBank").value.trim() || "Nubank",
      pixHolder: $("#admPixHolder").value.trim(),
      pixType: $("#admPixType").value.trim() || "Chave PIX",
      title: $("#admTitle").value.trim(),
      subtitle: $("#admSubtitle").value.trim(),
    };
    try {
      const res = await fetch("/api/oferta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao salvar");
      ofertaConfig = { ...ofertaConfig, ...data.config };
      localStorage.setItem(OFERTA_LOCAL_KEY, JSON.stringify(ofertaConfig));
      renderOferta(false);
      $("#admPanel").hidden = true;
      toast("Dados de Oferta salvos e publicados com sucesso! 🙌");
    } catch (err) {
      toast("Não foi possível salvar: " + (err.message || err));
    }
  });
}

// ---------- Inicialização ----------
viewHooks.home = updateHome;
viewHooks.favs = renderFavs;
viewHooks.search = () => setTimeout(() => searchInput.focus(), 50);
viewHooks.bible = () => { if (BIBLE && !readerEl.querySelector(".verse")) renderReader(); };
viewHooks.harpa = () => {
  if (!HARPA) loadHarpa();
  else if (!$("#harpaList").querySelector(".harpa-card") && $("#harpaReaderView").hidden) renderHarpaList(false);
};
viewHooks.oferta = () => {
  loadOferta(true);
};

initHomeEvents();
initHarpaEvents();
initOfertaEvents();
updateHome();
loadOferta(false);

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
loadHarpa();
