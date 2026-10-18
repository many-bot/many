/** @param {import('@manybot/types/pt').PluginContext} ctx */
export default async function (ctx) {
  const { msg, i18n } = ctx;
  if (msg.fromMe) return;
  if (!msg.is("language") && !msg.is("idioma")) return;

  const { t } = i18n.createT(import.meta.url);

  const SUPPORTED = ["pt", "en"];
  const BLOCKED = ["es"];

  const ALIASES = {
    pt: "pt",
    portugues: "pt",
    português: "pt",
    portuguese: "pt",
    en: "en",
    ingles: "en",
    inglês: "en",
    english: "en",
  };

  const raw = msg.args[0];

  // !language (no args) → show current
  if (!raw) {
    const current = i18n.getChatLocale() ?? i18n.getCurrentLang();
    await msg.reply.text(t("status", { lang: current }));
    return;
  }

  const normalized = ALIASES[raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "")];

  // Unknown alias
  if (!normalized) {
    if (BLOCKED.some((b) => raw.toLowerCase().startsWith(b))) {
      await msg.reply.text(t("blocked", { lang: raw }));
      return;
    }
    await msg.reply.text(t("invalid", { lang: raw }));
    return;
  }

  // Blocked language
  if (BLOCKED.includes(normalized)) {
    await msg.reply.text(t("blocked", { lang: normalized }));
    return;
  }

  try {
    const saved = i18n.setChatLocale(normalized);
    await msg.reply.text(t("changed", { lang: saved }));
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    await msg.reply.text(t("invalid", { lang: raw }));
  }
}

