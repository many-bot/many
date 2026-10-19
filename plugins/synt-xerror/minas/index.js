// plugins/campo-minado/index.js
//
// Campo minado cooperativo para WhatsApp.
// Qualquer membro do grupo pode jogar — a partida não é de ninguém exclusivo.
// Só quem iniciou pode encerrar com !sairminas.
//
// Comandos:
//   !minas             → inicia no modo padrão (médio em grupos, fácil em privado)
//   !minas facil       → grade 9×9, 10 minas
//   !minas medio       → grade 9×9, 20 minas
//   !minas dificil     → grade 13×10, 30 minas
//   A1 / b3 / C 2      → revela uma célula
//   !flag A1           → marca/desmarca bandeira
//   !sairminas         → encerra a partida (só quem iniciou)
//
// Persistência: um arquivo JSON por chat (igual ao jogo da velha), sobrevive
// a reinícios do bot e nunca conflita entre chats diferentes.

import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";

// ─── Configuração de modos ────────────────────────────────────────────────────

const MODES = {
  facil:   { cols: 5,  rows: 5,  mines: 5,  label: "Fácil"   },
  medio:   { cols: 9,  rows: 9,  mines: 20, label: "Médio"   },
  dificil: { cols: 10, rows: 13, mines: 30, label: "Difícil" },
};

const DEFAULT_MODE_GROUP   = "medio";
const DEFAULT_MODE_PRIVATE = "facil";

const GAME_TTL_MS = 30 * 60000;

// ─── Emojis ──────────────────────────────────────────────────────────────────

const EMOJI_HIDDEN   = "🟦";
const EMOJI_FLAG     = "🚩";
const EMOJI_MINE     = "💣";
const EMOJI_EXPLODED = "💥";
const EMOJI_EMPTY    = "◻️";

