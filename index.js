import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { createClient } from "@supabase/supabase-js";
import express from "express";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID ?? "0");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = Number(process.env.PORT ?? "8080");

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Telegraf(BOT_TOKEN);

const GENRES = [
  "Action", "Comedy", "Drama", "Horror", "Romance",
  "Thriller", "Sci-Fi", "Animation", "Documentary", "Crime",
  "Fantasy", "Mystery", "Adventure", "Biography", "History",
];

const LANGUAGES = ["English", "Yoruba", "Igbo", "Hausa", "French", "Korean", "Spanish"];

const uploadSessions = new Map();
const broadcastSessions = new Map();

function isAdmin(ctx) {
  return ctx.from?.id === ADMIN_ID;
}

function formatContent(c) {
  const genreStr = Array.isArray(c.genre) ? c.genre.join(", ") : "";
  const premiumBadge = c.is_premium ? "💎 Premium" : "🆓 Free";
  return (
    `🎬 *${c.title}*\n` +
    `📂 Type: ${String(c.type).toUpperCase()}\n` +
    (genreStr ? `🎭 Genre: ${genreStr}\n` : "") +
    (c.year ? `📅 Year: ${c.year}\n` : "") +
    (c.language ? `🌍 Language: ${c.language}\n` : "") +
    (c.rating ? `⭐ Rating: ${c.rating}\n` : "") +
    `🏷️ ${premiumBadge}\n` +
    (c.description ? `\n📝 ${c.description}` : "")
  );
}

function mainMenuKeyboard(adminUser) {
  const rows = [
    [Markup.button.callback("🔍 Search", "search"), Markup.button.callback("🎭 Browse by Genre", "browse_genre")],
    [Markup.button.callback("🆕 Latest Releases", "latest"), Markup.button.callback("💎 Premium Content", "premium_info")],
    [Markup.button.callback("📋 My Account", "my_account")],
  ];
  if (adminUser) rows.push([Markup.button.callback("⚙️ Admin Panel", "admin_panel")]);
  return Markup.inlineKeyboard(rows);
}

async function registerUser(telegramId, username, firstName) {
  await supabase.from("users").upsert(
    { telegram_id: telegramId, username: username ?? null, first_name: firstName ?? null },
    { onConflict: "telegram_id" }
  );
}

async function getAllUsers() {
  const { data } = await supabase.from("users").select("telegram_id");
  return data ?? [];
}

async function getStats() {
  const [{ count: totalUsers }, { count: totalContent }, { count: premiumUsers }] = await Promise.all([
    supabase.from("users").select("*", { count: "exact", head: true }),
    supabase.from("content").select("*", { count: "exact", head: true }),
    supabase.from("users").select("*", { count: "exact", head: true }).eq("is_premium", true),
  ]);
  return { totalUsers: totalUsers ?? 0, totalContent: totalContent ?? 0, premiumUsers: premiumUsers ?? 0 };
}

async function searchContent(query) {
  const { data } = await supabase.from("content").select("*")
    .or(`title.ilike.%${query}%,description.ilike.%${query}%`)
    .order("created_at", { ascending: false }).limit(10);
  return data ?? [];
}

async function getContentByGenre(genre) {
  const { data } = await supabase.from("content").select("*")
    .contains("genre", [genre]).order("created_at", { ascending: false }).limit(10);
  return data ?? [];
}

async function getContentById(id) {
  const { data } = await supabase.from("content").select("*").eq("id", id).single();
  return data;
}

async function getEpisodes(contentId) {
  const { data } = await supabase.from("episodes").select("*")
    .eq("content_id", contentId).order("season").order("episode");
  return data ?? [];
}

async function getMovieFile(contentId) {
  const { data } = await supabase.from("movies").select("*").eq("content_id", contentId).single();
  return data;
}

async function insertContent(payload) {
  const { data, error } = await supabase.from("content").insert(payload).select().single();
  if (error) throw error;
  return data;
}

async function insertMovie(contentId, fileId, fileType) {
  const { error } = await supabase.from("movies").insert({ content_id: contentId, file_id: fileId, file_type: fileType });
  if (error) throw error;
}

async function insertEpisode(payload) {
  const { error } = await supabase.from("episodes").insert(payload);
  if (error) throw error;
}

