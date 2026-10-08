// plugins/jogo-da-velha/index.js
//
// Jogo da velha (tic-tac-toe) para dois jogadores, jogado por coordenadas.
// Horizontal: A B C   |   Vertical: 1 2 3   →  ex: "B2"
//
// Como iniciar:
//   Responda ("reply") a mensagem do seu oponente com "!velha".
//   Só quem responde (desafiante = ❌) e quem foi respondido (desafiado = ⭕)
//   participam da partida. Qualquer outra mensagem de terceiros — inclusive
//   coordenadas válidas — é ignorada em silêncio, pra não atrapalhar o jogo.
//
// Persistência: o estado da partida é salvo em ctx.storage (sobrevive a
// reinício do bot) — um arquivo por chat, pra partidas de chats diferentes
// nunca disputarem leitura/escrita do mesmo arquivo (evita race condition
// entre chats concorrentes).

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";

const COLS = ["A", "B", "C"];
const ROWS = ["1", "2", "3"];

const WIN_LINES = [
  ["A1", "B1", "C1"],
  ["A2", "B2", "C2"],
  ["A3", "B3", "C3"],
  ["A1", "A2", "A3"],
  ["B1", "B2", "B3"],
  ["C1", "C2", "C3"],
  ["A1", "B2", "C3"],
  ["A3", "B2", "C1"],
];

const GAME_TTL_MS = 30 * 60 * 1000;

function userId(jid) {
  return String(jid ?? "").split("@")[0].split(":")[0];
}

function isSameUser(a, b) {
  return userId(a) === userId(b);
}

function isPlayer(game, sender) {
  return isSameUser(game.players.X, sender) || isSameUser(game.players.O, sender);
}

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
    unlinkSync(path);
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

function emptyBoard() {
  const board = {};
  for (const c of COLS) for (const r of ROWS) board[c + r] = null;
  return board;
}

function renderBoard(board) {
  const symbol = (v) => (v === "X" ? "❌" : v === "O" ? "⭕" : "➖");
  let out = `   ${COLS.join("  ")}\n`;
  for (const r of ROWS) {
    out += ` ${r} ${COLS.map((c) => symbol(board[c + r])).join(" ")}\n`;
  }
  return "```\n" + out + "```";
}

function checkResult(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) return board[a];
  }
  if (Object.values(board).every((v) => v !== null)) return "empate";
  return null;
}

// Aceita "C2" ou "2C" (com ou sem espaço, maiúscula/minúscula) e normaliza
// sempre pra coluna+linha ("C2"), que é o formato usado como chave do board.
function parseCoordinate(input) {
  const raw = input.trim().toUpperCase().replace(/\s+/g, "");
  const letraNumero = /^([A-C])([1-3])$/.exec(raw);
  if (letraNumero) return letraNumero[1] + letraNumero[2];
  const numeroLetra = /^([1-3])([A-C])$/.exec(raw);
  if (numeroLetra) return numeroLetra[2] + numeroLetra[1];
  return null;
}

// pushname é o nome real de exibição do WhatsApp; contact pode vir `null`
// (contato ainda não "confirmado" — comum no primeiro contato com @lid) —
// nesse caso cai pro nome que já temos da própria mensagem.
function resolveName(contact, fallback) {
  return contact?.pushname ?? fallback;
}

/**
 * @param {import('@manybot/types/pt').PluginContext} ctx
 */
