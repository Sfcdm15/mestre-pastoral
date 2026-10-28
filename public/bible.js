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

function renderHarpaList(submitTriggered = false) {
  const listEl = $("#harpaList");
  if (!HARPA) {
    listEl.innerHTML = `<div class="loading">Carregando os 524 hinos da Harpa Cristã…</div>`;
    return;
  }

  const rawQ = ($("#harpaSearchInput").value || "").trim();
  const numMatch = rawQ.match(/^(?:hino\s*|n[º°]?\s*|#)?(\d{1,3})$/i);
  const exactNum = numMatch ? Number(numMatch[1]) : null;

  // Se o usuário digitou um número exato e clicou em "Pesquisar" (Enter), abre o hino direto!
  if (submitTriggered && exactNum && exactNum >= 1 && exactNum <= HARPA.length) {
    openHymn(exactNum);
    return;
  }

  const nq = norm(rawQ);
  const favSet = new Set(harpaFavs);
  let filtered = HARPA;

  if (rawQ) {
    if (exactNum) {
      // Prioriza o hino de número exato, seguido pelos que contêm esses dígitos no número
      const exact = HARPA.filter((h) => h.n === exactNum);
      const partial = HARPA.filter((h) => h.n !== exactNum && String(h.n).includes(String(exactNum)));
      filtered = [...exact, ...partial];
    } else {
      // Pesquisa por nome do hino (prioridade) ou trecho da letra
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

  if (!filtered.length) {
    listEl.innerHTML =
      curHarpaRange === "FAV" && !rawQ
        ? `<p class="empty">Você ainda não favoritou nenhum hino.<br>Abra um hino e toque em ⭐ Favoritar.</p>`
        : `<p class="empty">Nenhum hino encontrado para “${escapeHtml(rawQ)}”.<br>Tente buscar pelo número (1 a 524) ou por palavras do título.</p>`;
    return;
  }

  let html = "";
  if (exactNum && exactNum >= 1 && exactNum <= HARPA.length) {
    const target = HARPA.find((h) => h.n === exactNum);
    if (target) {
      html += `<button type="button" class="goto" data-hymn="${target.n}">🎵 Abrir Hino ${target.n} — ${escapeHtml(target.title)}</button>`;
    }
  }

  html += `<p class="count">${filtered.length} hino(s) ${rawQ ? `encontrado(s) para “${escapeHtml(rawQ)}”` : "na lista"}</p><div class="harpa-grid">`;
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
  listEl.innerHTML = html;
  listEl.scrollTop = 0;
}

const CIFRA_STORAGE_PREFIX = "mestre-pastoral:cifra:";
let curHymnTab = "lyrics"; // 'lyrics' | 'cifra'
let curCifraSemitones = 0;
let curCifraFontSize = 15;
let cifraAutoScrollTimer = null;
let isCifraAutoScrolling = false;

const NOTES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTES_FLAT  = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

const BUILTIN_CIFRAS = {
  1: `[Tom: G]

[Intro: G  D  C  D  G]

      G
1. Deus prometeu com certeza
                  D
Chuvas de graça mandar;
       G
Ele nos dá fortaleza
  C          D         G
E ricas bênçãos sem par.

[Coro]
           D
Chuvas de graça,
  C        D      G
Chuvas pedimos, Senhor!
             C
Manda-nos já chuvas mansas,
 G         D       G
Chuvas do Consolador!

       G
2. Cristo nos dá a promessa
                   D
Do santo fogo do além;
         G
Que o coração nos aqueça,
     C         D       G
Com bênçãos puras também.

        G
3. Dá-nos, Senhor, amplamente,
                  D
Tua divina unção;
       G
Manda a chuva celeste,
  C          D        G
Que traz avivamento ao chão.`,

  6: `[Tom: G]

[Intro: G  D  Em  C  G  D  G]

      G                D
1. Tu na maldição da cruz,
      C         D    G
Elevaste o Teu amor,
                   D
Em rogar, Senhor Jesus:
        C       D       G
"Pai, perdoa ao transgressor!"

[Coro]
 G
Queres, queres, com vigor,
       C          D
Muitas almas despertar;
 G
Queres, queres, ó Senhor!
       C         D   G
Transformar, remir, curar;
     C          G
Oh! sim!   Oh! sim!
        D            G
Queres todos renovar!

      G            D
2. O Maligno tentador
      C       D      G
É o autor da perdição,
                    D
Do pecado, mal e a dor,
      C       D     G
Da doença e da aflição.

        G              D
3. Tu levaste, ó bom Jesus,
      C       D      G
O pecado, o mal e a dor,
                   D
E a doença sobre a cruz;
      C        D     G
És o grande Salvador!

       G               D
4. Deus é bom, quer sempre o bem
       C    D     G
Do oprimido pecador;
                   D
Mal nenhum em Si Deus tem:
       C         D      G
"Deus é luz, Deus é amor!"`,

  15: `[Tom: E]

[Intro: E  B7  A  B7  E]

       E
1. Oh! Quão cego andei e perdido vaguei,
                           B7
Longe, longe do meu Salvador!
        E               A
Mas da glória desceu e seu sangue verteu
         E         B7       E
Pra salvar um tão pobre pecador.

[Coro]
        E                      B7
Foi na cruz, foi na cruz onde um dia eu vi
       A        B7        E
Meu pecado castigado em Jesus;
        A                    E
Foi ali pela fé que meus olhos abri,
       E        B7          E
E agora me alegro em sua luz!

       E
2. Eu ouvia falar dessa graça sem fim,
                           B7
Que do céu trouxe nosso Jesus;
       E                 A
Mas eu era rebelde, e dizia pra mim:
       E       B7         E
"Não desejo a morte da cruz".`,

  187: `[Tom: G]

[Intro: G  D  C  G  D  G]

       G   C        G
1. Mais perto quero estar,
            D
Meu Deus, de Ti!
     G   C        G
Inda que seja a dor
    D      G
Que me una a Ti,
       C         G
Sempre hei de suplicar:
        G   C        G
Mais perto quero estar,
     D       G
Mais perto, ó Deus, de Ti!`,

  545: `[Tom: G]

[Intro: G  C  G  D  G]

      G           C
1. Deus enviou seu Filho amado
      G               D
Para morrer no meu lugar;
        G           C
Na cruz pagou por meus pecados,
        G     D          G
Mas vivo está e vida eterna dá.

[Coro]
           G           C
Porque Ele vive, posso crer no amanhã,
           G           D
Porque Ele vive, temor não há;
         G            C
Mas eu bem sei, eu sei, que a minha vida
         G      D            G
Está nas mãos do meu Jesus, que vivo está!`
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
      if (/^\[(Tom|Intro|Coro|Estrofe|\d+).*\]$/i.test(trimmed)) {
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

function toggleCifraAutoScroll() {
  const reader = $("#harpaReader");
  const btn = $("#btnAutoScroll");
  if (isCifraAutoScrolling) {
    clearInterval(cifraAutoScrollTimer);
    isCifraAutoScrolling = false;
    if (btn) {
      btn.classList.remove("active");
      btn.textContent = "▶ Rolar";
    }
  } else {
    isCifraAutoScrolling = true;
    if (btn) {
      btn.classList.add("active");
      btn.textContent = "⏸ Pausar";
    }
    cifraAutoScrollTimer = setInterval(() => {
      if (!isCifraAutoScrolling || !reader) return;
      reader.scrollTop += 1;
      if (reader.scrollTop + reader.clientHeight >= reader.scrollHeight) {
        toggleCifraAutoScroll();
      }
    }, 45);
  }
}

async function generateCifraWithAI(h) {
  const container = $("#cifraViewContainer");
  if (container) {
    container.innerHTML = `<div class="loading">🎼 O Mestre Pastoral está harmonizando o Hino ${h.n} para violão e teclado... Aguarde alguns instantes.</div>`;
  }

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "cifra",
        messages: [{
          role: "user",
          text: `Gere a cifra musical do Hino ${h.n} (${h.title}) da Harpa Cristã para violão e teclado em tom tradicional para a igreja (G, C ou D). Siga o FLUXO 3: [Tom: X], [Intro: ...] e as estrofes e coro com acordes alinhados.`
        }],
        context: { ref: `Harpa Cristã — Hino ${h.n}: ${h.title}`, text: h.lyrics }
      })
    });

    if (!res.ok) throw new Error("Erro na geração (" + res.status + ")");

    const decoder = new TextDecoder();
    let result = "";
    const readerStream = res.body.getReader();
    while (true) {
      const { done, value } = await readerStream.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
      if (container) container.textContent = result;
    }

    if (result.trim()) {
      localStorage.setItem(CIFRA_STORAGE_PREFIX + h.n, result.trim());
      toast("Cifra gerada e salva com sucesso! 🎸");
      curCifraSemitones = 0;
      renderCifraView(h);
    }
  } catch (err) {
    if (container) {
      container.innerHTML = `<div class="empty">Não foi possível gerar a cifra (${escapeHtml(err.message)}).<br><br><button type="button" class="btn-gold" id="btnRetryGenCifra">Tentar novamente</button></div>`;
      $("#btnRetryGenCifra")?.addEventListener("click", () => generateCifraWithAI(h));
    }
  }
}

function openCifraModal(h, text) {
  const modal = $("#cifraEditModal");
  if (!modal) return;
  $("#cifraEditTitle").textContent = `Cifra: Hino ${h.n} · ${h.title}`;
  $("#cifraEditText").value = text || `[Tom: G]\n\n[Intro: G  D  C  D  G]\n\n      G\n1. ...`;
  modal.hidden = false;
  $("#cifraEditText").focus();
}

function renderLyricsView(h) {
  const isFav = harpaFavs.includes(h.n);
  const stanzas = h.lyrics.split(/\n\n+/);
  const bodyHtml = stanzas
    .map((st) => {
      if (isChorusStanza(st)) {
        return `<div class="hymn-chorus"><span class="hymn-chorus-tag">🎶 Coro</span>${escapeHtml(st)}</div>`;
      }
      return `<p class="hymn-stanza">${escapeHtml(st)}</p>`;
    })
    .join("");

  const reader = $("#harpaReader");
  reader.innerHTML = `
    <h2>Hino ${h.n} · ${escapeHtml(h.title)}</h2>
    <div class="testament">Harpa Cristã · Louvor Congregacional</div>
    ${bodyHtml}
    <div class="hymn-actions">
      <button type="button" class="btn-outline" data-hact="meditate">☕ Meditar com o Mestre</button>
      <button type="button" class="btn-ghost-gold" data-hact="fav">${isFav ? "★ Favoritado" : "⭐ Favoritar"}</button>
      <button type="button" class="btn-ghost-gold" data-hact="copy">📋 Copiar letra</button>
      <button type="button" class="btn-ghost-gold" data-hact="share">📤 Compartilhar</button>
    </div>
    <div class="chapter-nav">
      <button type="button" data-hgo="-1" ${h.n <= 1 ? "hidden" : ""}>‹ Hino ${h.n - 1}</button>
      <button type="button" data-hgo="1" ${h.n >= HARPA.length ? "hidden" : ""}>Hino ${h.n + 1} ›</button>
    </div>
  `;
  reader.scrollTop = 0;
}

function renderCifraView(h) {
  const isFav = harpaFavs.includes(h.n);
  const rawCifra = localStorage.getItem(CIFRA_STORAGE_PREFIX + h.n) || BUILTIN_CIFRAS[h.n];
  const reader = $("#harpaReader");

  if (!rawCifra) {
    reader.innerHTML = `
      <h2>Hino ${h.n} · ${escapeHtml(h.title)}</h2>
      <div class="testament">Harpa Cristã · Louvor e Cifras</div>
      <div class="cifra-empty-card">
        <div class="cifra-empty-icon">🎸</div>
        <h3>Cifra para Violão e Teclado</h3>
        <p>Ainda não há cifra salva para este hino. Deseja que o Mestre Pastoral gere a harmonização completa agora?</p>
        <div class="cifra-btn-row">
          <button type="button" class="btn-gold" id="btnGenCifraWithAI">✨ Gerar Cifra com o Mestre</button>
          <button type="button" class="btn-ghost-gold" id="btnOpenCifraEditor">✏️ Colar Minha Própria Cifra</button>
        </div>
      </div>
      <div class="hymn-actions">
        <button type="button" class="btn-outline" data-hact="meditate">☕ Meditar com o Mestre</button>
        <button type="button" class="btn-ghost-gold" data-hact="fav">${isFav ? "★ Favoritado" : "⭐ Favoritar"}</button>
      </div>
      <div class="chapter-nav">
        <button type="button" data-hgo="-1" ${h.n <= 1 ? "hidden" : ""}>‹ Hino ${h.n - 1}</button>
        <button type="button" data-hgo="1" ${h.n >= HARPA.length ? "hidden" : ""}>Hino ${h.n + 1} ›</button>
      </div>
    `;
    reader.scrollTop = 0;
    $("#btnGenCifraWithAI")?.addEventListener("click", () => generateCifraWithAI(h));
    $("#btnOpenCifraEditor")?.addEventListener("click", () => openCifraModal(h, ""));
    return;
  }

  const currentKey = extractCifraKey(rawCifra, curCifraSemitones);
  const transposed = transposeCifraText(rawCifra, curCifraSemitones);
  const formattedHtml = formatCifraHTML(transposed);

  reader.innerHTML = `
    <h2>Hino ${h.n} · ${escapeHtml(h.title)}</h2>
    <div class="testament">Harpa Cristã · Cifra Musical</div>

    <div class="cifra-toolbar">
      <div class="cifra-tool-group">
        <button type="button" class="cifra-tool-btn" id="btnTransposeDown" title="Abaixar meio tom">◀ Tom</button>
        <span class="cifra-key-pill" id="cifraKeyBadge">Tom: ${escapeHtml(currentKey)}</span>
        <button type="button" class="cifra-tool-btn" id="btnTransposeUp" title="Aumentar meio tom">Tom ▶</button>
      </div>
      <div class="cifra-tool-group">
        <button type="button" class="cifra-tool-btn" id="btnFontDown" title="Diminuir fonte">A-</button>
        <button type="button" class="cifra-tool-btn" id="btnFontUp" title="Aumentar fonte">A+</button>
        <button type="button" class="cifra-tool-btn" id="btnAutoScroll" title="Rolagem automática da tela">▶ Rolar</button>
      </div>
      <div class="cifra-tool-group">
        <button type="button" class="cifra-tool-btn" id="btnEditCifra">✏️ Editar</button>
        <button type="button" class="cifra-tool-btn" id="btnRegenCifra" title="Gerar nova versão com IA">🔄 IA</button>
        <button type="button" class="cifra-tool-btn" id="btnCopyCifra">📋 Copiar</button>
      </div>
    </div>

    <div class="cifra-view-container" id="cifraViewContainer" style="font-size: ${curCifraFontSize}px">
      ${formattedHtml}
    </div>

    <div class="hymn-actions">
      <button type="button" class="btn-outline" data-hact="meditate">☕ Meditar com o Mestre</button>
      <button type="button" class="btn-ghost-gold" data-hact="fav">${isFav ? "★ Favoritado" : "⭐ Favoritar"}</button>
    </div>
    <div class="chapter-nav">
      <button type="button" data-hgo="-1" ${h.n <= 1 ? "hidden" : ""}>‹ Hino ${h.n - 1}</button>
      <button type="button" data-hgo="1" ${h.n >= HARPA.length ? "hidden" : ""}>Hino ${h.n + 1} ›</button>
    </div>
  `;
  reader.scrollTop = 0;

  $("#btnTransposeDown")?.addEventListener("click", () => {
    curCifraSemitones -= 1;
    renderCifraView(h);
  });
  $("#btnTransposeUp")?.addEventListener("click", () => {
    curCifraSemitones += 1;
    renderCifraView(h);
  });
  $("#btnFontDown")?.addEventListener("click", () => {
    if (curCifraFontSize > 11) curCifraFontSize -= 1;
    const box = $("#cifraViewContainer");
    if (box) box.style.fontSize = curCifraFontSize + "px";
  });
  $("#btnFontUp")?.addEventListener("click", () => {
    if (curCifraFontSize < 24) curCifraFontSize += 1;
    const box = $("#cifraViewContainer");
    if (box) box.style.fontSize = curCifraFontSize + "px";
  });
  $("#btnAutoScroll")?.addEventListener("click", toggleCifraAutoScroll);
  $("#btnEditCifra")?.addEventListener("click", () => openCifraModal(h, rawCifra));
  $("#btnRegenCifra")?.addEventListener("click", () => {
    if (confirm("Deseja que o Mestre Pastoral crie uma nova harmonização para este hino?")) {
      generateCifraWithAI(h);
    }
  });
  $("#btnCopyCifra")?.addEventListener("click", () => {
    copyText(`Hino ${h.n} — ${h.title} (Harpa Cristã)\n\n${transposed}`);
  });
}

function openHymn(n) {
  if (!HARPA) return;
  const h = HARPA.find((x) => x.n === n);
  if (!h) return;
  curHymnNum = h.n;
  curCifraSemitones = 0;
  if (isCifraAutoScrolling) toggleCifraAutoScroll();
  setView("harpa");
  $("#harpaIndexView").hidden = true;
  $("#harpaReaderView").hidden = false;

  $("#harpaPrevBtn").disabled = h.n <= 1;
  $("#harpaNextBtn").disabled = h.n >= HARPA.length;

  $("#btnHymnLyrics")?.classList.toggle("active", curHymnTab === "lyrics");
  $("#btnHymnCifra")?.classList.toggle("active", curHymnTab === "cifra");

  if (curHymnTab === "cifra") {
    renderCifraView(h);
  } else {
    renderLyricsView(h);
  }
}

function initHarpaEvents() {
  let timer;
  $("#harpaSearchForm").onsubmit = (e) => {
    e.preventDefault();
    clearTimeout(timer);
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
    const btn = e.target.closest("[data-hymn]");
    if (!btn) return;
    openHymn(Number(btn.dataset.hymn));
  });
  $("#harpaBackBtn").onclick = () => {
    if (isCifraAutoScrolling) toggleCifraAutoScroll();
    showHarpaIndex();
  };
  $("#harpaPrevBtn").onclick = () => openHymn(curHymnNum - 1);
  $("#harpaNextBtn").onclick = () => openHymn(curHymnNum + 1);

  $("#btnHymnLyrics")?.addEventListener("click", () => {
    curHymnTab = "lyrics";
    $("#btnHymnLyrics").classList.add("active");
    $("#btnHymnCifra").classList.remove("active");
    const h = HARPA?.find((x) => x.n === curHymnNum);
    if (h) renderLyricsView(h);
  });

  $("#btnHymnCifra")?.addEventListener("click", () => {
    curHymnTab = "cifra";
    $("#btnHymnCifra").classList.add("active");
    $("#btnHymnLyrics").classList.remove("active");
    const h = HARPA?.find((x) => x.n === curHymnNum);
    if (h) renderCifraView(h);
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
    localStorage.setItem(CIFRA_STORAGE_PREFIX + curHymnNum, val);
    $("#cifraEditModal").hidden = true;
    toast("Cifra salva com sucesso! 🎸");
    curCifraSemitones = 0;
    const h = HARPA?.find((x) => x.n === curHymnNum);
    if (h) renderCifraView(h);
  });

  $("#harpaStudyBtn").onclick = () => {
    const h = HARPA?.find((x) => x.n === curHymnNum);
    if (!h) return;
    askMaster(
      `Medite comigo no Hino ${h.n} da Harpa Cristã (${h.title}) e me mostre como usar sua mensagem em uma pregação.`,
      "estudo",
      { ref: `Harpa Cristã — Hino ${h.n}: ${h.title}`, text: h.lyrics }
    );
  };
  $("#harpaReader").addEventListener("click", (e) => {
    const go = e.target.closest("[data-hgo]");
    if (go) return openHymn(curHymnNum + Number(go.dataset.hgo));
    const act = e.target.closest("[data-hact]")?.dataset.hact;
    if (!act) return;
    const h = HARPA?.find((x) => x.n === curHymnNum);
    if (!h) return;
    const fullText = `Hino ${h.n} — ${h.title} (Harpa Cristã)\n\n${h.lyrics}`;
    if (act === "meditate") {
      $("#harpaStudyBtn").click();
    } else if (act === "copy") {
      copyText(fullText);
    } else if (act === "share") {
      if (navigator.share) navigator.share({ title: `Hino ${h.n} - ${h.title}`, text: fullText }).catch(() => {});
      else window.open("https://wa.me/?text=" + encodeURIComponent(fullText), "_blank");
    } else if (act === "fav") {
      if (harpaFavs.includes(h.n)) {
        harpaFavs = harpaFavs.filter((x) => x !== h.n);
        toast("Removido dos favoritos da Harpa");
      } else {
        harpaFavs = [h.n, ...harpaFavs];
        toast("Salvo nos favoritos da Harpa ⭐");
      }
      saveHarpaFavs();
      openHymn(h.n);
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