async function deleteContent(id) {
  await supabase.from("content").delete().eq("id", id);
}

async function getLatestContent(limit = 8) {
  const { data } = await supabase.from("content").select("*").order("created_at", { ascending: false }).limit(limit);
  return data ?? [];
}

async function grantPremium(telegramId) {
  await supabase.from("users").update({ is_premium: true }).eq("telegram_id", telegramId);
}

async function revokePremium(telegramId) {
  await supabase.from("users").update({ is_premium: false }).eq("telegram_id", telegramId);
}

async function isUserPremium(telegramId) {
  const { data } = await supabase.from("users").select("is_premium").eq("telegram_id", telegramId).single();
  return data?.is_premium ?? false;
}

async function logBroadcast(message, sentCount) {
  await supabase.from("broadcast_log").insert({ message, sent_count: sentCount });
}

// ─── Commands ───────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await registerUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const appUrl = WEBHOOK_URL || null;
  const rows = [
    [Markup.button.callback("🔍 Search", "search"), Markup.button.callback("🎭 Browse by Genre", "browse_genre")],
    [Markup.button.callback("🆕 Latest Releases", "latest"), Markup.button.callback("💎 Premium Content", "premium_info")],
    [Markup.button.callback("📋 My Account", "my_account")],
  ];
  if (appUrl) rows.unshift([Markup.button.webApp("🎬 Open DY SHOWS App", appUrl)]);
  if (isAdmin(ctx)) rows.push([Markup.button.callback("⚙️ Admin Panel", "admin_panel")]);
  await ctx.reply(
    `🎥 *Welcome to DY SHOWS!*\n\nYour gateway to the finest movies and series.\nStream premium content right here on Telegram.\n\nUse the menu below to explore:`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }
  );
});

bot.command("menu", async (ctx) => {
  await ctx.reply("🏠 *Main Menu*", { parse_mode: "Markdown", ...mainMenuKeyboard(isAdmin(ctx)) });
});

bot.command("upload", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Unauthorized");
  uploadSessions.set(ctx.from.id, { step: "choose_type" });
  await ctx.reply("🎬 *Upload Content*\n\nWhat type of content?", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🎥 Single Movie", "upload_movie"), Markup.button.callback("📺 Series", "upload_series")],
      [Markup.button.callback("❌ Cancel", "cancel")],
    ]),
  });
});

bot.command("stats", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Unauthorized");
  const s = await getStats();
  await ctx.reply(`📊 *DY SHOWS Statistics*\n\n👥 Total Users: ${s.totalUsers}\n💎 Premium Users: ${s.premiumUsers}\n🎬 Total Content: ${s.totalContent}`, { parse_mode: "Markdown" });
});

bot.command("broadcast", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Unauthorized");
  broadcastSessions.set(ctx.from.id, true);
  await ctx.reply("📢 *Broadcast Message*\n\nSend your message:", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "cancel")]]) });
});

bot.command("grant", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Unauthorized");
  const args = ctx.message.text.split(" ");
  if (args.length < 2) return ctx.reply("Usage: /grant <telegram_id>");
  await grantPremium(Number(args[1]));
  await ctx.reply(`✅ Premium granted to user ${args[1]}`);
});

bot.command("revoke", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Unauthorized");
  const args = ctx.message.text.split(" ");
  if (args.length < 2) return ctx.reply("Usage: /revoke <telegram_id>");
  await revokePremium(Number(args[1]));
  await ctx.reply(`✅ Premium revoked for user ${args[1]}`);
});

bot.command("delete", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Unauthorized");
  const args = ctx.message.text.split(" ");
  if (args.length < 2) return ctx.reply("Usage: /delete <content_id>");
  await deleteContent(Number(args[1]));
  await ctx.reply(`✅ Content #${args[1]} deleted`);
});

// ─── Actions ────────────────────────────────────────────────────────────────

bot.action("search", async (ctx) => {
  await ctx.answerCbQuery();
  uploadSessions.set(ctx.from.id, { step: "searching" });
  await ctx.reply("🔍 *Search DY SHOWS*\n\nSend the title:", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "cancel")]]) });
});