// Números com emoji de cor (1-8)
const NUM_EMOJI = ["", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣"];

// Letras de linha em fullwidth para o cabeçalho (máx 13 = A-M)
const COL_LABELS_FW = ["Ａ", "Ｂ", "Ｃ", "Ｄ", "Ｅ", "Ｆ", "Ｇ", "Ｈ", "Ｉ", "Ｊ", "Ｋ", "Ｌ", "Ｍ"];

// Números de linha em emoji (1-13)
const ROW_NUM_EMOJI = [
  "", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣",
  "🔟", "1️⃣1️⃣", "1️⃣2️⃣", "1️⃣3️⃣",
];

// ─── Persistência ─────────────────────────────────────────────────────────────

function gameFilePath(ctx) {
  const safeId = ctx.chat.id.replace(/[^a-zA-Z0-9]/g, "_");
  return ctx.storage.resolve(`partida-${safeId}.json`);
}

function loadGame(ctx) {
  const path = gameFilePath(ctx);
  if (!existsSync(path)) return null;
  try {
    const game = JSON.parse(readFileSync(path, "utf-8"));
    if (Date.now() - (game.updatedAt ?? 0) > GAME_TTL_MS) {
      unlinkSync(path);
      return null;
    }
    return game;
  } catch {
    try { unlinkSync(path); } catch {}
    return null;
  }
}

function saveGame(ctx, game) {
  game.updatedAt = Date.now();
  writeFileSync(gameFilePath(ctx), JSON.stringify(game, null, 2));
}

function deleteGame(ctx) {
  const path = gameFilePath(ctx);
  if (existsSync(path)) unlinkSync(path);
}

// ─── Coordenadas ──────────────────────────────────────────────────────────────
// Formato aceito: letra (col A-J) + número (linha 1-13), em qualquer ordem.
// Ex: "A1", "1A", "b 3", "13J" → normalizado para { col, row } (0-indexed).

// Letras = linhas (eixo Y / row), números = colunas (eixo X / col).
// Exemplos: "A1" → row 0, col 0 | "C1" → row 2, col 0 | "B3" → row 1, col 2
function parseCoord(input, cols, rows) {
  const raw = input.trim().toUpperCase().replace(/\s+/g, "");
  const letterFirst = /^([A-M])(\d{1,2})$/.exec(raw);
  const numberFirst = /^(\d{1,2})([A-M])$/.exec(raw);
  const m = letterFirst ?? numberFirst;
  if (!m) return null;
  const letter = letterFirst ? m[1] : m[2];
  const num    = parseInt(letterFirst ? m[2] : m[1], 10);
  const row = letter.charCodeAt(0) - 65; // A=row 0, B=row 1 …
  const col = num - 1;                   // 1→col 0, 2→col 1 …
  if (col < 0 || col >= cols) return null;
  if (row < 0 || row >= rows) return null;
  return { col, row };
}

// ─── Lógica do tabuleiro ──────────────────────────────────────────────────────

function cellKey(col, row) { return `${col},${row}`; }

function createGame(mode, starter, chatId) {
  const { cols, rows, mines } = MODES[mode];
  return {
    mode,
    cols,
    rows,
    mines,
    // cells[key] = { mine, adjacent, revealed, flagged }
    cells: null,     // gerado na primeira jogada (safe-first-click)
    revealed: 0,
    flags: 0,
    starter,         // jid de quem iniciou (único que pode !sairminas)
    chatId,          // jid do chat (para notificação de expiração)
    status: "playing", // "playing" | "won" | "lost"
  };
}

// Gera o tabuleiro garantindo que a primeira célula clicada não seja mina.
function placeMines(cols, rows, mines, safeCol, safeRow) {
  const cells = {};
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++)
      cells[cellKey(c, r)] = { mine: false, adjacent: 0, revealed: false, flagged: false };

  // Posições proibidas: a célula segura e seus vizinhos
  const safeSet = new Set();
  for (let dc = -1; dc <= 1; dc++)
    for (let dr = -1; dr <= 1; dr++) {
      const nc = safeCol + dc, nr = safeRow + dr;
      if (nc >= 0 && nc < cols && nr >= 0 && nr < rows)
        safeSet.add(cellKey(nc, nr));
    }

  const candidates = Object.keys(cells).filter((k) => !safeSet.has(k));
  // Fisher-Yates parcial
  for (let i = 0; i < mines && i < candidates.length; i++) {
    const j = i + Math.floor(Math.random() * (candidates.length - i));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    cells[candidates[i]].mine = true;
  }

  // Calcula adjacências
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      if (cells[cellKey(c, r)].mine) continue;
      let count = 0;
      for (let dc = -1; dc <= 1; dc++)
        for (let dr = -1; dr <= 1; dr++) {
          if (dc === 0 && dr === 0) continue;
          const nc = c + dc, nr = r + dr;
          if (nc >= 0 && nc < cols && nr >= 0 && nr < rows && cells[cellKey(nc, nr)].mine)
            count++;
        }
      cells[cellKey(c, r)].adjacent = count;
    }
  }

  return cells;
}

// Flood-fill: revela células vazias (adjacent=0) em cascata.
function floodReveal(cells, cols, rows, col, row) {
  const queue = [{ col, row }];
  let revealed = 0;
  while (queue.length) {
    const { col: c, row: r } = queue.shift();
    const key = cellKey(c, r);
    const cell = cells[key];
    if (!cell || cell.revealed || cell.flagged || cell.mine) continue;
    cell.revealed = true;
    revealed++;
    if (cell.adjacent === 0) {
      for (let dc = -1; dc <= 1; dc++)
        for (let dr = -1; dr <= 1; dr++) {
          if (dc === 0 && dr === 0) continue;
          const nc = c + dc, nr = r + dr;
          if (nc >= 0 && nc < cols && nr >= 0 && nr < rows)
            queue.push({ col: nc, row: nr });
        }
    }
  }
  return revealed;
}

function checkWin(game) {
  // Vence quando todas as não-minas estão reveladas
  const total = game.cols * game.rows;
  return game.revealed === total - game.mines;
}

