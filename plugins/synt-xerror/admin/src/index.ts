import { parse } from "tldts";

const DEFAULT_ALLOWED_DOMAINS = [
  "youtube.com", "youtu.be", "instagram.com", "twitter.com", "x.com",
  "tiktok.com", "wikipedia.org", "github.com", "google.com", "stxerr.dev", "manybot.org"
];

const CANDIDATE_REGEX = /(?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;

// TLDs aceitos para detecção sem protocolo/www explícito.
// Links com https:// ou www. sempre passam independentemente do TLD.
const ALLOWED_TLDS = new Set([
  "com", "net", "org", "io", "co", "app", "dev", "ai", "gg",
  "ly", "link", "xyz", "info", "biz", "online", "site", "web",
  "br", "com.br", "net.br", "org.br",
  "us", "uk", "ca", "au", "eu",
  "tv", "fm", "am", "media", "news",
  "shop", "store", "tech", "cloud",
]);

const SETTING_KEY = "linkBlockEnabled";
const LINK_ALLOWED_KEY = "linkAllowedDomains";
const CLEANMSG_MAX = 100;
const COMMUNITY_ACTION_DELAY_MS = 80;
const COMMUNITY_CONCURRENCY = 3;

const MUTE_MAX_MS = 30 * 86_400_000;
const ANTISPAM_KEY = "antispamEnabled";
const ANTISPAM_WINDOW_MS = 10_000;
const ANTISPAM_THRESHOLD = 10;
const DURATION_UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

const AUTOBAN_SETTINGS_KEY = "autobanConfigs";
const AUTOBAN_TYPES = ["numero", "ddd", "cc"] as const;
type AutobanType = (typeof AUTOBAN_TYPES)[number];

const OWN_COMMANDS = ["ban", "promote", "demote", "mute", "unmute", "close", "open", "todos", "admins", "antispam", "linkblock", "cleanmsg", "autoban"];
const MENTION_CHUNK = 50;

const COMMUNITY_MAP_KEY = "communityMap";

const CLOSE_SCHEDULE_KEY = "closeSchedules"; // settings.global: { [chatId]: CloseSchedule[] }
const CLOSE_SCHEDULE_MAX = 3;
const CLOSE_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_PROXIMITY_WARN_MINUTES = 15;
const WEEKDAY_NAMES = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"]; // índice = Date#getDay()
const MONTH_NAMES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
const WORDS_YES = ["sim", "s", "yes", "y"];
const WORDS_NO = ["nao", "não", "n", "no"];
const WORDS_CANCEL = ["cancelar", "cancel"];

interface AutobanConfig {
  enabled: boolean;
  numbers: string[];
  ddds: string[];
  ccs: string[];
}

function defaultAutobanConfig(): AutobanConfig {
  return { enabled: false, numbers: [], ddds: [], ccs: [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDuration(input: string): number | null {
  const match = /^(\d+)(s|m|h|d)?$/i.exec(input.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!value) return null;
  const unit = (match[2] ?? "m").toLowerCase();
  return value * DURATION_UNITS[unit];
}

function formatDuration(ms: number): string {
  const units: [number, string, string][] = [
    [86_400_000, "dia", "dias"],
    [3_600_000, "hora", "horas"],
    [60_000, "minuto", "minutos"],
    [1000, "segundo", "segundos"],
  ];
  for (const [unitMs, singular, plural] of units) {
    if (ms >= unitMs) {
      const value = Math.round(ms / unitMs);
      return `${value} ${value === 1 ? singular : plural}`;
    }
  }
  return "menos de 1 segundo";
}

// In-memory sliding window per chat+sender; not persisted, resets on restart.
const spamTimestamps = new Map<string, number[]>();

function registerMessageAndCheckSpam(key: string): boolean {
  const now = Date.now();
  const recent = (spamTimestamps.get(key) ?? []).filter((t) => now - t < ANTISPAM_WINDOW_MS);
  recent.push(now);
  spamTimestamps.set(key, recent);
  return recent.length > ANTISPAM_THRESHOLD;
}

async function loadAutobanConfigs(ctx: any): Promise<Record<string, AutobanConfig>> {
  return (await ctx.settings.global.get(AUTOBAN_SETTINGS_KEY)) ?? {};
}

async function saveAutobanConfigs(ctx: any, configs: Record<string, AutobanConfig>): Promise<void> {
  await ctx.settings.global.set(AUTOBAN_SETTINGS_KEY, configs);
}

function autobanListFor(config: AutobanConfig, type: AutobanType): string[] {
  return type === "numero" ? config.numbers : type === "ddd" ? config.ddds : config.ccs;
}

// Target ids (mentionedJid or replied.sender) are passed straight to
// admin.kick/promote/demote as-is. The kernel's findParticipantId()
// already matches @lid ids directly against group metadata; resolving
// @lid -> numberRaw here used to break that match, since participants
// in LID-only groups have no phone-number field to compare against.

function matchesAutobanBlacklist(contact: any, config: AutobanConfig): boolean {
  const numberRaw = contact?.numberRaw;
  if (!numberRaw) return false;
  if (config.numbers.includes(numberRaw)) return true;

  const cc = contact.countryCallingCode;
  if (cc && config.ccs.includes(cc)) return true;
  if (cc === "55" && config.ddds.length) {
    const ddd = numberRaw.slice(cc.length, cc.length + 2);
    if (config.ddds.includes(ddd)) return true;
  }
  return false;
}

function extractDomains(text: string): string[] {
  const domains = new Set<string>();
  const matches = text.match(CANDIDATE_REGEX) ?? [];

  for (const raw of matches) {
    const { domain, publicSuffix } = parse(raw, { allowPrivateDomains: true });
    if (!domain || !publicSuffix) continue;
    if (!/^[a-z]+$/i.test(publicSuffix.replace(/\./g, ""))) continue;

    const isExplicit = /^https?:\/\//i.test(raw) || /^www\./i.test(raw);
    if (!isExplicit && !ALLOWED_TLDS.has(publicSuffix.toLowerCase())) continue;

    domains.add(domain.toLowerCase());
  }

  return [...domains];
}

function isAllowed(domain: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

async function getAllowedDomains(settings: any): Promise<string[]> {
  const custom = await settings.get(LINK_ALLOWED_KEY);
  return custom ?? DEFAULT_ALLOWED_DOMAINS;
}

// Maps a group's chatId -> its community jid. Kept in settings.global because
// the group-participants.update listener runs in setup(), which has no
// "current chat" and therefore no native access to chat.community. The map is
// filled lazily from incoming group messages.
const knownCommunity = new Map<string, string>();

async function migrateAutobanConfig(ctx: any, fromKey: string, toKey: string): Promise<void> {
  const configs = await loadAutobanConfigs(ctx);
  if (!configs[fromKey] || configs[toKey]) return;
  configs[toKey] = configs[fromKey];
  delete configs[fromKey];
  await saveAutobanConfigs(ctx, configs);
}

async function syncCommunityMap(ctx: any): Promise<void> {
  const { chat } = ctx;
  const communityId: string | null = chat.community;
  if (!communityId || knownCommunity.get(chat.id) === communityId) return;

  const map = (await ctx.settings.global.get(COMMUNITY_MAP_KEY)) ?? {};
  const previousKey: string | undefined = map[chat.id];
  if (previousKey !== communityId) {
    if (previousKey) await migrateAutobanConfig(ctx, previousKey, communityId);
    map[chat.id] = communityId;
    await ctx.settings.global.set(COMMUNITY_MAP_KEY, map);
  }
  knownCommunity.set(chat.id, communityId);
}

function resolveAutobanKey(chat: any): string {
  return chat.community ?? chat.id;
}

async function resolveCommunityChatIds(ctx: any): Promise<string[]> {
  const { chat } = ctx;
  const communityId: string | null = chat.community;
  if (!communityId) return [chat.id];

  const parent = communityId === chat.id ? chat : await chat.getChat(communityId);
  if (!parent) return [chat.id];

  const groups: Array<{ id: string }> = await parent.getGroups();
  return [...new Set([chat.id, communityId, ...groups.map((g) => g.id)])];
}

// ctx.settings.get/set is per-chat, so sharing across a community is explicit:
// write the value to every chat in it.
async function communitySet(ctx: any, key: string, value: unknown): Promise<void> {
  for (const chatId of await resolveCommunityChatIds(ctx)) {
    await ctx.settings.forChat(chatId).set(key, value);
  }
}

// Falls back to the community's own value so groups that joined after the
// last !linkblock command are in sync without any manual step.
async function isLinkBlockEnabled(ctx: any): Promise<boolean> {
  const { settings, chat } = ctx;
  const own = await settings.get(SETTING_KEY);
  if (own !== undefined) return own;
  const communityId: string | null = chat.community;
  if (!communityId || communityId === chat.id) return false;
  return (await settings.forChat(communityId).get(SETTING_KEY)) ?? false;
}

// Each linked group is its own WhatsApp group, so an admin action on the
// community group does NOT propagate. We walk every chat one at a time,
// spaced out so we don't hammer the API. Groups where the target isn't a
// member are skipped silently instead of counted as failures.
type CommunityParticipant = {
  id: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  mention: { text: string; mentions: string[] };
};

type CommunityActionResult = {
  successCount: number;
  /** erro inesperado ou chat não encontrado (nomes de grupo, ou id se o nome não for conhecido) */
  failedChats: string[];
  /** grupos onde o bot não é admin */
  notAdminChats: string[];
  /** grupos onde o alvo não pode sofrer a ação (ex.: criador não pode ser rebaixado) */
  blockedChats: string[];
};

async function runOnCommunityChats(
  ctx: any,
  targetChatIds: string[],
  targetId: string,
  action: (chatId: string) => Promise<unknown>,
  rules?: {
    alreadyDone?: (participant: CommunityParticipant) => boolean;
    blocked?: (participant: CommunityParticipant) => boolean;
    requireBotAdmin?: boolean;
  }
): Promise<CommunityActionResult> {
  const { chat, log } = ctx;
  const failedChats: string[] = [];
  const notAdminChats: string[] = [];
  const blockedChats: string[] = [];
  let successCount = 0;

  log.info(`community action: target=${targetId} chats=${targetChatIds.length}`);

  const processChat = async (targetChatId: string): Promise<void> => {
    let label = targetChatId;

    try {
      const targetChat = targetChatId === chat.id ? chat : await chat.getChat(targetChatId);
      if (targetChat?.name) label = targetChat.name;
      if (!targetChat) {
        log.warn(`community action: chat ${targetChatId} not found`);
        failedChats.push(label);
        return;
      }
      if (rules?.requireBotAdmin !== false && !(await targetChat.isBotAdmin())) {
        log.warn(`community action: bot is not admin in ${targetChatId}`);
        notAdminChats.push(label);
        return;
      }

      const participants = await targetChat.getParticipants();
      const participant = participants.find((p: { id: string }) => p.id === targetId);
      if (!participant) {
        const sample = participants.slice(0, 3).map((p: { id: string }) => p.id).join(", ");
        log.warn(
          `community action: target ${targetId} not among ${participants.length} participants of ${targetChatId} (sample: ${sample})`
        );
        return;
      }
      if (rules?.blocked?.(participant)) {
        log.info(`community action: target is not allowed in ${targetChatId} (blocked)`);
        blockedChats.push(label);
        return;
      }
      if (rules?.alreadyDone?.(participant)) {
        log.info(`community action: already done in ${targetChatId}, skipping`);
      } else {
        await action(targetChatId);
        log.info(`community action: done in ${targetChatId}`);
      }
      successCount++;
    } catch (err) {
      log.error(`community action failed on ${targetChatId}`, err);
      failedChats.push(label);
    }
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < targetChatIds.length) {
      await processChat(targetChatIds[next++]);
      if (next < targetChatIds.length) await sleep(COMMUNITY_ACTION_DELAY_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(COMMUNITY_CONCURRENCY, targetChatIds.length) }, worker));

  return { successCount, failedChats, notAdminChats, blockedChats };
}

// admin.kick() já faz a cascata sozinho quando o alvo é a Community ou o grupo
// de anúncios (remove de todos os grupos). Em falha parcial ele lança um
// CommunityKickError com `removed` / `failed`; qualquer outro erro sobe normal.
type KickOutcome = { name: string; reason?: string };

async function banEverywhere(
  admin: any,
  targetId: string,
  scopeId: string
): Promise<{ removed: KickOutcome[]; failed: KickOutcome[] }> {
  try {
    const results: Array<KickOutcome & { status: string }> = await admin.kick([targetId]).to(scopeId);
    return { removed: results.filter((r) => r.status === "removed"), failed: [] };
  } catch (err: any) {
    if (!err?.failed) throw err;
    return { removed: err.removed, failed: err.failed };
  }
}

// ── Agendamento de close/open (!close agenda) ───────────────────────────────
//
// Cada grupo guarda até CLOSE_SCHEDULE_MAX agendamentos em settings.global
// (não settings.forChat — o tick do scheduler roda em setup(), sem "chat
// atual", então precisa iterar todos os chats de uma vez). Horários são
// interpretados no fuso do processo (America/Sao_Paulo em produção).
//
// `closedPending` é o estado runtime de cada agendamento: vira `true` quando
// o close dispara, e só o open (a qualquer dia/hora que seja) o zera de
// volta — isso resolve agendamentos que cruzam a meia-noite (ex. fecha às
// 23:00, abre às 06:00 do dia seguinte) sem precisar recalcular o dia da
// semana/mês pro open. O dia/semana/mês do agendamento só é checado pra
// decidir SE o close deve disparar; o open sempre segue o close pendente.

interface CloseSchedule {
  id: string;
  kind: "daily" | "weekly" | "monthly" | "specific" | "annual";
  weekdays?: number[];   // weekly — 0=dom..6=sab
  monthDays?: number[];  // monthly — 1..31
  day?: number;          // specific/annual
  month?: number;        // specific/annual — 1..12
  closeAt: string;       // "HH:mm"
  openAt: string;        // "HH:mm"
  community: boolean;    // também aplicado aos outros grupos da comunidade
  closedPending: boolean;
}

async function loadCloseSchedules(ctx: any): Promise<Record<string, CloseSchedule[]>> {
  return (await ctx.settings.global.get(CLOSE_SCHEDULE_KEY)) ?? {};
}

async function saveCloseSchedules(ctx: any, all: Record<string, CloseSchedule[]>): Promise<void> {
  await ctx.settings.global.set(CLOSE_SCHEDULE_KEY, all);
}

function normWord(s: string): string {
  return (s ?? "").trim().toLowerCase();
}

function answeredYes(body: string): boolean {
  return WORDS_YES.includes(normWord(body));
}

function answeredNo(body: string): boolean {
  return WORDS_NO.includes(normWord(body));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parseTime(input: string): string | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(input.trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// Quantos minutos de `fromTime` até o PRÓXIMO `toTime` (cruza meia-noite se preciso).
function windowMinutes(fromTime: string, toTime: string): number {
  const diff = timeToMinutes(toTime) - timeToMinutes(fromTime);
  return diff > 0 ? diff : diff + 24 * 60;
}

function parseWeekdays(input: string): number[] | null {
  const parts = input.split(",").map((p) => normWord(p)).filter(Boolean);
  if (!parts.length) return null;
  const days = new Set<number>();
  for (const p of parts) {
    const idx = WEEKDAY_NAMES.indexOf(p);
    if (idx === -1) return null;
    days.add(idx);
  }
  return [...days].sort((a, b) => a - b);
}

function parseMonthDays(input: string): number[] | null {
  const parts = input.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const days = new Set<number>();
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 31) return null;
    days.add(n);
  }
  return [...days].sort((a, b) => a - b);
}

// Meses que não têm o dia escolhido — fevereiro é sempre listado pra 29/30/31
// (tratado como "sem esse dia" independente do ano ser bissexto ou não, já
// que o agendamento mensal se repete todo ano).
function monthsMissingDay(day: number): string[] {
  if (day <= 28) return [];
  const missing = [MONTH_NAMES[1]];
  if (day === 31) missing.push(MONTH_NAMES[3], MONTH_NAMES[5], MONTH_NAMES[8], MONTH_NAMES[10]);
  return missing;
}

function validDate(day: number, month: number): { day: number; month: number } | null {
  if (!Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const probe = new Date(2024, month - 1, day); // 2024 é bissexto, cobre 29/fev
  if (probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
  return { day, month };
}

function parseDateInput(input: string): { day: number; month: number } | null {
  const trimmed = input.trim();

  const slash = /^(\d{1,2})\/(\d{1,2})$/.exec(trimmed);
  if (slash) return validDate(Number(slash[1]), Number(slash[2]));

  const byName = /^(\d{1,2})\s+de\s+([a-zà-ú]+)$/i.exec(normWord(trimmed));
  if (byName) {
    const month = MONTH_NAMES.indexOf(byName[2]) + 1;
    if (!month) return null;
    return validDate(Number(byName[1]), month);
  }

  return null;
}

function dayMatches(s: CloseSchedule, today: { weekday: number; day: number; month: number }): boolean {
  switch (s.kind) {
    case "daily": return true;
    case "weekly": return s.weekdays!.includes(today.weekday);
    case "monthly": return s.monthDays!.includes(today.day);
    case "specific":
    case "annual": return s.day === today.day && s.month === today.month;
  }
}

function describeScheduleKind(t: any, s: CloseSchedule): string {
  switch (s.kind) {
    case "daily": return t("closeAgendaKindDaily");
    case "weekly": return t("closeAgendaKindWeekly", { days: s.weekdays!.map((d) => WEEKDAY_NAMES[d]).join(", ") });
    case "monthly": return t("closeAgendaKindMonthly", { days: s.monthDays!.join(", ") });
    case "specific": return t("closeAgendaKindSpecific", { date: `${pad2(s.day!)}/${pad2(s.month!)}` });
    case "annual": return t("closeAgendaKindAnnual", { date: `${pad2(s.day!)}/${pad2(s.month!)}` });
  }
}

function formatScheduleLine(t: any, s: CloseSchedule, index: number): string {
  return t("closeAgendaStatusLine", {
    index: index + 1,
    kind: describeScheduleKind(t, s),
    closeAt: s.closeAt,
    openAt: s.openAt,
    community: s.community ? t("closeAgendaCommunitySuffix") : "",
  });
}

// ── Wizard (!close agenda) ───────────────────────────────────────────────────
// Uma sessão em memória por adminId, igual ao padrão do welcome.many — estado
// descartável de curta duração, some sozinho se o bot reiniciar no meio.

const closeSessions = new Map<string, any>(); // adminId -> session

function endCloseSession(adminId: string): void {
  const session = closeSessions.get(adminId);
  if (session?.timeoutHandle) clearTimeout(session.timeoutHandle);
  closeSessions.delete(adminId);
}

function armCloseTimeout(ctx: any, session: any): void {
  if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
  session.timeoutHandle = setTimeout(async () => {
    closeSessions.delete(session.adminId);
    const { t } = ctx.i18n.createT(import.meta.url);
    const prefix = await ctx.config.get("CMD_PREFIX");
    await ctx.send.to(session.anchorChatId).text(t("closeAgendaTimeout", { prefix }));
  }, CLOSE_SESSION_TIMEOUT_MS);
}

async function startCloseAgendaWizard(ctx: any): Promise<void> {
  const { chat, msg } = ctx;
  const { t } = ctx.i18n.createT(import.meta.url);

  if (closeSessions.has(msg.sender)) {
    await msg.reply.text(t("closeAgendaAlreadyInProgress"));
    return;
  }

  const all = await loadCloseSchedules(ctx);
  if ((all[chat.id] ?? []).length >= CLOSE_SCHEDULE_MAX) {
    const prefix = await ctx.config.get("CMD_PREFIX");
    await msg.reply.text(t("closeAgendaLimitReached", { max: CLOSE_SCHEDULE_MAX, prefix }));
    return;
  }

  const session = { adminId: msg.sender, anchorChatId: chat.id, mode: "chooseType", draft: {}, timeoutHandle: null };
  closeSessions.set(msg.sender, session);
  armCloseTimeout(ctx, session);
  await msg.reply.text(t("closeAgendaChooseType"));
}

async function startCloseAgendaReset(ctx: any): Promise<void> {
  const { chat, msg } = ctx;
  const { t } = ctx.i18n.createT(import.meta.url);

  if (closeSessions.has(msg.sender)) {
    await msg.reply.text(t("closeAgendaAlreadyInProgress"));
    return;
  }

  const all = await loadCloseSchedules(ctx);
  if (!(all[chat.id] ?? []).length) {
    await msg.reply.text(t("closeAgendaResetEmpty"));
    return;
  }

  const session = { adminId: msg.sender, anchorChatId: chat.id, mode: "resetConfirm", draft: {}, timeoutHandle: null };
  closeSessions.set(msg.sender, session);
  armCloseTimeout(ctx, session);
  await msg.reply.text(t("closeAgendaResetConfirm"));
}

async function sendCloseAgendaStatus(ctx: any): Promise<void> {
  const { chat, msg } = ctx;
  const { t } = ctx.i18n.createT(import.meta.url);
  const all = await loadCloseSchedules(ctx);
  const schedules = all[chat.id] ?? [];

  if (!schedules.length) {
    await msg.reply.text(t("closeAgendaStatusEmpty"));
    return;
  }

  const lines = schedules.map((s, i) => formatScheduleLine(t, s, i));
  await msg.reply.text(t("closeAgendaStatusHeader", { max: CLOSE_SCHEDULE_MAX }) + "\n" + lines.join("\n"));
}

/** Volta pro passo "chooseType" sem reaproveitar o draft — usado em resposta inválida. */
async function repeat(ctx: any, key: string, vars?: Record<string, unknown>): Promise<void> {
  const { t } = ctx.i18n.createT(import.meta.url);
  await ctx.send.to(ctx.chat.id).text(t(key, vars));
}

async function handleChooseType(ctx: any, session: any): Promise<void> {
  const choice = (ctx.msg.body ?? "").trim();
  const map: Record<string, CloseSchedule["kind"]> = { "1": "daily", "2": "weekly", "3": "monthly", "4": "specific", "5": "annual" };
  const kind = map[choice];
  if (!kind) { await repeat(ctx, "closeAgendaChooseType"); return; }

  session.draft.kind = kind;
  if (kind === "daily") {
    session.mode = "closeTime";
    await repeat(ctx, "closeAgendaCloseTime");
  } else if (kind === "weekly") {
    session.mode = "weeklyDays";
    await repeat(ctx, "closeAgendaWeeklyDays");
  } else if (kind === "monthly") {
    session.mode = "monthlyDays";
    await repeat(ctx, "closeAgendaMonthlyDays");
  } else {
    session.mode = "specificDate";
    await repeat(ctx, "closeAgendaSpecificDate");
  }
  armCloseTimeout(ctx, session);
}

async function handleWeeklyDays(ctx: any, session: any): Promise<void> {
  const days = parseWeekdays(ctx.msg.body ?? "");
  if (!days) { await repeat(ctx, "closeAgendaWeeklyDaysInvalid"); return; }
  session.draft.weekdays = days;
  session.mode = "closeTime";
  armCloseTimeout(ctx, session);
  await repeat(ctx, "closeAgendaCloseTime");
}

async function handleMonthlyDays(ctx: any, session: any): Promise<void> {
  const days = parseMonthDays(ctx.msg.body ?? "");
  if (!days) { await repeat(ctx, "closeAgendaMonthlyDaysInvalid"); return; }
  session.draft.monthDays = days;

  const missing = new Set<string>();
  for (const d of days) monthsMissingDay(d).forEach((m) => missing.add(m));
  if (missing.size) await repeat(ctx, "closeAgendaMonthlySkipped", { months: [...missing].join(", ") });

  session.mode = "closeTime";
  armCloseTimeout(ctx, session);
  await repeat(ctx, "closeAgendaCloseTime");
}

async function handleSpecificDate(ctx: any, session: any): Promise<void> {
  const date = parseDateInput(ctx.msg.body ?? "");
  if (!date) { await repeat(ctx, "closeAgendaSpecificDateInvalid"); return; }
  session.draft.day = date.day;
  session.draft.month = date.month;
  session.mode = "closeTime";
  armCloseTimeout(ctx, session);
  await repeat(ctx, "closeAgendaCloseTime");
}

async function handleCloseTime(ctx: any, session: any): Promise<void> {
  const time = parseTime(ctx.msg.body ?? "");
  if (!time) { await repeat(ctx, "closeAgendaCloseTimeInvalid"); return; }
  session.draft.closeAt = time;
  session.mode = "openTime";
  armCloseTimeout(ctx, session);
  await repeat(ctx, "closeAgendaOpenTime");
}

async function afterOpenTimeValid(ctx: any, session: any): Promise<void> {
  if (ctx.chat.community) {
    session.mode = "community";
    armCloseTimeout(ctx, session);
    await repeat(ctx, "closeAgendaCommunityAsk");
    return;
  }
  await finishCloseAgendaWizard(ctx, session, false);
}

async function handleOpenTime(ctx: any, session: any): Promise<void> {
  const time = parseTime(ctx.msg.body ?? "");
  if (!time) { await repeat(ctx, "closeAgendaOpenTimeInvalid"); return; }

  const openWindow = windowMinutes(time, session.draft.closeAt);
  const closedWindow = windowMinutes(session.draft.closeAt, time);
  const shortest = Math.min(openWindow, closedWindow);

  session.draft.openAt = time;

  if (shortest < CLOSE_PROXIMITY_WARN_MINUTES) {
    session.mode = "openTimeConfirm";
    armCloseTimeout(ctx, session);
    const state = openWindow <= closedWindow ? "closeAgendaProximityOpen" : "closeAgendaProximityClosed";
    await repeat(ctx, state, { minutes: shortest });
    return;
  }

  await afterOpenTimeValid(ctx, session);
}

async function handleOpenTimeConfirm(ctx: any, session: any): Promise<void> {
  const body = ctx.msg.body ?? "";
  if (answeredYes(body)) {
    await afterOpenTimeValid(ctx, session);
    return;
  }
  if (answeredNo(body)) {
    session.mode = "openTime";
    armCloseTimeout(ctx, session);
    await repeat(ctx, "closeAgendaOpenTime");
    return;
  }
  await repeat(ctx, "closeAgendaYesNoInvalid");
}

async function handleCommunityChoice(ctx: any, session: any): Promise<void> {
  const body = ctx.msg.body ?? "";
  if (answeredYes(body)) { await finishCloseAgendaWizard(ctx, session, true); return; }
  if (answeredNo(body)) { await finishCloseAgendaWizard(ctx, session, false); return; }
  await repeat(ctx, "closeAgendaYesNoInvalid");
}

async function finishCloseAgendaWizard(ctx: any, session: any, community: boolean): Promise<void> {
  const { t } = ctx.i18n.createT(import.meta.url);
  const schedule: CloseSchedule = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: session.draft.kind,
    weekdays: session.draft.weekdays,
    monthDays: session.draft.monthDays,
    day: session.draft.day,
    month: session.draft.month,
    closeAt: session.draft.closeAt,
    openAt: session.draft.openAt,
    community,
    closedPending: false,
  };

  const all = await loadCloseSchedules(ctx);
  const targetChatIds = community ? await resolveCommunityChatIds(ctx) : [session.anchorChatId];

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const chatId of targetChatIds) {
    const list = all[chatId] ?? [];
    if (list.length >= CLOSE_SCHEDULE_MAX) { skipped.push(chatId); continue; }
    all[chatId] = [...list, schedule];
    applied.push(chatId);
  }
  await saveCloseSchedules(ctx, all);

  endCloseSession(session.adminId);

  const summary = formatScheduleLine(t, schedule, (all[session.anchorChatId]?.length ?? 1) - 1);
  let text = t("closeAgendaSaved", { summary });
  if (community && skipped.length) text += "\n" + t("closeAgendaCommunitySkipped", { count: skipped.length });
  await ctx.send.to(session.anchorChatId).text(text);
}

async function handleResetConfirm(ctx: any, session: any): Promise<void> {
  const body = ctx.msg.body ?? "";
  if (answeredNo(body)) { endCloseSession(session.adminId); await repeat(ctx, "closeAgendaResetCancelled"); return; }
  if (!answeredYes(body)) { await repeat(ctx, "closeAgendaYesNoInvalid"); return; }

  const all = await loadCloseSchedules(ctx);
  const schedules = all[session.anchorChatId] ?? [];
  const hasCommunitySchedule = schedules.some((s) => s.community);

  if (hasCommunitySchedule && ctx.chat.community) {
    session.mode = "resetConfirmCommunity";
    armCloseTimeout(ctx, session);
    await repeat(ctx, "closeAgendaResetConfirmCommunity");
    return;
  }

  delete all[session.anchorChatId];
  await saveCloseSchedules(ctx, all);
  endCloseSession(session.adminId);
  await repeat(ctx, "closeAgendaResetDone");
}

async function handleResetConfirmCommunity(ctx: any, session: any): Promise<void> {
  const body = ctx.msg.body ?? "";
  if (!answeredYes(body) && !answeredNo(body)) { await repeat(ctx, "closeAgendaYesNoInvalid"); return; }

  const all = await loadCloseSchedules(ctx);
  const schedules = all[session.anchorChatId] ?? [];

  if (answeredYes(body)) {
    const ids = new Set(schedules.filter((s) => s.community).map((s) => s.id));
    for (const chatId of Object.keys(all)) {
      all[chatId] = all[chatId].filter((s) => !ids.has(s.id));
      if (!all[chatId].length) delete all[chatId];
    }
  } else {
    delete all[session.anchorChatId];
  }

  await saveCloseSchedules(ctx, all);
  endCloseSession(session.adminId);
  await repeat(ctx, "closeAgendaResetDone");
}

async function handleCloseWizardMessage(ctx: any, session: any): Promise<void> {
  if (ctx.chat.id !== session.anchorChatId) return;

  if (WORDS_CANCEL.includes(normWord(ctx.msg.body ?? ""))) {
    endCloseSession(session.adminId);
    await repeat(ctx, "closeAgendaCancelled");
    return;
  }

  switch (session.mode) {
    case "chooseType": return handleChooseType(ctx, session);
    case "weeklyDays": return handleWeeklyDays(ctx, session);
    case "monthlyDays": return handleMonthlyDays(ctx, session);
    case "specificDate": return handleSpecificDate(ctx, session);
    case "closeTime": return handleCloseTime(ctx, session);
    case "openTime": return handleOpenTime(ctx, session);
    case "openTimeConfirm": return handleOpenTimeConfirm(ctx, session);
    case "community": return handleCommunityChoice(ctx, session);
    case "resetConfirm": return handleResetConfirm(ctx, session);
    case "resetConfirmCommunity": return handleResetConfirmCommunity(ctx, session);
  }
}

// ── Scheduler tick (setup()) ─────────────────────────────────────────────────
// Roda a cada minuto, fora de qualquer mensagem — usa ctx.chats.getChat(jid)
// (adicionado no kernel) em vez de ctx.chat, que só existe em runtime.

async function fireCloseOpen(ctx: any, chatId: string, closing: boolean): Promise<boolean> {
  const chat = await ctx.chats.getChat(chatId);
  if (!chat) { ctx.log.warn(`closeSchedule: chat ${chatId} não encontrado`); return false; }
  if (!(await chat.isBotAdmin())) { ctx.log.warn(`closeSchedule: bot não é admin em ${chatId}`); return false; }

  const result = await (closing ? chat.close() : chat.open());
  if (result.status !== "ok") { ctx.log.warn(`closeSchedule: ${closing ? "close" : "open"} falhou em ${chatId}: ${result.status}`); return false; }

  const { t } = ctx.i18n.createT(import.meta.url);
  await ctx.send.to(chatId).text(t(closing ? "closeSuccess" : "openSuccess")).catch(() => {});
  return true;
}

async function closeScheduleTick(): Promise<void> {
  if (!adminCtx) return;
  const ctx = adminCtx;

  const now = new Date();
  const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const today = { weekday: now.getDay(), day: now.getDate(), month: now.getMonth() + 1 };

  const all = await loadCloseSchedules(ctx);
  let dirty = false;

  for (const chatId of Object.keys(all)) {
    const kept: CloseSchedule[] = [];
    for (const s of all[chatId]) {
      if (!s.closedPending && s.closeAt === hhmm && dayMatches(s, today)) {
        if (await fireCloseOpen(ctx, chatId, true)) { s.closedPending = true; dirty = true; }
      } else if (s.closedPending && s.openAt === hhmm) {
        if (await fireCloseOpen(ctx, chatId, false)) {
          dirty = true;
          if (s.kind === "specific") continue; // já cumpriu o único disparo — descarta
          s.closedPending = false;
        }
      }
      kept.push(s);
    }
    if (kept.length) all[chatId] = kept; else delete all[chatId];
  }

  if (dirty) await saveCloseSchedules(ctx, all);
}

// ctx próprio do plugin, capturado em setup(). `ctx.settings.global` é
// namespaced por plugin — usar o ctx de quem chama ctx.plugins.require()
// leria o storage do CHAMADOR, não o do admin. Ver isAutobanTarget abaixo.
let adminCtx: any = null;

export const api = {
  async isAutobanTarget(groupId: string, contact: any): Promise<boolean> {
    if (!adminCtx) return false;
    const communityMap = (await adminCtx.settings.global.get(COMMUNITY_MAP_KEY)) ?? {};
    const effectiveId = communityMap[groupId] ?? groupId;
    const configs = await loadAutobanConfigs(adminCtx);
    const config = configs[effectiveId];
    if (!config?.enabled) return false;
    return matchesAutobanBlacklist(contact, config);
  },
};

export default async function (ctx: any) {
  const { msg, chat, admin, send, settings, log } = ctx;
  const { t } = ctx.i18n.createT(import.meta.url);
  const prefix = await ctx.config.get("CMD_PREFIX");

  if (msg.fromMe) return;

  if (!chat.isGroup) {
    if (OWN_COMMANDS.some((cmd) => msg.is(cmd))) await msg.reply.text(t("groupOnly"));
    return;
  }

  await syncCommunityMap(ctx);

  if (!msg.command) {
    const closeSession = closeSessions.get(msg.sender);
    if (closeSession) {
      await handleCloseWizardMessage(ctx, closeSession);
      return;
    }
  }

  const antispamEnabled = (await settings.get(ANTISPAM_KEY)) ?? false;
  if (antispamEnabled && !(await chat.isSenderAdmin())) {
    const isSpam = registerMessageAndCheckSpam(`${chat.id}:${msg.sender}`);
    if (isSpam) {
      spamTimestamps.delete(`${chat.id}:${msg.sender}`);
      await banEverywhere(admin, msg.sender, chat.community ?? chat.id).catch((err) =>
        log.error("antispam: falha ao remover", err)
      );
      await send.text(t("antispamTriggered"), { mentions: [msg.sender] });
      return;
    }
  }

  if (msg.command) {
    if (msg.is("ban")) {
      if (!(await chat.isSenderAdmin())) {
        await msg.reply.text(t("adminOnly"));
        return;
      }

      log.info(`ban: mentionedJid=${JSON.stringify(msg.mentionedJid)}`);
      let targetId = msg.mentionedJid?.[0];
      const replied = await msg.getReply();
      if (!targetId) targetId = replied?.sender;
      log.info(`ban: targetId=${targetId}`);
      if (!targetId) {
        await msg.reply.text(t("banMissingTarget"));
        return;
      }
      if (targetId === msg.sender) {
        await msg.reply.text(t("cantActOnSelf"));
        return;
      }

      const deletion = replied ? replied.delete().catch(() => {}) : undefined;

      const dbgParticipants = await chat.getParticipants();
      log.info(`ban: participants=${JSON.stringify(dbgParticipants.map((p: any) => p.id))}`);
      log.info(`ban: calling banEverywhere targetId=${targetId} scope=${chat.community ?? chat.id}`);
      const { removed, failed } = await banEverywhere(admin, targetId, chat.community ?? chat.id);
      await deletion;

      const names = (list: KickOutcome[]) => list.map((r) => r.name).join(", ");
      const notAdmin = failed.filter((r) => r.reason === "not_admin");
      const superAdmin = failed.filter((r) => r.reason === "target_superadmin");
      const other = failed.filter((r) => r.reason !== "not_admin" && r.reason !== "target_superadmin");

      const lines: string[] = [];
      if (removed.length > 0 && other.length === 0) {
        lines.push(t("banSuccess"));
      } else if (removed.length > 0) {
        lines.push(t("banPartialSuccess", { count: removed.length, failed: names(other) }));
      } else if (other.length > 0 || (notAdmin.length === 0 && superAdmin.length === 0)) {
        lines.push(t("banFailed"));
      }
      if (notAdmin.length > 0) lines.push(t("commonBotNotAdminIn", { groups: names(notAdmin) }));
      if (superAdmin.length > 0) lines.push(t("banSuperAdmin", { groups: names(superAdmin) }));

      await msg.reply.text(lines.join("\n\n"));
      return;
    }

    if (msg.is("promote") || msg.is("demote")) {
      if (!(await chat.isSenderAdmin())) {
        await msg.reply.text(t("adminOnly"));
        return;
      }
      if (!(await chat.isBotAdmin())) {
        await msg.reply.text(t("commonBotNotAdmin"));
        return;
      }

      log.info(`promote/demote: mentionedJid=${JSON.stringify(msg.mentionedJid)}`);
      let targetId = msg.mentionedJid?.[0];
      if (!targetId) {
        const replied = await msg.getReply();
        targetId = replied?.sender;
      }
      if (!targetId) {
        await msg.reply.text(t("commonMissingTarget"));
        return;
      }

      const isPromote = msg.is("promote");
      const targetChatIds = await resolveCommunityChatIds(ctx);
      const { successCount, failedChats, notAdminChats, blockedChats } = await runOnCommunityChats(
        ctx,
        targetChatIds,
        targetId,
        (chatId) => (isPromote ? admin.promote([targetId]).to(chatId) : admin.demote([targetId]).to(chatId)),
        {
          alreadyDone: (p) => (isPromote ? p.isAdmin || p.isSuperAdmin : !p.isAdmin && !p.isSuperAdmin),
          blocked: (p) => !isPromote && p.isSuperAdmin,
        }
      );

      const lines: string[] = [];
      if (successCount > 0 && failedChats.length === 0) {
        lines.push(isPromote ? t("promoteSuccessPromote") : t("promoteSuccessDemote"));
      } else if (successCount > 0) {
        lines.push(
          t(isPromote ? "promotePartialPromote" : "promotePartialDemote", {
            count: successCount,
            failed: failedChats.join(", "),
          })
        );
      } else if (failedChats.length > 0 || (notAdminChats.length === 0 && blockedChats.length === 0)) {
        lines.push(isPromote ? t("promoteFailedPromote") : t("promoteFailedDemote"));
      }
      if (notAdminChats.length > 0) lines.push(t("commonBotNotAdminIn", { groups: notAdminChats.join(", ") }));
      if (blockedChats.length > 0) lines.push(t("demoteSuperAdmin", { groups: blockedChats.join(", ") }));

      await msg.reply.text(lines.join("\n\n"));
      return;
    }

    if (msg.is("mute")) {
      if (!(await chat.isSenderAdmin())) {
        await msg.reply.text(t("adminOnly"));
        return;
      }

      const durationMs = parseDuration((msg.args[0] ?? "").toLowerCase());
      if (durationMs === null || durationMs > MUTE_MAX_MS) {
        await msg.reply.text(t("muteUsage", { prefix }));
        return;
      }

      let targetId = msg.mentionedJid?.[0];
      if (!targetId) {
        const replied = await msg.getReply();
        targetId = replied?.sender;
      }
      if (!targetId) {
        await msg.reply.text(t("commonMissingTarget"));
        return;
      }
      if (targetId === ctx.botId) {
        const n = Math.floor(Math.random() * 3) + 1;
        if (n === 3) {
          await msg.reply.text(t("cantMuteBot2"));
        } else {
          await msg.reply.text(t("cantMuteBot"));
        }
        return;
      }
      if (targetId === msg.sender) {
        await msg.reply.text(t("cantActOnSelf"));
        return;
      }

      const participants: CommunityParticipant[] = await chat.getParticipants();
      if (participants.find((p) => p.id === targetId)?.isSuperAdmin) {
        await msg.reply.text(t("muteSuperAdmin"));
        return;
      }

      const everywhere = msg.args.slice(1).some((a: string) => a.toLowerCase() === "all");
      const successText = t("muteSuccess", { duration: formatDuration(durationMs) });

      if (!everywhere) {
        chat.mute(targetId, { duration: durationMs });
        await msg.reply.text(successText, { mentions: [targetId] });
        return;
      }

      const { successCount, failedChats, blockedChats } = await runOnCommunityChats(
        ctx,
        await resolveCommunityChatIds(ctx),
        targetId,
        async (chatId) => {
          const target = chatId === chat.id ? chat : await chat.getChat(chatId);
          target.mute(targetId, { duration: durationMs });
        },
        { blocked: (p) => p.isSuperAdmin, requireBotAdmin: false }
      );

      const lines: string[] = [];
      if (successCount > 0 && failedChats.length === 0) {
        lines.push(successText);
      } else if (successCount > 0) {
        lines.push(t("mutePartial", { count: successCount, failed: failedChats.join(", ") }));
      } else {
        lines.push(t("muteFailed"));
      }
      if (blockedChats.length > 0) lines.push(t("muteSuperAdminIn", { groups: blockedChats.join(", ") }));

      await msg.reply.text(lines.join("\n\n"), { mentions: [targetId] });
      return;
    }

    if (msg.is("unmute")) {
      if (!(await chat.isSenderAdmin())) {
        await msg.reply.text(t("adminOnly"));
        return;
      }

      let targetId = msg.mentionedJid?.[0];
      if (!targetId) {
        const replied = await msg.getReply();
        targetId = replied?.sender;
      }
      if (!targetId) {
        await msg.reply.text(t("commonMissingTarget"));
        return;
      }

      const everywhere = msg.args.some((a: string) => a.toLowerCase() === "all");

      if (!everywhere) {
        chat.unmute(targetId);
        spamTimestamps.delete(`${chat.id}:${targetId}`);
        await msg.reply.text(t("unmuteSuccess"), { mentions: [targetId] });
        return;
      }

      const { successCount, failedChats } = await runOnCommunityChats(
        ctx,
        await resolveCommunityChatIds(ctx),
        targetId,
        async (chatId) => {
          const target = chatId === chat.id ? chat : await chat.getChat(chatId);
          target.unmute(targetId);
          spamTimestamps.delete(`${chatId}:${targetId}`);
        },
        { requireBotAdmin: false }
      );

      const text =
        successCount > 0 && failedChats.length === 0
          ? t("unmuteSuccess")
          : successCount > 0
            ? t("unmutePartial", { count: successCount, failed: failedChats.join(", ") })
            : t("unmuteFailed");
      await msg.reply.text(text, { mentions: [targetId] });
      return;
    }

    if (msg.is("close")) {
      const sub = (msg.args[0] ?? "").toLowerCase();
      if (sub === "agenda") {
        if (!(await chat.isSenderAdmin())) { await msg.reply.text(t("adminOnly")); return; }
        const action = (msg.args[1] ?? "").toLowerCase();
        if (action === "status") await sendCloseAgendaStatus(ctx);
        else if (action === "reset") await startCloseAgendaReset(ctx);
        else await startCloseAgendaWizard(ctx);
        return;
      }
    }

    if (msg.is("close") || msg.is("open")) {
      if (!(await chat.isSenderAdmin())) {
        await msg.reply.text(t("adminOnly"));
        return;
      }

      if (!(await chat.isBotAdmin())) {
        await msg.reply.text(t("commonBotNotAdmin"));
        return;
      }
      const closing = msg.is("close");
      const result = await (closing ? chat.close() : chat.open());
      if (result.status === "ok") await msg.reply.text(t(closing ? "closeSuccess" : "openSuccess"));
      else if (result.status === "not_authorized") await msg.reply.text(t("commonBotNotAdmin"));
      else await msg.reply.text(t(closing ? "closeFailed" : "openFailed"));
      return;
    }

    if (msg.is("antispam")) {
      if (!(await chat.isSenderAdmin())) {
        await msg.reply.text(t("adminOnly"));
        return;
      }

      const sub = (msg.args[0] ?? "").toLowerCase();

      if (sub === "on" || sub === "off") {
        await settings.set(ANTISPAM_KEY, sub === "on");
        await msg.reply.text(t("antispamToggled", { status: sub === "on" ? t("enabled") : t("disabled") }));
        return;
      }

      if (sub === "status") {
        const current = (await settings.get(ANTISPAM_KEY)) ?? false;
        await msg.reply.text(t("antispamStatus", { status: current ? t("enabled") : t("disabled") }));
        return;
      }

      await msg.reply.text(t("antispamUsage", { prefix }));
      return;
    }

    if (msg.is("linkblock")) {
      if (!(await chat.isSenderAdmin())) {
        await msg.reply.text(t("adminOnly"));
        return;
      }

      const sub = msg.args[0]?.toLowerCase();

      if (sub === "on" || sub === "off") {
        await communitySet(ctx, SETTING_KEY, sub === "on");
        await msg.reply.text(t("linkblockToggled", { status: sub === "on" ? t("enabled") : t("disabled") }));
        return;
      }

      if (sub === "allow" || sub === "disallow") {
        const domains = msg.args?.toLowerCase().replace(/^www\./, "").replace(/^https:\/\/\./, "");
        if (!domains) {
          await msg.reply.text(t("linkblockDomainUsage", { action: sub, prefix }));
          return;
        }

        const list = new Set(await getAllowedDomains(settings));
        if (sub === "allow") list.add(domains);
        else list.delete(domains);

        await settings.set(LINK_ALLOWED_KEY, [...list]);
        await msg.reply.text(t(sub === "allow" ? "linkblockAllowed" : "linkblockDisallowed", { domains }));
        return;
      }

      if (sub === "list") {
        const domains = await getAllowedDomains(settings);
        await msg.reply.text(t("linkblockList", { domains: domains.join(", ") || t("autobanNone") }));
        return;
      }

      if (sub === "reset") {
        await settings.delete(LINK_ALLOWED_KEY);
        await msg.reply.text(t("linkblockReset"));
        return;
      }

      if (sub) {
        await msg.reply.text(t("linkblockUsage"));
        return;
      }

      const current = await isLinkBlockEnabled(ctx);
      await msg.reply.text(t("linkblockStatus", { status: current ? t("enabled") : t("disabled") }));
      return;
    }

    if (msg.is("cleanmsg")) {
      if (!(await chat.isSenderAdmin())) {
        await msg.reply.text(t("adminOnly"));
        return;
      }

      const count = Number(msg.args[0]);
      if (!Number.isInteger(count) || count < 0 || count > CLEANMSG_MAX) {
        await msg.reply.text(t("cleanmsgUsage", { max: CLEANMSG_MAX, prefix }));
        return;
      }

      log.info(`cleanmsg: mentionedJid=${JSON.stringify(msg.mentionedJid)}`);
      let targetId = msg.mentionedJid?.[0];
      const replied = await msg.getReply();
      if (!targetId) targetId = replied?.sender;
      if (!targetId) {
        await msg.reply.text(t("commonMissingTarget"));
        return;
      }

      if (count === 0) {
        await msg.reply.text(t("cleanmsgZero"));
        return;
      }

      const targetMessages = chat.history.from(targetId).last(count);
      let deleted = 0;

      const all = chat.history;
      const filtered = all.from(targetId);
      log.info(`history total=${all.length} filtrado=${filtered.length}`);

      for (const old of targetMessages) {
        const ok = await old.delete().then(() => true).catch((err: Error | null) => {
          log.error(`cleanmsg delete failed id=${old.id} type=${old.type}`, err);
          return false;
        });
        if (ok) deleted++;
      }

      await msg.reply.text(t("cleanmsgDone", { count: deleted }));
      return;
    }

    if (msg.is("autoban")) {
      if (!(await chat.isSenderAdmin())) {
        await msg.reply.text(t("adminOnly"));
        return;
      }

      const groupId = resolveAutobanKey(chat);
      const configs = await loadAutobanConfigs(ctx);
      const config = configs[groupId] ?? defaultAutobanConfig();
      const sub = (msg.args[0] ?? "").toLowerCase();

      if (sub === "on" || sub === "off") {
        config.enabled = sub === "on";
        configs[groupId] = config;
        await saveAutobanConfigs(ctx, configs);
        await msg.reply.text(t("autobanToggled", { status: config.enabled ? t("enabled") : t("disabled") }));
        return;
      }

      if (sub === "status") {
        await msg.reply.text(t("autobanStatus", { status: config.enabled ? t("enabled") : t("disabled") }));
        return;
      }

      if (sub === "list") {
        await msg.reply.text(
          t("autobanList", {
            status: config.enabled ? t("enabled") : t("disabled"),
            numbers: config.numbers.join(", ") || t("autobanNone"),
            ddds: config.ddds.join(", ") || t("autobanNone"),
            ccs: config.ccs.join(", ") || t("autobanNone"),
          })
        );
        return;
      }

      if (sub === "add" || sub === "remove") {
        const type = (msg.args[1] ?? "").toLowerCase() as AutobanType;
        const value = (msg.args[2] ?? "").replace(/\D/g, "");

        if (!value || !AUTOBAN_TYPES.includes(type)) {
          await msg.reply.text(t("autobanUsageAddRemove", { action: sub, prefix }));
          return;
        }

        const list = autobanListFor(config, type);
        const idx = list.indexOf(value);
        if (sub === "add" && idx === -1) list.push(value);
        if (sub === "remove" && idx !== -1) list.splice(idx, 1);

        configs[groupId] = config;
        await saveAutobanConfigs(ctx, configs);
        await msg.reply.text(t(sub === "add" ? "autobanAdded" : "autobanRemoved", { type, value }));
        return;
      }

      await msg.reply.text(t("autobanUsage", { prefix }));
      return;
    }

    if (msg.is("todos") || msg.is("admins")) {
      const participants = await chat.getParticipants();
      const adminsOnly = msg.is("admins");

      const targets = participants.filter((p: CommunityParticipant) => {
        if (p.id === ctx.botId) return false;
        return !adminsOnly || p.isAdmin || p.isSuperAdmin;
      });

      if (targets.length === 0) {
        await msg.reply.text(t(adminsOnly ? "adminsNone" : "todosNone"));
        return;
      }

      const mentions = await Promise.all(
        targets.map(async (p: CommunityParticipant) => {
          const c = await ctx.contacts.get(p.id).catch(() => null);
          return c?.mention ?? p.mention;
        })
      );

      const chunks: Array<typeof mentions> = [];
      for (let i = 0; i < mentions.length; i += MENTION_CHUNK) {
        chunks.push(mentions.slice(i, i + MENTION_CHUNK));
      }

      for (const [idx, chunk] of chunks.entries()) {
        const text = chunk.map((m) => m.text).join(" ");
        const ids = chunk.flatMap((m) => m.mentions);
        const header = chunks.length > 1
          ? (adminsOnly ? t("adminsChunk", { n: idx + 1, total: chunks.length }) : t("todosChunk", { n: idx + 1, total: chunks.length })) + "\n"
          : "";
        await (idx === 0 ? msg.reply : send).text(`${header}${text}`, { mentions: ids });
      }
      return;
    }

    return;
  }

  if (!(await isLinkBlockEnabled(ctx))) return;
  if (!msg.body) return;

  const domains = extractDomains(msg.body);
  const allowedDomains = await getAllowedDomains(settings);
  if (domains.length === 0 || domains.every((d) => isAllowed(d, allowedDomains))) return;
  if (await chat.isSenderAdmin()) return;

  try {
    await msg.delete();
    await send.text(t("linkblockNotice"), {
      mentions: [msg.sender],
    });
  } catch (err) {
    log.error("link block failed", err);
  }
}

export async function muted(ctx: any) {
  const { msg, log } = ctx;
  try {
    await msg.delete();
  } catch (err) {
    log.error("muted: falha ao apagar mensagem", err);
  }
}

export async function setup(ctx: any) {
  adminCtx = ctx;

  ctx.scheduler.schedule("* * * * *", closeScheduleTick);

  ctx.events.on("group-participants.update", async (update: any) => {
    if (update.action !== "add") return;

    const communityMap = (await ctx.settings.global.get(COMMUNITY_MAP_KEY)) ?? {};
    const effectiveId = communityMap[update.id] ?? update.id;

    const configs = await loadAutobanConfigs(ctx);
    const config = configs[effectiveId];
    if (!config?.enabled) return;
    if (!config.numbers.length && !config.ddds.length && !config.ccs.length) return;

    const toKick: string[] = [];
    for (const participantId of update.participants ?? []) {
      if (participantId === ctx.botId) continue;
      const contact = await ctx.contacts.get(participantId).catch(() => null);
      if (matchesAutobanBlacklist(contact, config)) toKick.push(participantId);
    }
    if (!toKick.length) return;

    // Mesma rota do !ban: banEverywhere decide o escopo certo (community vs
    // grupo isolado) e devolve removed/failed por participante, então só
    // bloqueamos quem realmente saiu.
    for (const participantId of toKick) {
      try {
        const { removed, failed } = await banEverywhere(ctx.admin, participantId, effectiveId);
        if (removed.length) {
          await ctx.contacts.block(participantId).catch(() => {});
          ctx.log.info(`autoban: removido ${participantId} de ${removed.length} grupo(s) (escopo=${effectiveId})`);
        }
        if (failed.length) {
          ctx.log.warn(
            `autoban: falha parcial ao remover ${participantId} em ${failed.map((f) => f.name).join(", ")}`
          );
        }
      } catch (err) {
        ctx.log.error(`autoban: falha ao remover participante ${participantId}`, err);
      }
    }
  });
}