bot.action("browse_genre", async (ctx) => {
  await ctx.answerCbQuery();
  const rows = [];
  for (let i = 0; i < GENRES.length; i += 3) {
    rows.push(GENRES.slice(i, i + 3).map((g) => Markup.button.callback(g, `genre_${g}`)));
  }
  rows.push([Markup.button.callback("🏠 Home", "home")]);
  await ctx.reply("🎭 *Browse by Genre*\n\nChoose a genre:", { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
});

bot.action(/^genre_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const genre = ctx.match[1];
  if (genre.startsWith("select_") || genre === "done") return;
  const results = await getContentByGenre(genre);
  if (!results.length) return ctx.reply(`😕 No ${genre} content found yet.`, { ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Home", "home")]]) });
  const rows = results.map((c) => [Markup.button.callback(`${c.type === "series" ? "📺" : "🎥"} ${c.title}${c.is_premium ? " 💎" : ""}`, `view_${c.id}`)]);
  rows.push([Markup.button.callback("🏠 Home", "home")]);
  await ctx.reply(`🎭 *${genre}* — ${results.length} title(s):`, { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
});

bot.action("latest", async (ctx) => {
  await ctx.answerCbQuery();
  const latest = await getLatestContent(8);
  if (!latest.length) return ctx.reply("No content yet. Check back soon!", { ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Home", "home")]]) });
  const rows = latest.map((c) => [Markup.button.callback(`${c.type === "series" ? "📺" : "🎥"} ${c.title}${c.is_premium ? " 💎" : ""}`, `view_${c.id}`)]);
  rows.push([Markup.button.callback("🏠 Home", "home")]);
  await ctx.reply("🆕 *Latest Releases*", { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
});

bot.action("premium_info", async (ctx) => {
  await ctx.answerCbQuery();
  const isPremium = await isUserPremium(ctx.from.id);
  if (isPremium) {
    await ctx.reply("💎 *You have Premium Access!*\n\nEnjoy unlimited streaming!", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Home", "home")]]) });
  } else {
    await ctx.reply("💎 *DY SHOWS Premium*\n\n✅ Exclusive movies\n✅ Full series\n✅ HD quality\n✅ Early access\n\nContact @DYShowsAdmin to subscribe.", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Home", "home")]]) });
  }
});

bot.action("my_account", async (ctx) => {
  await ctx.answerCbQuery();
  const isPremium = await isUserPremium(ctx.from.id);
  const u = ctx.from;
  await ctx.reply(
    `👤 *My Account*\n\nName: ${u.first_name ?? "N/A"}\nUsername: ${u.username ? `@${u.username}` : "N/A"}\nID: \`${u.id}\`\nStatus: ${isPremium ? "💎 Premium" : "🆓 Free"}`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Home", "home")]]) }
  );
});

bot.action("admin_panel", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  await ctx.reply("⚙️ *Admin Panel*\n\nChoose an action:", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("📤 Upload Content", "admin_upload"), Markup.button.callback("📊 Statistics", "admin_stats")],
      [Markup.button.callback("📢 Broadcast", "admin_broadcast"), Markup.button.callback("🗑️ Delete Content", "admin_delete")],
      [Markup.button.callback("🏠 Home", "home")],
    ]),
  });
});

bot.action("admin_upload", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  uploadSessions.set(ctx.from.id, { step: "choose_type" });
  await ctx.reply("🎬 *Upload Content*\n\nWhat type?", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🎥 Single Movie", "upload_movie"), Markup.button.callback("📺 Series", "upload_series")],
      [Markup.button.callback("❌ Cancel", "cancel")],
    ]),
  });
});

bot.action("admin_stats", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  const s = await getStats();
  await ctx.reply(`📊 *Statistics*\n\n👥 Users: ${s.totalUsers}\n💎 Premium: ${s.premiumUsers}\n🎬 Content: ${s.totalContent}`, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "admin_panel")]]) });
});

bot.action("admin_broadcast", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  broadcastSessions.set(ctx.from.id, true);
  await ctx.reply("📢 Send the message to broadcast:", { ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "cancel")]]) });
});

bot.action("admin_delete", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  uploadSessions.set(ctx.from.id, { step: "delete_content" });
  await ctx.reply("🗑️ Send the content ID to delete:", { ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "cancel")]]) });
});