// ─── Renderização ─────────────────────────────────────────────────────────────

function renderBoard(game, explodedKey = null) {
  const { cells, cols, rows } = game;

  // Cabeçalho: espaço + letras de coluna (A, B, C …)
  // Cada célula ocupa 2 chars de emoji — alinhamos com espaço fullwidth inicial.
  const header = "⠀ " + Array.from({ length: cols }, (_, c) => ROW_NUM_EMOJI[c + 1]).join("");
  const lines = [header];

  for (let r = 0; r < rows; r++) {
    const label = COL_LABELS_FW[r]; // A=linha 1, B=linha 2 …
    const cells_row = Array.from({ length: cols }, (_, c) => {
      const key = cellKey(c, r);
      const cell = cells[key];
      if (cell.flagged && !cell.revealed) return EMOJI_FLAG;
      if (!cell.revealed) return EMOJI_HIDDEN;
      if (cell.mine) return key === explodedKey ? EMOJI_EXPLODED : EMOJI_MINE;
      if (cell.adjacent === 0) return EMOJI_EMPTY;
      return NUM_EMOJI[cell.adjacent];
    });
    lines.push(`${label} ${cells_row.join("")}`);
  }

  return lines.join("\n");
}

// Renderização pós-derrota: revela tudo
function renderLost(game, explodedKey) {
  // Revela todas as minas e mantém flags erradas visíveis
  for (const [key, cell] of Object.entries(game.cells)) {
    if (cell.mine) cell.revealed = true;
    // bandeira em célula sem mina → deixa visível mas marcamos como "erro"
  }
  return renderBoard(game, explodedKey);
}

// ─── Helpers de identidade ────────────────────────────────────────────────────

function userId(jid) {
  return String(jid ?? "").split("@")[0].split(":")[0];
}

function isStarter(game, sender) {
  return userId(game.starter) === userId(sender);
}

// ─── Handler principal ────────────────────────────────────────────────────────

/**
 * @param {import('@manybot/types/pt').SetupContext} ctx
 */
export async function setup(ctx) {
  // Roda todo minuto: deleta partidas expiradas e notifica o chat
  ctx.scheduler.schedule("* * * * *", async () => {
    const { t } = ctx.i18n.createT(import.meta.url);
    const dir = ctx.storage.dir;
    let removed = 0;
    try {
      for (const file of readdirSync(dir)) {
        if (!file.startsWith("partida-") || !file.endsWith(".json")) continue;
        const path = `${dir}/${file}`;
        try {
          const game = JSON.parse(readFileSync(path, "utf-8"));
          if (Date.now() - (game.updatedAt ?? 0) > GAME_TTL_MS) {
            unlinkSync(path);
            removed++;
            if (game.chatId) {
              try {
                await ctx.send.to(game.chatId).text(t("expirada"));
              } catch {}
            }
          }
        } catch {
          unlinkSync(path);
          removed++;
        }
      }
    } catch {}
    if (removed > 0) ctx.log.info(`[campo-minado] limpeza: ${removed} partida(s) expirada(s) removida(s)`);
  });
}

/**
 * @param {import('@manybot/types/pt').PluginContext} ctx
 */
