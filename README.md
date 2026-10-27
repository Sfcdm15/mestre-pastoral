# 📖 Mestre Pastoral

App web de estudo bíblico e preparação de pregações, com IA (Google Gemini).

## Como rodar

1. Pegue uma chave gratuita em <https://aistudio.google.com/apikey>.
2. Copie `.env.example` para `.env` e cole sua chave em `GEMINI_API_KEY`.
3. No terminal, dentro desta pasta:
   ```
   node server.js
   ```
4. Abra <http://localhost:3000> no navegador.

Não precisa de `npm install` — o projeto não tem dependências (requer Node 18+).

## Estrutura

| Arquivo | Função |
|---|---|
| `prompt.md` | O "cérebro" — persona e regras do Mestre Pastoral. Edite aqui para ajustar o comportamento. |
| `server.js` | Servidor Node: serve o site e repassa as mensagens ao Gemini (a chave fica protegida no servidor). |
| `public/` | Interface (HTML, CSS, JS). |

## Recursos
- **📖 Bíblia completa (AT e NT)** — 66 livros, 1.189 capítulos, navegação por livro/capítulo, funciona sem a IA
  - Toque em versículos para **💬 Me explica** (Fluxo 2), **⭐ Favoritar** ou **📋 Copiar**
  - Botão **☕ Estudar** gera estudo + esboço do capítulo (Fluxo 1)
  - O texto do capítulo/versículo é enviado à IA como base, reduzindo "alucinações"
- **🔍 Busca** por palavra ou frase (ignora acentos), filtro AT/NT, e atalho por referência (`jo 3:16`, `1co 13`)
- **⭐ Favoritos** salvos no navegador
- **☕ Mestre** — chat com dois modos: Módulo de Estudo e Tirar Dúvida; referências nas respostas viram links para o leitor
- Respostas em tempo real (streaming), histórico salvo, copiar/compartilhar (WhatsApp), layout para celular

## Texto bíblico

Todas as Escrituras em português são da **Bíblia Livre (BLIVRE)**, Copyright © Diego Santos, Mario Sérgio e Marco Teles,
fevereiro de 2018. Licença [Creative Commons Atribuição 4.0 Brasil](https://creativecommons.org/licenses/by/4.0/deed.pt_BR).
Fonte: <https://ebible.org/find/details.php?id=porbr2018>. O crédito aparece no fim de cada capítulo — mantenha-o (é exigência da licença).

Para regenerar `public/bible/blivre.json` a partir do arquivo original (`data-src/porbr2018_vpl.txt`):
```
node scripts/build-bible.js
```
A pasta `data-src/` só é necessária para esse passo.

> A NVT e a NVI têm direitos autorais e não podem ser embutidas no app sem licença da editora.

## Testes
```
node scripts/test-bible.js   # referências, links e busca
```