bot.action("upload_movie", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  uploadSessions.set(ctx.from.id, { step: "title", type: "movie" });
  await ctx.reply("🎥 *Upload Movie*\n\nStep 1: Send the *movie title*:", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "cancel")]]) });
});

bot.action("upload_series", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  uploadSessions.set(ctx.from.id, { step: "title", type: "series" });
  await ctx.reply("📺 *Upload Series*\n\nStep 1: Send the *series title*:", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "cancel")]]) });
});

bot.action(/^view_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const content = await getContentById(id);
  if (!content) return ctx.reply("Content not found.");
  if (content.is_premium && !isAdmin(ctx)) {
    const premium = await isUserPremium(ctx.from.id);
    if (!premium) return ctx.reply("💎 *Premium Content*\n\nContact @DYShowsAdmin to upgrade.", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Home", "home")]]) });
  }
  const buttons = [];
  if (content.type === "series") {
    buttons.push([Markup.button.callback("📺 View Episodes", `episodes_${id}`)]);
  } else {
    buttons.push([Markup.button.callback("▶️ Watch Now", `watch_${id}`)]);
  }
  if (isAdmin(ctx)) buttons.push([Markup.button.callback("🗑️ Delete", `delete_${id}`)]);
  buttons.push([Markup.button.callback("🏠 Home", "home")]);
  if (content.cover_url) {
    try {
      await ctx.replyWithPhoto(content.cover_url, { caption: formatContent(content), parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
      return;
    } catch {}
  }
  await ctx.reply(formatContent(content), { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^watch_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const content = await getContentById(id);
  if (!content) return ctx.reply("Content not found.");
  if (content.is_premium && !isAdmin(ctx)) {
    const premium = await isUserPremium(ctx.from.id);
    if (!premium) return ctx.reply("💎 Premium access required. Contact @DYShowsAdmin.");
  }
  const movie = await getMovieFile(id);
  if (!movie) return ctx.reply("Movie file not found.");
  try {
    if (movie.file_type === "video") {
      await ctx.replyWithVideo(movie.file_id, { caption: `🎥 *${content.title}*\n\nEnjoy! 🍿`, parse_mode: "Markdown" });
    } else {
      await ctx.replyWithDocument(movie.file_id, { caption: `🎥 *${content.title}*\n\nEnjoy! 🍿`, parse_mode: "Markdown" });
    }
  } catch { await ctx.reply("❌ Error sending file."); }
});

bot.action(/^episodes_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const episodes = await getEpisodes(id);
  if (!episodes.length) return ctx.reply("No episodes uploaded yet.");
  const grouped = {};
  for (const ep of episodes) {
    if (!grouped[ep.season]) grouped[ep.season] = [];
    grouped[ep.season].push(ep);
  }
  const rows = Object.entries(grouped).map(([season, eps]) => [Markup.button.callback(`📺 Season ${season} (${eps.length} eps)`, `season_${id}_${season}`)]);
  rows.push([Markup.button.callback("🏠 Home", "home")]);
  await ctx.reply("📺 *Select a Season:*", { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
});

bot.action(/^season_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const contentId = Number(ctx.match[1]);
  const season = Number(ctx.match[2]);
  const episodes = (await getEpisodes(contentId)).filter((e) => e.season === season);
  const rows = episodes.map((ep) => [Markup.button.callback(`E${ep.episode}${ep.title ? `: ${ep.title}` : ""}`, `ep_${ep.id}`)]);
  rows.push([Markup.button.callback("⬅️ Back", `episodes_${contentId}`), Markup.button.callback("🏠 Home", "home")]);
  await ctx.reply(`📺 *Season ${season} Episodes:*`, { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
});

bot.action(/^ep_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery("Loading...");
  const epId = Number(ctx.match[1]);
  const { data } = await supabase.from("episodes").select("*, content(*)").eq("id", epId).single();
  if (!data) return ctx.reply("Episode not found.");
  if (data.content?.is_premium && !isAdmin(ctx)) {
    const premium = await isUserPremium(ctx.from.id);
    if (!premium) return ctx.reply("💎 Premium access required.");
  }
  try {
    const caption = `📺 S${data.season}E${data.episode}${data.title ? `: ${data.title}` : ""}\n\n🎬 DY SHOWS`;
    if (data.file_type === "video") {
      await ctx.replyWithVideo(data.file_id, { caption, parse_mode: "Markdown" });
    } else {
      await ctx.replyWithDocument(data.file_id, { caption, parse_mode: "Markdown" });
    }
  } catch { await ctx.reply("❌ Error sending episode."); }
});

bot.action(/^delete_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  await deleteContent(Number(ctx.match[1]));
  await ctx.reply(`✅ Content deleted.`);
});

bot.action("home", async (ctx) => {
  await ctx.answerCbQuery();
  uploadSessions.delete(ctx.from.id);
  await ctx.reply("🏠 *DY SHOWS — Main Menu*", { parse_mode: "Markdown", ...mainMenuKeyboard(isAdmin(ctx)) });
});

bot.action("cancel", async (ctx) => {
  await ctx.answerCbQuery("Cancelled");
  uploadSessions.delete(ctx.from.id);
  broadcastSessions.delete(ctx.from.id);
  await ctx.reply("❌ Cancelled.", { ...mainMenuKeyboard(isAdmin(ctx)) });
});

bot.action("upload_done", async (ctx) => {
  await ctx.answerCbQuery();
  uploadSessions.delete(ctx.from.id);
  await ctx.reply("✅ Upload complete!", { ...mainMenuKeyboard(true) });
});

bot.action("skip_description", async (ctx) => {
  await ctx.answerCbQuery();
  const session = uploadSessions.get(ctx.from.id);
  if (!session) return;
  session.step = "cover";
  uploadSessions.set(ctx.from.id, session);
  await ctx.reply("🖼️ Send a cover image or skip:", { ...Markup.inlineKeyboard([[Markup.button.callback("⏭ Skip", "skip_cover"), Markup.button.callback("❌ Cancel", "cancel")]]) });
});

bot.action("skip_cover", async (ctx) => {
  await ctx.answerCbQuery();
  const session = uploadSessions.get(ctx.from.id);
  if (!session) return;
  session.step = "premium";
  uploadSessions.set(ctx.from.id, session);
  await ctx.reply("💎 Is this premium content?", {
    ...Markup.inlineKeyboard([[Markup.button.callback("💎 Yes, Premium", "set_premium_true"), Markup.button.callback("🆓 No, Free", "set_premium_false")], [Markup.button.callback("❌ Cancel", "cancel")]]),
  });
});

bot.action("set_premium_true", async (ctx) => {
  await ctx.answerCbQuery();
  const session = uploadSessions.get(ctx.from.id);
  if (!session) return;
  session.is_premium = true;
  session.step = "year";
  uploadSessions.set(ctx.from.id, session);
  await ctx.reply("📅 Send the release year (e.g. 2024) or skip:", { ...Markup.inlineKeyboard([[Markup.button.callback("⏭ Skip", "skip_year"), Markup.button.callback("❌ Cancel", "cancel")]]) });
});

bot.action("set_premium_false", async (ctx) => {
  await ctx.answerCbQuery();
  const session = uploadSessions.get(ctx.from.id);
  if (!session) return;
  session.is_premium = false;
  session.step = "year";
  uploadSessions.set(ctx.from.id, session);
  await ctx.reply("📅 Send the release year (e.g. 2024) or skip:", { ...Markup.inlineKeyboard([[Markup.button.callback("⏭ Skip", "skip_year"), Markup.button.callback("❌ Cancel", "cancel")]]) });
});

bot.action("skip_year", async (ctx) => {
  await ctx.answerCbQuery();
  const session = uploadSessions.get(ctx.from.id);
  if (!session) return;
  session.step = "language";
  uploadSessions.set(ctx.from.id, session);
  await ctx.reply("🌍 Select language:", { ...Markup.inlineKeyboard(LANGUAGES.map((l) => [Markup.button.callback(l, `lang_${l}`)]).concat([[Markup.button.callback("❌ Cancel", "cancel")]])) });
});

bot.action("skip_ep_title", async (ctx) => {
  await ctx.answerCbQuery();
  const session = uploadSessions.get(ctx.from.id);
  if (!session) return;
  session.step = "episode_file";
  uploadSessions.set(ctx.from.id, session);
  await ctx.reply("📁 Send the episode file:", { ...Markup.inlineKeyboard([[Markup.button.callback("✅ Done", "upload_done")]]) });
});

for (const lang of LANGUAGES) {
  bot.action(`lang_${lang}`, async (ctx) => {
    await ctx.answerCbQuery();
    const session = uploadSessions.get(ctx.from.id);
    if (!session || session.step !== "language") return;
    session.language = lang;
    if (session.type === "movie") {
      session.step = "file";
      uploadSessions.set(ctx.from.id, session);
      await ctx.reply("📁 *Now send the movie file* (video or document):", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "cancel")]]) });
    } else {
      try {
        const content = await insertContent({
          type: "series", title: session.title, genre: session.genre ?? [],
          description: session.description, cover_url: session.cover_url,
          is_premium: session.is_premium ?? false, year: session.year, language: lang,
        });
        session.content_id = content.id;
        session.step = "episode_season";
        uploadSessions.set(ctx.from.id, session);
        await ctx.reply(`✅ *Series "${session.title}" created!*\n\nNow upload episodes.\nWhich season? (send number, e.g. 1)`, {
          parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("✅ Done Uploading", "upload_done")]]),
        });
      } catch { await ctx.reply("❌ Error creating series."); }
    }
  });
}