export default async function (ctx) {
  const { t } = ctx.i18n.createT(import.meta.url);
  // Rodapé com os comandos (!flag / !sairminas) repetido em toda mensagem
  // da partida, pra ninguém precisar rolar até a mensagem inicial.
  const footer = "\n\n" + t("instrucoes");

  // ── !minas [modo] ────────────────────────────────────────────────────────────
  if (ctx.msg.is("minas")) {
    if (loadGame(ctx)) {
      return void (await ctx.msg.reply.text(t("jaTemPartida")));
    }

    const arg = (ctx.msg.args[0] ?? "").toLowerCase();
    let modeName;
    if (arg === "facil" || arg === "fácil") modeName = "facil";
    else if (arg === "medio" || arg === "médio") modeName = "medio";
    else if (arg === "dificil" || arg === "difícil") modeName = "dificil";
    else modeName = ctx.chat.isGroup ? DEFAULT_MODE_GROUP : DEFAULT_MODE_PRIVATE;

    const mode = MODES[modeName];
    const game = createGame(modeName, ctx.msg.sender, ctx.chat.id);
    saveGame(ctx, game);

    await ctx.send.text(
      t("iniciada", { modo: mode.label, minas: mode.mines }) +
        "\n\n" +
        renderBoard({ ...game, cells: buildHiddenCells(mode.cols, mode.rows) }) +
        footer
    );
    return;
  }

  // ── !sairminas ───────────────────────────────────────────────────────────────
  if (ctx.msg.is("sairminas")) {
    const game = loadGame(ctx);
    if (!game) return void (await ctx.msg.reply.text(t("semPartida")));
    if (!isStarter(game, ctx.msg.sender)) {
      return void (await ctx.msg.reply.text(t("somenteIniciador")));
    }
    deleteGame(ctx);
    await ctx.send.text(t("encerrada"));
    return;
  }

  // ── !flag / !f <coord> ───────────────────────────────────────────────────────
  if (ctx.msg.is("flag")) {
    const game = loadGame(ctx);
    if (!game || game.status !== "playing") return;

    const coordStr = ctx.msg.args.join(" ");
    const coord = parseCoord(coordStr, game.cols, game.rows);
    if (!coord) return void (await ctx.msg.reply.text(t("coordInvalida") + footer));

    const key = cellKey(coord.col, coord.row);
    const cell = game.cells?.[key];
    if (!cell) return;
    if (cell.revealed) return void (await ctx.msg.reply.text(t("celulaRevelada") + footer));

    cell.flagged = !cell.flagged;
    game.flags += cell.flagged ? 1 : -1;
    saveGame(ctx, game);

    const boardTxt = renderBoard(game);
    const remaining = game.mines - game.flags;
    await ctx.send.text(boardTxt + "\n\n" + t("bandeiras", { restantes: remaining }) + footer);
    return;
  }

  // ── Coordenada solta (jogada) ─────────────────────────────────────────────────
  const game = loadGame(ctx);
  if (!game || game.status !== "playing") return;

  const coord = parseCoord(ctx.msg.body, game.cols, game.rows);
  if (!coord) return;

  const key = cellKey(coord.col, coord.row);

  // Primeira jogada: gera o tabuleiro agora (safe-first-click)
  if (!game.cells) {
    game.cells = placeMines(game.cols, game.rows, game.mines, coord.col, coord.row);
  }

  const cell = game.cells[key];
  if (cell.revealed) return void (await ctx.msg.reply.text(t("celulaRevelada") + footer));
  if (cell.flagged)  return void (await ctx.msg.reply.text(t("celulaFlagged", { coord: ctx.msg.body.trim().toUpperCase() }) + footer));

  if (cell.mine) {
    // Derrota
    cell.revealed = true;
    game.status = "lost";
    const board = renderLost(game, key);
    deleteGame(ctx);
    await ctx.send.text(board + "\n\n" + t("derrota"));
    return;
  }

  const newlyRevealed = floodReveal(game.cells, game.cols, game.rows, coord.col, coord.row);
  game.revealed += newlyRevealed;

  if (checkWin(game)) {
    game.status = "won";
    const board = renderBoard(game);
    deleteGame(ctx);
    await ctx.send.text(board + "\n\n" + t("vitoria", { minas: game.mines }));
    return;
  }

  saveGame(ctx, game);

  const remaining = game.mines - game.flags;
  await ctx.send.text(
    renderBoard(game) + "\n\n" + t("progresso", { reveladas: game.revealed, restantes: remaining }) + footer
  );
}

// Gera uma grade toda oculta (antes da primeira jogada, para exibir no início)
function buildHiddenCells(cols, rows) {
  const cells = {};
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++)
      cells[cellKey(c, r)] = { mine: false, adjacent: 0, revealed: false, flagged: false };
  return cells;
}

