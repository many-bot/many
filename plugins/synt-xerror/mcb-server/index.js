/**
 * plugins/mcb-server/index.js
 *
 * Monitors a Minecraft server log file (Bedrock Dedicated Server
 * and/or Java Edition - Paper/Spigot/Vanilla, including
 * Geyser/Floodgate bedrock players) and notifies a WhatsApp group
 * on player connect/disconnect/chat/advancement/death events.
 *
 * New config keys (all optional, booleans as string "true"/"false"):
 *   MC_JAVA_JOINLEAVE     - default "true"  -> join/leave (Java + Bedrock)
 *   MC_JAVA_ACHIEVEMENTS  - default "true"  -> advancements/achievements
 *   MC_JAVA_DEATHS        - default "true"  -> death messages
 *   MC_JAVA_CHAT          - default "true"  -> chat messages
 *
 * New i18n keys expected (see locale files):
 *   messages.playerAchievement          ({ name, advancement })
 *   messages.playerChat                 ({ name, text })
 *   messages.death.<pattern key>        ({ name } or { name, killer })
 *   messages.death.fallback             ({ message })  - unmatched death line
 */

import fs from "fs";

const PLAYERS_FILE = "mcplayers.json";

function loadPlayers() {
  try {
    if (!fs.existsSync(PLAYERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function savePlayers(players) {
  fs.writeFileSync(PLAYERS_FILE, JSON.stringify(players, null, 2));
}

let ctxRef  = null;
let tRef    = null;
let players = loadPlayers();

function addPlayer(name) {
  if (!players.includes(name)) players.push(name);
  savePlayers(players);
}

function removePlayer(name) {
  players = players.filter(p => p !== name);
  savePlayers(players);
}

function isEnabled(key, def = "true") {
  return ctxRef.config.get(key, def) !== "false";
}

function notify(text) {
  const groupId = ctxRef.config.get("MC_GROUP_ID");
  ctxRef.send.to(groupId).text(text);
}

// Strips the leading timestamp/thread prefix from a Java log line, e.g.
//   "[23:56:41 INFO]: SyntaxError joined the game"                -> "SyntaxError joined the game"
//   "[13:11:51] [Server thread/INFO]: SyntaxError joined the game" -> "SyntaxError joined the game"
// Returns null if the line doesn't look like a Java log line at all.
function stripJavaPrefix(line) {
  let m = line.match(/^\[\d{2}:\d{2}:\d{2}(?::\d{2})? (?:INFO|WARN|ERROR)\]:\s?(.*)$/);
  if (m) return m[1];

  m = line.match(/^\[\d{2}:\d{2}:\d{2}\] \[[^\]]+\]:\s?(.*)$/);
  if (m) return m[1];

  return null;
}

// -----------------------------------------------------------------
// Bedrock Dedicated Server (raw BDS log) handling — unchanged logic
// -----------------------------------------------------------------
function handleBedrockLine(line) {
  const joinMatch = line.match(/Player Spawned: (.+?) xuid:/);
  if (joinMatch) {
    if (!isEnabled("MC_JAVA_JOINLEAVE")) return true;
    notify(tRef("messages.playerConnected", { name: joinMatch[1] }));
    addPlayer(joinMatch[1]);
    return true;
  }

  const leaveMatch = line.match(/Player disconnected: (.+?), xuid:/);
  if (leaveMatch) {
    if (!isEnabled("MC_JAVA_JOINLEAVE")) return true;
    notify(tRef("messages.playerDisconnected", { name: leaveMatch[1] }));
    removePlayer(leaveMatch[1]);
    return true;
  }

  return false;
}

// -----------------------------------------------------------------
// Java Edition (Paper/Spigot/Vanilla) log handling.
// Also covers Geyser/Floodgate bedrock players proxied through a
// Java server, since they emit the same "joined/left the game" lines.
// -----------------------------------------------------------------

// Death message patterns, based on the official list:
// https://minecraft.wiki/w/Death_messages (Java Edition section).
// Order matters: more specific literal suffixes MUST come before
// broader ones that would otherwise swallow them (e.g. the
// "witherSkull" pattern must be checked before the generic "shot"
// pattern, since "was shot by a skull from X" also matches
// "was shot by (.+)"). Each entry's `key` maps to a
// `messages.death.<key>` i18n key. `killer: true` means the second
// capture group (the attacker) is passed as `{killer}`.
//
// This list covers the ~55 most common death messages seen in
// normal gameplay. Minecraft has 100+ total death message templates
// (see the wiki link above) and they can change between versions;
// anything not matched here falls back to `messages.death.fallback`
// with the raw log line, so nothing crashes, it just won't be
// translated.
const DEATH_PATTERNS = [
  { key: "cactusPlayer",        re: /^(.+) walked into a cactus while trying to escape (.+)$/, killer: true },
  { key: "cactus",              re: /^(.+) was pricked to death$/ },
  { key: "drownPlayer",         re: /^(.+) drowned while trying to escape (.+)$/, killer: true },
  { key: "drown",               re: /^(.+) drowned$/ },
  { key: "flyIntoWall",         re: /^(.+) experienced kinetic energy$/ },
  { key: "explosionPlayer",     re: /^(.+) was blown up by (.+)$/, killer: true },
  { key: "explosion",           re: /^(.+) blew up$/ },
  { key: "fallEscape",          re: /^(.+) hit the ground too hard while trying to escape (.+)$/, killer: true },
  { key: "fall",                re: /^(.+) hit the ground too hard$/ },
  { key: "fallHigh",            re: /^(.+) fell from a high place$/ },
  { key: "fallLadder",          re: /^(.+) fell off a ladder$/ },
  { key: "fallVines",           re: /^(.+) fell off some vines$/ },
  { key: "anvil",               re: /^(.+) was squashed by a falling anvil$/ },
  { key: "fallingBlock",        re: /^(.+) was squashed by a falling block$/ },
  { key: "stalactite",          re: /^(.+) was skewered by a falling stalactite$/ },
  { key: "stalagmite",          re: /^(.+) was impaled on a stalagmite$/ },
  { key: "inFireEscape",        re: /^(.+) walked into fire while fighting (.+)$/, killer: true },
  { key: "inFire",              re: /^(.+) went up in flames$/ },
  { key: "onFireEscape",        re: /^(.+) was burned to a crisp while fighting (.+)$/, killer: true },
  { key: "onFire",              re: /^(.+) burned to death$/ },
  { key: "fireworks",           re: /^(.+) went off with a bang$/ },
  { key: "lavaEscape",          re: /^(.+) tried to swim in lava to escape (.+)$/, killer: true },
  { key: "lava",                re: /^(.+) tried to swim in lava$/ },
  { key: "lightningEscape",     re: /^(.+) was struck by lightning while fighting (.+)$/, killer: true },
  { key: "lightning",           re: /^(.+) was struck by lightning$/ },
  { key: "hotFloorPlayer",      re: /^(.+) walked into the danger zone due to (.+)$/, killer: true },
  { key: "hotFloor",            re: /^(.+) discovered the floor was lava$/ },
  { key: "magicEscape",         re: /^(.+) was killed by magic while trying to escape (.+)$/, killer: true },
  { key: "indirectMagic",       re: /^(.+) was killed by (.+) using magic$/, killer: true },
  { key: "magic",               re: /^(.+) was killed by magic$/ },
  { key: "freezePlayer",        re: /^(.+) was frozen to death by (.+)$/, killer: true },
  { key: "freeze",              re: /^(.+) froze to death$/ },
  { key: "slain",               re: /^(.+) was slain by (.+)$/, killer: true },
  { key: "stingPlayer",         re: /^(.+) was stung to death by (.+)$/, killer: true },
  { key: "sting",               re: /^(.+) was stung to death$/ },
  { key: "sonicBoom",           re: /^(.+) was obliterated by a sonically-charged shriek$/ },
  { key: "maceSmash",           re: /^(.+) was smashed by (.+)$/, killer: true },
  { key: "spear",               re: /^(.+) was speared by (.+)$/, killer: true },
  { key: "witherSkull",         re: /^(.+) was shot by a skull from (.+)$/, killer: true },
  { key: "shot",                re: /^(.+) was shot by (.+)$/, killer: true },
  { key: "pummeled",            re: /^(.+) was pummeled by (.+)$/, killer: true },
  { key: "fireballed",          re: /^(.+) was fireballed by (.+)$/, killer: true },
  { key: "tridentPlayer",       re: /^(.+) was impaled by (.+)$/, killer: true },
  { key: "starvePlayer",        re: /^(.+) starved to death while fighting (.+)$/, killer: true },
  { key: "starve",              re: /^(.+) starved to death$/ },
  { key: "inWallPlayer",        re: /^(.+) suffocated in a wall while fighting (.+)$/, killer: true },
  { key: "inWall",              re: /^(.+) suffocated in a wall$/ },
  { key: "outsideBorderPlayer", re: /^(.+) left the confines of this world while fighting (.+)$/, killer: true },
  { key: "outsideBorder",       re: /^(.+) left the confines of this world$/ },
  { key: "sweetBerryEscape",    re: /^(.+) was poked to death by a sweet berry bush while trying to escape (.+)$/, killer: true },
  { key: "sweetBerry",          re: /^(.+) was poked to death by a sweet berry bush$/ },
  { key: "thornsPlayer",        re: /^(.+) was killed while trying to hurt (.+)$/, killer: true },
  { key: "outOfWorldPlayer",    re: /^(.+) didn't want to live in the same world as (.+)$/, killer: true },
  { key: "outOfWorld",          re: /^(.+) fell out of the world$/ },
  { key: "witherPlayer",        re: /^(.+) withered away while fighting (.+)$/, killer: true },
  { key: "wither",              re: /^(.+) withered away$/ },
  { key: "crammingPlayer",      re: /^(.+) was squashed by (.+)$/, killer: true },
  { key: "cramming",            re: /^(.+) was squished too much$/ },
  { key: "genericPlayer",       re: /^(.+) died because of (.+)$/, killer: true },
  { key: "generic",             re: /^(.+) died$/ },
  { key: "genericKillPlayer",   re: /^(.+) was killed while fighting (.+)$/, killer: true },
  { key: "genericKill",         re: /^(.+) was killed$/ },
];

// Mob name translation is data-driven: comes from messages.mobs in
// the active locale file. Only mobs naturally spoken in the local
// language (zumbi/zombi, esqueleto, araña/aranha...) are listed there
// — Creeper, Enderman, Blaze etc. are intentionally absent and stay
// in English. Locales without a mobs map (e.g. en) just fall through.
function translateKiller(name) {
  if (!ctxRef) return name;
  const mobs = tRef("messages.mobs", { returnObjects: true });
  return (mobs && mobs[name]) || name;
}

function tryMatchDeath(content) {
  for (const pattern of DEATH_PATTERNS) {
    const m = content.match(pattern.re);
    if (!m) continue;
    const params = { name: m[1] };
    if (pattern.killer) params.killer = translateKiller(m[2]);
    return { key: pattern.key, params };
  }
  return null;
}

function handleJavaLine(content) {
  // join/leave (native Java players AND Geyser/Floodgate bedrock players)
  let m = content.match(/^(.+) joined the game$/);
  if (m) {
    if (isEnabled("MC_JAVA_JOINLEAVE")) {
      notify(tRef("messages.playerConnected", { name: m[1] }));
    }
    addPlayer(m[1]);
    return;
  }

  m = content.match(/^(.+) left the game$/);
  if (m) {
    if (isEnabled("MC_JAVA_JOINLEAVE")) {
      notify(tRef("messages.playerDisconnected", { name: m[1] }));
    }
    removePlayer(m[1]);
    return;
  }

  // advancements (modern) / achievements (legacy, pre-1.12)
  m = content.match(/^(.+) has made the advancement \[(.+)\]$/)
    || content.match(/^(.+) has completed the challenge \[(.+)\]$/)
    || content.match(/^(.+) has just earned the achievement \[(.+)\]$/);
  if (m) {
    if (isEnabled("MC_JAVA_ACHIEVEMENTS")) {
      notify(tRef("messages.playerAchievement", { name: m[1], advancement: m[2] }));
    }
    return;
  }

  // chat: "[Not Secure] <Name> text" or "<Name> text"
  m = content.match(/^(?:\[Not Secure\] )?<(.+?)> (.*)$/);
  if (m) {
    if (isEnabled("MC_JAVA_CHAT")) {
      notify(tRef("messages.playerChat", { name: m[1], text: m[2] }));
    }
    return;
  }

  // deaths — matched against the known pattern list, translated
  // individually; unmatched death-like lines fall back to raw text.
  const death = tryMatchDeath(content);
  if (death) {
    if (isEnabled("MC_JAVA_DEATHS")) {
      notify(tRef(`messages.death.${death.key}`, death.params));
    }
    return;
  }
}

function handleLine(line) {
  if (!line || !ctxRef) return;

  // Try Bedrock (raw BDS) format first — it has no timestamp prefix.
  if (handleBedrockLine(line)) return;

  // Otherwise try to parse it as a Java Edition server log line.
  const javaContent = stripJavaPrefix(line);
  if (javaContent !== null) {
    handleJavaLine(javaContent);
  }
}

export async function setup(ctx) {
  ctxRef = ctx;
  const { t } = ctx.i18n.createT(import.meta.url);
  tRef = t;

  const logFile = ctx.config.get("MC_LOG_FILE");

  if (!fs.existsSync(logFile)) {
    ctx.log.error(t("messages.logFileNotFound", { file: logFile }));
    return;
  }

  fs.watchFile(logFile, { interval: 1000 }, (curr, prev) => {
    if (curr.size <= prev.size) return;
    const stream = fs.createReadStream(logFile, {
      start: prev.size, end: curr.size, encoding: "utf8",
    });
    stream.on("data", chunk => {
      chunk.split("\n").forEach(line => handleLine(line.trim()));
    });
    stream.on("error", err =>
      ctx.log.error(t("messages.streamError", { error: err.message }))
    );
  });
}

export default async function (ctx) {
  const { msg } = ctx;
  const prefix  = ctx.config.get("CMD_PREFIX");
  const { t }   = ctx.i18n.createT(import.meta.url);

  if (msg.is("players")) {
    const list = players.length
      ? players.join("\n")
      : t("messages.noPlayers");
    await msg.reply.text(`🎮 Players online (${players.length}):\n${list}`);
  }
}