bot.action(/^genre_select_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const session = uploadSessions.get(ctx.from.id);
  if (!session || session.step !== "genre") return;
  const genre = ctx.match[1];
  if (!session.genre) session.genre = [];
  if (session.genre.includes(genre)) { session.genre = session.genre.filter((g) => g !== genre); } else { session.genre.push(genre); }
  uploadSessions.set(ctx.from.id, session);
  const rows = [];
  for (let i = 0; i < GENRES.length; i += 3) {
    rows.push(GENRES.slice(i, i + 3).map((g) => Markup.button.callback(`${session.genre.includes(g) ? "✅ " : ""}${g}`, `genre_select_${g}`)));
  }
  rows.push([Markup.button.callback("✅ Done", "genre_done"), Markup.button.callback("❌ Cancel", "cancel")]);
  await ctx.editMessageText(`🎭 *Select Genre(s)* — Selected: ${session.genre.join(", ") || "none"}\n\nTap to toggle:`, { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
});

bot.action("genre_done", async (ctx) => {
  await ctx.answerCbQuery();
  const session = uploadSessions.get(ctx.from.id);
  if (!session || session.step !== "genre") return;
  if (!session.genre?.length) return ctx.answerCbQuery("Select at least one genre", { show_alert: true });
  session.step = "description";
  uploadSessions.set(ctx.from.id, session);
  await ctx.reply("📝 Send a short description or skip:", { ...Markup.inlineKeyboard([[Markup.button.callback("⏭ Skip", "skip_description"), Markup.button.callback("❌ Cancel", "cancel")]]) });
});

// ─── Text Handler ────────────────────────────────────────────────────────────

bot.on(message("text"), async (ctx) => {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();

  if (broadcastSessions.has(uid) && isAdmin(ctx)) {
    broadcastSessions.delete(uid);
    const users = await getAllUsers();
    let sent = 0;
    for (const user of users) {
      try { await bot.telegram.sendMessage(user.telegram_id, text, { parse_mode: "Markdown" }); sent++; } catch {}
    }
    await logBroadcast(text, sent);
    return ctx.reply(`✅ Broadcast sent to ${sent}/${users.length} users.`);
  }

  const session = uploadSessions.get(uid);
  if (!session) {
    if (!text.startsWith("/")) {
      const results = await searchContent(text);
      if (!results.length) return ctx.reply(`😕 No results for "*${text}*"`, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Home", "home")]]) });
      const rows = results.map((c) => [Markup.button.callback(`${c.type === "series" ? "📺" : "🎥"} ${c.title}${c.is_premium ? " 💎" : ""}`, `view_${c.id}`)]);
      rows.push([Markup.button.callback("🏠 Home", "home")]);
      return ctx.reply(`🔍 *Results for "${text}":*`, { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
    }
    return;
  }

  switch (session.step) {
    case "searching": {
      uploadSessions.delete(uid);
      const results = await searchContent(text);
      if (!results.length) return ctx.reply(`😕 No results for "*${text}*"`, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Home", "home")]]) });
      const rows = results.map((c) => [Markup.button.callback(`${c.type === "series" ? "📺" : "🎥"} ${c.title}${c.is_premium ? " 💎" : ""}`, `view_${c.id}`)]);
      rows.push([Markup.button.callback("🏠 Home", "home")]);
      return ctx.reply(`🔍 *Results for "${text}":*`, { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
    }
    case "delete_content": {
      if (!isAdmin(ctx)) return;
      uploadSessions.delete(uid);
      await deleteContent(Number(text));
      return ctx.reply(`✅ Content #${text} deleted.`);
    }
    case "title": {
      session.title = text;
      session.step = "genre";
      uploadSessions.set(uid, session);
      const rows = [];
      for (let i = 0; i < GENRES.length; i += 3) rows.push(GENRES.slice(i, i + 3).map((g) => Markup.button.callback(g, `genre_select_${g}`)));
      rows.push([Markup.button.callback("✅ Done", "genre_done"), Markup.button.callback("❌ Cancel", "cancel")]);
      return ctx.reply("🎭 *Select Genre(s)*\n\nTap genres to select, then tap Done:", { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
    }
    case "description": {
      session.description = text === "skip" ? undefined : text;
      session.step = "cover";
      uploadSessions.set(uid, session);
      return ctx.reply("🖼️ Send a cover image URL or skip:", { ...Markup.inlineKeyboard([[Markup.button.callback("⏭ Skip", "skip_cover"), Markup.button.callback("❌ Cancel", "cancel")]]) });
    }
    case "cover": {
      session.cover_url = text;
      session.step = "premium";
      uploadSessions.set(uid, session);
      return ctx.reply("💎 Is this premium content?", {
        ...Markup.inlineKeyboard([[Markup.button.callback("💎 Yes, Premium", "set_premium_true"), Markup.button.callback("🆓 No, Free", "set_premium_false")], [Markup.button.callback("❌ Cancel", "cancel")]]),
      });
    }
    case "year": {
      session.year = Number(text);
      session.step = "language";
      uploadSessions.set(uid, session);
      return ctx.reply("🌍 Select language:", { ...Markup.inlineKeyboard(LANGUAGES.map((l) => [Markup.button.callback(l, `lang_${l}`)]).concat([[Markup.button.callback("❌ Cancel", "cancel")]])) });
    }
    case "episode_season": {
      const season = Number(text);
      if (isNaN(season)) return ctx.reply("Send a valid number.");
      session.season = season;
      session.step = "episode_number";
      uploadSessions.set(uid, session);
      return ctx.reply(`📺 Season ${season} — Which episode number?`, { ...Markup.inlineKeyboard([[Markup.button.callback("✅ Done", "upload_done")]]) });
    }
    case "episode_number": {
      const ep = Number(text);
      if (isNaN(ep)) return ctx.reply("Send a valid number.");
      session.episode = ep;
      session.step = "episode_title";
      uploadSessions.set(uid, session);
      return ctx.reply(`S${session.season}E${ep} — Send episode title or skip:`, { ...Markup.inlineKeyboard([[Markup.button.callback("⏭ Skip", "skip_ep_title"), Markup.button.callback("✅ Done", "upload_done")]]) });
    }
    case "episode_title": {
      session.episode_title = text === "skip" ? undefined : text;
      session.step = "episode_file";
      uploadSessions.set(uid, session);
      return ctx.reply("📁 Send the episode file:", { ...Markup.inlineKeyboard([[Markup.button.callback("✅ Done", "upload_done")]]) });
    }
  }
});

// ─── File Handler ────────────────────────────────────────────────────────────

async function handleFile(ctx, fileId, fileType) {
  const uid = ctx.from.id;
  const session = uploadSessions.get(uid);
  if (!session) return;

  if (session.step === "file" && session.type === "movie") {
    try {
      const content = await insertContent({
        type: "movie", title: session.title, genre: session.genre ?? [],
        description: session.description, cover_url: session.cover_url,
        is_premium: session.is_premium ?? false, year: session.year, language: session.language,
      });
      await insertMovie(content.id, fileId, fileType);
      uploadSessions.delete(uid);
      await ctx.reply(`✅ *Movie "${session.title}" uploaded!*\n\nContent ID: \`${content.id}\``, { parse_mode: "Markdown", ...mainMenuKeyboard(true) });
    } catch { await ctx.reply("❌ Error saving movie."); }
    return;
  }

  if (session.step === "episode_file") {
    try {
      await insertEpisode({ content_id: session.content_id, season: session.season ?? 1, episode: session.episode ?? 1, title: session.episode_title, file_id: fileId, file_type: fileType });
      session.step = "episode_season";
      session.episode = undefined;
      session.episode_title = undefined;
      uploadSessions.set(uid, session);
      await ctx.reply("✅ *Episode uploaded!*\n\nSend the next season number, or tap Done:", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("✅ Done Uploading", "upload_done")]]) });
    } catch { await ctx.reply("❌ Error saving episode."); }
  }
}

bot.on(message("video"), async (ctx) => { await handleFile(ctx, ctx.message.video.file_id, "video"); });
bot.on(message("document"), async (ctx) => { await handleFile(ctx, ctx.message.document.file_id, "document"); });

bot.on(message("photo"), async (ctx) => {
  const uid = ctx.from.id;
  const session = uploadSessions.get(uid);
  if (session?.step === "cover") {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const link = await ctx.telegram.getFileLink(photo.file_id);
    session.cover_url = link.href;
    session.step = "premium";
    uploadSessions.set(uid, session);
    await ctx.reply("💎 Is this premium content?", {
      ...Markup.inlineKeyboard([[Markup.button.callback("💎 Yes, Premium", "set_premium_true"), Markup.button.callback("🆓 No, Free", "set_premium_false")], [Markup.button.callback("❌ Cancel", "cancel")]]),
    });
  } else if (broadcastSessions.has(uid) && isAdmin(ctx)) {
    broadcastSessions.delete(uid);
    const users = await getAllUsers();
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    let sent = 0;
    for (const user of users) {
      try { await bot.telegram.sendPhoto(user.telegram_id, photo.file_id, { caption: ctx.message.caption }); sent++; } catch {}
    }
    await logBroadcast("[Photo broadcast]", sent);
    await ctx.reply(`✅ Photo broadcast sent to ${sent}/${users.length} users.`);
  }
});

bot.catch((err) => { console.error("Bot error:", err); });

// ─── Express + Webhook / Polling ─────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "DY SHOWS" }));

// ── Mini App API Routes ────────────────────────────────────
app.get("/api/content", async (req, res) => {
  try {
    let query = supabase.from("content").select("*");
    if (req.query.type) query = query.eq("type", req.query.type);
    if (req.query.premium === "true") query = query.eq("is_premium", true);
    if (req.query.genre) query = query.contains("genre", [req.query.genre]);
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    query = query.order("created_at", { ascending: false }).limit(limit);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data ?? []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/content/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("content").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/content/:id/episodes", async (req, res) => {
  try {
    const { data, error } = await supabase.from("episodes").select("*").eq("content_id", req.params.id).order("season").order("episode");
    if (error) return res.status(500).json({ error: error.message });
    res.json(data ?? []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q || "";
    if (!q.trim()) return res.json([]);
    const { data, error } = await supabase.from("content").select("*")
      .or(`title.ilike.%${q}%,description.ilike.%${q}%`)
      .order("created_at", { ascending: false }).limit(20);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data ?? []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/webhook", async (req, res) => {
  try { await bot.handleUpdate(req.body); } catch (e) { console.error(e); }
  res.sendStatus(200);
});

async function start() {
  if (WEBHOOK_URL) {
    // Webhook mode — best for Render/production
    await bot.telegram.deleteWebhook();
    app.listen(PORT, async () => {
      console.log(`DY SHOWS bot running on port ${PORT} (webhook mode)`);
      try {
        await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`);
        console.log(`✅ Webhook set: ${WEBHOOK_URL}/webhook`);
      } catch (e) {
        console.error("❌ Failed to set webhook:", e.message);
      }
    });
  } else {
    // Polling mode — works immediately without a public URL
    console.log("WEBHOOK_URL not set — starting in polling mode");
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    // Keep Express alive for health checks (Render requires a port to be open)
    app.listen(PORT, () => {
      console.log(`DY SHOWS bot running on port ${PORT} (polling mode)`);
    });
    bot.launch();
    console.log("✅ Bot launched with long polling");
  }

  // Graceful shutdown
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

start().catch((e) => { console.error("Fatal error:", e); process.exit(1); });