export default async function (ctx) {
  const { t } = ctx.i18n.createT(import.meta.url);

  // ---------- iniciar partida ----------
  if (ctx.msg.is("velha")) {
    if (!ctx.chat.isGroup) {
      ctx.msg.reply.text("❌ O jogo da velha só funciona em grupos!\n_É necessário mais de uma pessoa para jogar_");
      return; 
    }

    if (loadGame(ctx)) return void (await ctx.msg.reply.text(t("jaTemPartida")));

    if (!ctx.msg.hasReply) return void (await ctx.msg.reply.text(t("precisaResponder")));

    const oponenteMsg = await ctx.msg.getReply();
    if (!oponenteMsg || isSameUser(oponenteMsg.sender, ctx.msg.sender)) {
      return void (await ctx.msg.reply.text(t("escolhaOutraPessoa")));
    }

    // ctx.msg.getContact() resolve @lid automaticamente (preferível dentro de
    // um handler); pro oponente (mensagem citada) usamos ctx.contacts.get()
    // com o sender dele. Ambos podem devolver null pra contato ainda não
    // "confirmado" — tratado como caso normal, não erro (ver best-practices).
    // Quando um dos lados é o próprio bot (fromMe), usamos um nome fixo em
    // vez de depender de pushname/senderName, que podem vir vazios/estranhos
    // pra mensagens enviadas pelo próprio número.
    const challengerContact = ctx.msg.fromMe ? null : await ctx.msg.getContact();
    const challengerName = ctx.msg.fromMe
      ? t("nomeBot")
      : resolveName(challengerContact, ctx.msg.senderName);

    const oponenteName = oponenteMsg.fromMe
      ? t("nomeBot")
      : resolveName(await ctx.contacts.get(oponenteMsg.sender), oponenteMsg.senderName);

    // revalida bem antes de gravar: os awaits acima (getReply, getContact,
    // contacts.get) cedem o loop de eventos, então checa de novo que
    // ninguém criou uma partida nesse chat nesse meio-tempo
    if (loadGame(ctx)) return void (await ctx.msg.reply.text(t("jaTemPartida")));

    const game = {
      board: emptyBoard(),
      players: { X: ctx.msg.sender, O: oponenteMsg.sender },
      names: { X: challengerName, O: oponenteName },
      turn: "X",
    };
    saveGame(ctx, game);

    await ctx.send.text(
      t("iniciada", {
        jogadorX: challengerContact?.mention?.text ?? challengerName,
        jogadorO: oponenteName,
      }) +
        "\n\n" +
        renderBoard(emptyBoard()) +
        "\n" +
        t("vez", { simbolo: "❌", jogador: challengerName }),
      challengerContact?.mention
    );
    return;
  }

  // ---------- encerrar partida ----------
  if (ctx.msg.is("sairvelha")) {
    const game = loadGame(ctx);
    if (!game) return void (await ctx.msg.reply.text(t("semPartida")));
    if (!isPlayer(game, ctx.msg.sender)) return void (await ctx.msg.reply.text(t("somenteJogadores")));

    deleteGame(ctx);
    await ctx.send.text(t("encerrada"));
    return;
  }

  // ---------- jogada ----------
  const game = loadGame(ctx);
  if (!game) return; // sem partida ativa, ignora coordenadas soltas

  const jogadorDaVez = game.players[game.turn];
  if (!isSameUser(ctx.msg.sender, jogadorDaVez)) return; // não é a vez dele — ou nem é jogador: ignora em silêncio

  const jogada = parseCoordinate(ctx.msg.body);
  if (!jogada) return; // não é coordenada, ignora (deixa a mensagem seguir normal)

  if (game.board[jogada] !== null) {
    return void (await ctx.msg.reply.text(t("casaOcupada")));
  }

  game.board[jogada] = game.turn;
  const resultado = checkResult(game.board);

  if (resultado === "empate") {
    await ctx.send.text(renderBoard(game.board) + "\n" + t("empate"));
    deleteGame(ctx);
    return;
  }

  if (resultado) {
    const simbolo = resultado === "X" ? "❌" : "⭕";
    await ctx.send.text(renderBoard(game.board) + "\n" + t("vitoria", { simbolo, jogador: game.names[resultado] }));
    deleteGame(ctx);
    return;
  }

  game.turn = game.turn === "X" ? "O" : "X";
  saveGame(ctx, game);

  const simboloVez = game.turn === "X" ? "❌" : "⭕";
  await ctx.send.text(renderBoard(game.board) + "\n" + t("vez", { simbolo: simboloVez, jogador: game.names[game.turn] }));
}

