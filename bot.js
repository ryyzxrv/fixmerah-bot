// bot.js (final) — FDora BotZ v2.0.1
// Node 18+/ESM recommended
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Telegraf, Markup } from "telegraf";
import nodemailer from "nodemailer";
import axios from "axios";
import chalk from "chalk";
import child_process from "child_process";
import { config } from "./config.js";
import { ensurePremiumFile, isPremiumUser, addPremiumUser, listPremium, loadJSON, saveJSON } from "./utils_premium.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- [ FITUR WAJIB JOIN CHANNEL / GRUP TELEGRAM ] ---
// Ambil data dari config.js
const REQUIRED_CHANNEL = config.joinRequirement?.username || config.requiredChannel || null;
const JOIN_LINK = config.joinRequirement?.link || (REQUIRED_CHANNEL ? `https://t.me/${REQUIRED_CHANNEL.replace(/^@/, "")}` : null);

// Fungsi cek apakah user sudah join
async function isUserJoined(ctx) {
  if (!REQUIRED_CHANNEL) return true; // jika tidak diset, anggap tidak wajib
  try {
    const member = await ctx.telegram.getChatMember(REQUIRED_CHANNEL, ctx.from.id);
    return ["member", "administrator", "creator"].includes(member.status);
  } catch (err) {
    console.error("❌ Gagal cek keanggotaan:", err && (err.description || err.message) || err);
    return false;
  }
}

// DATABASE paths
const DB = path.join(__dirname, config.databaseFolder || "./database");
if (!fs.existsSync(DB)) fs.mkdirSync(DB, { recursive: true });

const ACCOUNTS_FILE = path.join(DB, "accounts.json");
const PREMIUM_FILE = path.join(DB, "premium.json");
const USERS_FILE = path.join(DB, "users.json");
const STATS_FILE = path.join(DB, "user_stats.json");

function ensureFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf8");
  }
}
ensureFile(ACCOUNTS_FILE, []);
ensureFile(PREMIUM_FILE, {});
ensureFile(USERS_FILE, {});
ensureFile(STATS_FILE, {});
ensurePremiumFile(PREMIUM_FILE);

// wrappers
const readJSONSafe = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
};
const writeJSONSafe = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2), "utf8");

// runtime helper
const START_TS = Date.now();
const runtime = () => {
  const s = Math.floor((Date.now() - START_TS) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
};

// load accounts list (for sending emails)
let accounts = readJSONSafe(ACCOUNTS_FILE) || [];

// email templates (three languages)
const EMAIL_TEMPLATES = [
  {
    id: "arab",
    subject: "[Secure] Question about WhatsApp for Android — Arabic",
    name: "Violina",
    build: (num) => `السلام عليكم ورحمة الله وبركاته
اسمي Violina أود أن أستعرض المشاكل التي أواجهها
لقد حاولت التحقق من الرقم ولكن هناك نص "Login not available now" عندما أكون مالك الرقم، يرجى مراجعته على الفور. هذا هو رقمي
${num}
السلام عليكم ورحمة الله وبركاته، شكرا لكم.`
  },
  {
    id: "japan",
    subject: "[Secure] Question about WhatsApp for Android — Japanese",
    name: "Violina",
    build: (num) => `こんにちはWhatsApp番号を登録する際に発生した問題を確認するためにここに来ました。
ナマサヤ Violina そして問題に遭遇しました "Login not available" その番号は私が購入したばかりの個人番号です。
これが私の番号です ${num}
この問題をうまく解決して、WhatsApp への登録が簡単になることを願っています。ありがとう。`
  },
  {
    id: "kaz",
    subject: "[Secure] Question about WhatsApp for Android — Kazakh",
    name: "Violina",
    build: (num) => `Құрметті WhatsApp.
Жеке нөмірімді тіркеу кезінде мәселе туындады, қызыл суреті бар хабарлама болды "Login not available" ол кезде менің жеке номерім болатын.
WhatsApp бұл мәселені тез қарап, дұрыс тіркеле аламын деп үміттенемін.
менің жеке нөмірім ${num}
Мұның бәрі меннен Violina алғыс айту.`
  }
];

// helper create transporter (Gmail app password)
function createTransporter(email, appPassword) {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: email,
      pass: String(appPassword).replace(/\s+/g, "")
    }
  });
}
function pickRandomAccount() {
  accounts = readJSONSafe(ACCOUNTS_FILE) || [];
  if (!accounts || accounts.length === 0) return null;
  return accounts[Math.floor(Math.random() * accounts.length)];
}

// pending flows
const pending = {}; // userId -> { action, step, data, createdAt }

// existing cooldown/daily tracking (kept for compatibility)
let lastActionTs = {}; // userId -> timestamp seconds
function canDoAction(userId) {
  const now = Date.now() / 1000;
  const last = lastActionTs[userId] || 0;
  const diff = now - last;
  return diff >= (config.limits.globalCooldownSeconds || 10);
}
function markAction(userId) {
  lastActionTs[userId] = Date.now() / 1000;
}

// Telegraf init
if (!config.botToken || config.botToken === "ISI_TOKEN_BOT_KAMU_DI_SINI") {
  console.error(chalk.red("Please set config.botToken in config.js before running the bot."));
  process.exit(1);
}
const bot = new Telegraf(config.botToken);

// WA client references (created only on /pairing)
let waClient = null;
let waConnected = false;
let baileysModule = null; // will hold imported baileys module when pairing invoked

// safe answer for callback
async function safeAnswerCb(ctx, text = "") {
  try { await ctx.answerCbQuery(text); } catch (e) { /* ignore expired */ }
}

// keyboard helpers
function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧩 Fix Merah", "act_fixmerah")],
    [Markup.button.callback("📱 Cek Nomor", "act_ceknomor"), Markup.button.callback("👤 Cek ID", "act_cekid")],
    [Markup.button.callback("💬 Cek Bio", "act_cekbio"), Markup.button.callback("📨 Add Email", "act_addemail")],
    [Markup.button.callback("💎 Pricelist", "act_pricelist"), Markup.button.url("👑 Owner", `https://t.me/${config.owner.username.replace(/^@/, "")}`)]
  ]);
}
function backKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Kembali", "startback")]
  ]);
}

// edit menu: if original message contains photo -> editMessageMedia else editMessageText/send new photo
async function editMenu(ctx, caption, keyboard) {
  try {
    const msg = ctx.updateType === "callback_query" ? ctx.update.callback_query.message : (ctx.message || {});
    if (msg && msg.photo) {
      // edit existing photo message caption using editMessageMedia
      try {
        await ctx.editMessageMedia({
          type: "photo",
          media: config.ui.startPhoto,
          caption,
          parse_mode: "Markdown"
        }, { reply_markup: keyboard.reply_markup });
        return;
      } catch (e) {
        // fallback to editText if cannot edit media
      }
    }
    // fallback: send a fresh photo with keyboard
    await ctx.replyWithPhoto({ url: config.ui.startPhoto }, { caption, parse_mode: "Markdown", reply_markup: keyboard.reply_markup });
  } catch (e) {
    console.error("editMenu error:", e);
    try { await ctx.reply(caption, keyboard); } catch {}
  }
}

// Build start text
function buildStartText() {
  return `𝐅𝐃𝐨𝐫𝐚 𝐁𝐎𝐓

▢ 𝗦𝗖𝗖𝗥𝗜𝗣𝗧 𝗡𝗔𝗠𝗘 : ${config.botName}
▢ 𝗢𝗪𝗡𝗘𝗥 : ${config.owner.username}
▢ 𝗩𝗘𝗥𝗦𝗜𝗢𝗡 : ${config.version}
▢ 𝗥𝗨𝗡𝗧𝗜𝗠𝗘 : ${runtime()}

${config.owner.name}`;
}

// --- [ HANDLER /START DENGAN WAJIB JOIN CHANNEL ] ---
bot.start(async (ctx) => {
  if (ctx.chat.type !== "private") return; // hanya berlaku di chat pribadi

  const joined = await isUserJoined(ctx);

  if (!joined) {
    return ctx.reply(
      `🚫 *Akses Ditolak*\n\nUntuk menggunakan *${config.botName}*, kamu harus join dulu ke channel/grup resmi kami.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📢 Join Channel / Grup", url: JOIN_LINK }],
            [{ text: "✅ Sudah Join", callback_data: "check_join" }],
          ],
        },
      }
    );
  }
  try {
    // register user
    const users = readJSONSafe(USERS_FILE) || {};
    users[String(ctx.from.id)] = { username: ctx.from.username || "-", name: ctx.from.first_name || "-" };
    writeJSONSafe(USERS_FILE, users);

    const caption = buildStartText();
    // send photo + keyboard
    try {
      if (config.ui && config.ui.startPhoto) {
        await ctx.replyWithPhoto({ url: config.ui.startPhoto }, { caption, parse_mode: "Markdown", reply_markup: mainKeyboard().reply_markup });
      } else {
        await ctx.reply(caption, mainKeyboard());
      }
      // send audio only once (do not spam on each action)
      if (config.ui && config.ui.startAudio) {
        try { await ctx.replyWithAudio({ url: config.ui.startAudio }); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      await ctx.reply(caption, mainKeyboard());
    }
  } catch (e) {
    console.error("start handler error:", e);
    await ctx.reply("Terjadi error saat menampilkan menu.");
  }
});

// Tombol cek ulang join
bot.action("check_join", async (ctx) => {
  const joined = await isUserJoined(ctx);

  if (!joined) {
    return ctx.answerCbQuery("❌ Kamu belum join!", { show_alert: true });
  }

  await ctx.answerCbQuery("✅ Terima kasih sudah join!");
  await ctx.reply(`Selamat datang di ${config.botName} 🎉`);
});

// startback callback
bot.action("startback", async (ctx) => {
  await safeAnswerCb(ctx);
  await editMenu(ctx, buildStartText(), mainKeyboard());
});

// action callbacks (kept like old logic but improved)
bot.action("act_cekid", async (ctx) => {
  await safeAnswerCb(ctx);
  return ctx.replyWithMarkdown(`👤 ID Telegram kamu: \`${ctx.from.id}\``, backKeyboard());
});

bot.action("act_ceknomor", async (ctx) => {
  await safeAnswerCb(ctx);
  pending[ctx.from.id] = { action: "ceknomor", step: 1, createdAt: Date.now() };
  // edit menu to ask for number (use editMenu)
  try {
    await editMenu(ctx, "📱 Kirim nomor (contoh: +628123456789).", backKeyboard());
  } catch {
    await ctx.reply("📱 Kirim nomor (contoh: +628123456789).", backKeyboard());
  }
});

bot.action("act_cekbio", async (ctx) => {
  await safeAnswerCb(ctx);
  // instructions
  const txt = "💬 Gunakan: /cekbio 628123..., atau kirim .txt file lalu /cekbiotxt (reply file). Fitur ini membutuhkan pairing WA via /pairing.";
  try { await editMenu(ctx, txt, backKeyboard()); } catch { await ctx.reply(txt, backKeyboard()); }
});

bot.action("act_addemail", async (ctx) => {
  await safeAnswerCb(ctx);
  pending[ctx.from.id] = { action: "addemail", step: 1, createdAt: Date.now() };
  try { await editMenu(ctx, "📧 Kirim alamat Gmail yang ingin ditambahkan (contoh: example@gmail.com).", backKeyboard()); } catch { await ctx.reply("📧 Kirim alamat Gmail (contoh: example@gmail.com).", backKeyboard()); }
});

bot.action("act_pricelist", async (ctx) => {
  await safeAnswerCb(ctx);
  const prices = config.priceList.map(p => p.days === 0 ? `Permanen — ${p.price}` : `${p.days} hari — ${p.price}`).join("\n");
  return ctx.replyWithMarkdown(`💎 *Pricelist Premium:*\n\n${prices}\n\nChat: ${config.owner.username}`, backKeyboard());
});

bot.action("act_fixmerah", async (ctx) => {
  await safeAnswerCb(ctx);
  const userId = ctx.from.id;

  // check premium / daily limit
  const userIsPremium = isPremiumUser(PREMIUM_FILE, userId);
  const usersStats = readJSONSafe(STATS_FILE) || {};
  const today = new Date().toISOString().slice(0,10);
  usersStats[today] = usersStats[today] || {};
  const userCount = usersStats[today][userId] || 0;
  if (!userIsPremium && userCount >= (config.limits.freeLimitPerDay || 3)) {
    return ctx.reply(`⚠️ Batas harian free (${config.limits.freeLimitPerDay}) tercapai. Upgrade premium untuk akses tanpa batas.`, backKeyboard());
  }

  pending[userId] = { action: "fixmerah", step: 1, createdAt: Date.now() };
  try { await editMenu(ctx, "📥 Masukkan nomor (contoh: +628123456789).", backKeyboard()); } catch { await ctx.reply("📥 Masukkan nomor (contoh: +628123456789).", backKeyboard()); }
});

// CANCEL via text command removed as requested: we use back button to return
// but keep /cancel for safety (will clear pending)
bot.command("cancel", (ctx) => {
  delete pending[ctx.from.id];
  ctx.reply("✅ Aksi dibatalkan.", mainKeyboard());
});

bot.command("pairing", async (ctx) => {
  if (ctx.from.id !== config.owner.id)
    return ctx.reply("❌ Hanya owner yang bisa pakai perintah ini.");

  const phone = ctx.message.text.split(" ")[1]?.replace(/[^0-9]/g, "");
  if (!phone)
    return ctx.reply("📱 Format salah!\nGunakan: `/pairing 628xxxxxx`", { parse_mode: "Markdown" });

  await ctx.reply("🔗 Sedang memulai pairing WhatsApp client...");

  try {
    // 🧩 Import fork Baileys milik Khayzz
    const baileys = await import("@whiskeysockets/baileys");
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;
    const pino = (await import("pino")).default;
    const { Boom } = await import("@hapi/boom");

    const { state, saveCreds } = await useMultiFileAuthState("./session");
    const { version } = await fetchLatestBaileysVersion();

    const waClient = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: state,
      browser: ["FDoraBot", "Chrome", "2.0.1"]
    });

    waClient.ev.on("creds.update", saveCreds);

    // 🪄 Pairing code (fitur unggulan fork Khayzz-Bails)
    const code = await waClient.requestPairingCode(phone);
    await ctx.reply(`✅ *Kode Pairing WhatsApp:*\n\`${code}\`\n\nMasukkan kode ini di WhatsApp kamu:\n*Perangkat Tertaut → Tautkan Perangkat → Masukkan Kode*`, {
      parse_mode: "Markdown"
    });

    waClient.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        ctx.reply("✅ WhatsApp client berhasil tersambung!");
        console.log("WA connected!");
      } else if (connection === "close") {
        const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== 401;
        console.log("⚠️ WA disconnected!");
        if (shouldReconnect) {
          setTimeout(() => ctx.reply("♻️ Menghubungkan ulang..."), 5000);
        }
      }
    });
  } catch (err) {
    console.error("❌ Pairing gagal:", err);
    await ctx.reply("⚠️ Gagal generate pairing code. Coba ulangi atau cek log terminal kamu.");
  }
});

// helper to start WA client programmatically (used internally on reconnect)
async function startWaClient() {
  if (waClient) return;
  try {
    if (!baileysModule) {
      baileysModule = await import("@whiskeysockets/baileys");
    }
    const { default: makeWASocket, useMultiFileAuthState } = baileysModule;
    const { Boom } = await import("@hapi/boom");
    const pino = (await import("pino")).default;
    const { state, saveCreds } = await useMultiFileAuthState(config.baileys.sessionName || "./wa-session");
    waClient = makeWASocket({ logger: pino({ level: "silent" }), auth: state, browser: ["FDora", "Chrome", "1.0"] });
    waClient.ev.on("creds.update", saveCreds);
    waClient.ev.on("connection.update", (u) => {
      const { connection } = u;
      if (connection === "open") waConnected = true;
      else waConnected = false;
    });
  } catch (e) {
    console.error("startWaClient error:", e);
  }
}

// /cekbio command (owner/premium as configured)
bot.command("cekbio", async (ctx) => {
  if (!waClient || !waConnected) return ctx.reply("⚠️ WA client belum tersambung. Gunakan /pairing terlebih dahulu.");
  const parts = ctx.message.text.split(" ").slice(1).join(" ");
  const numbers = (parts.match(/\d+/g) || []).map(s => s.trim());
  if (!numbers.length) return ctx.reply("Gunakan: /cekbio 628123456789 62812...");
  await ctx.reply(`Otw cek ${numbers.length} nomor...`);
  try {
    const jids = numbers.map(n => n + "@s.whatsapp.net");
    const existence = await waClient.onWhatsApp(...jids);
    const registered = existence.filter(r => r.exists).map(r => r.jid.split("@")[0]);
    const notReg = existence.filter(r => !r.exists).map(r => r.jid.split("@")[0]);
    let withBio = [], noBio = [];
    const batchSize = 5; // user requested 5
    for (let i = 0; i < registered.length; i += batchSize) {
      const batch = registered.slice(i, i + batchSize);
      const promises = batch.map(async (num) => {
        const jid = num + "@s.whatsapp.net";
        try {
          const st = await waClient.fetchStatus(jid);
          let bio = null, setAt = null;
          if (Array.isArray(st) && st.length > 0) {
            const data = st[0];
            if (data) {
              if (typeof data.status === "string") bio = data.status;
              else if (data.status && typeof data.status === "object") bio = data.status.text || data.status.status;
              setAt = data.setAt || (data.status && data.status.setAt);
            }
          }
          if (bio && bio.trim() !== "") withBio.push({ nomor: num, bio, setAt });
          else noBio.push(num);
        } catch (e) {
          noBio.push(num);
        }
      });
      await Promise.allSettled(promises);
      await new Promise(r => setTimeout(r, 1000));
    }
    // build file and send
    let content = `HASIL CEK BIO\nTotal: ${numbers.length}\nWithBio: ${withBio.length}\nNoBio: ${noBio.length}\nNotReg: ${notReg.length}\n\n`;
    if (withBio.length) {
      content += "=== WITH BIO ===\n";
      withBio.forEach(i => { content += `${i.nomor} -> ${i.bio}\n`; });
    }
    content += "\n=== NO BIO ===\n" + (noBio.length ? noBio.join("\n") : "(Kosong)") + "\n";
    const outPath = path.join(DB, `hasil_cekbio_${ctx.from.id}.txt`);
    fs.writeFileSync(outPath, content, "utf8");
    await ctx.replyWithDocument({ source: outPath }, { caption: "Nih hasilnya." });
    fs.unlinkSync(outPath);
  } catch (err) {
    console.error("cekbio error:", err);
    ctx.reply("Gagal cek bio, coba lagi nanti.");
  }
});

// /cekbiotxt (reply file)
bot.command("cekbiotxt", async (ctx) => {
  if (!waClient || !waConnected) return ctx.reply("⚠️ WA client belum tersambung.");
  if (!ctx.message.reply_to_message || !ctx.message.reply_to_message.document) return ctx.reply("Reply file .txt yang berisi nomor.");
  try {
    const doc = ctx.message.reply_to_message.document;
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const resp = await axios.get(fileLink.href);
    const numbers = (resp.data.match(/\d+/g) || []);
    if (!numbers.length) return ctx.reply("File tidak mengandung nomor.");
    ctx.message.text = "/cekbio " + numbers.join(" ");
    return bot.handleUpdate(ctx.update);
  } catch (e) {
    console.error("cekbiotxt error:", e);
    return ctx.reply("Gagal proses file.");
  }
});

// /addemail command (interactive)
bot.command("addemail", async (ctx) => {
  pending[ctx.from.id] = { action: "addemail", step: 1, createdAt: Date.now() };
  return ctx.reply("📧 Kirim alamat Gmail (example@gmail.com). Setelah itu bot akan meminta App Password.", backKeyboard());
});

// /addsender owner quick add
bot.command("addsender", async (ctx) => {
  if (ctx.from.id !== config.owner.id) return ctx.reply("Hanya owner.");
  pending[ctx.from.id] = { action: "addsender", step: 1, createdAt: Date.now() };
  return ctx.reply("📧 Owner: Kirim email (example@gmail.com) untuk ditambahkan.", backKeyboard());
});

// /addprem owner usage
bot.command("addprem", async (ctx) => {
  if (ctx.from.id !== config.owner.id) return ctx.reply("Hanya owner.");
  const parts = ctx.message.text.split(" ").filter(Boolean);
  let target = null;
  if (ctx.message.reply_to_message) {
    target = ctx.message.reply_to_message.from;
  } else if (parts[1]) {
    const id = parts[1].replace(/\D/g, "");
    if (!id) return ctx.reply("Balas pesan user atau gunakan /addprem <id> <10d>");
    target = { id: parseInt(id) };
  } else {
    return ctx.reply("Balas pesan user atau gunakan /addprem <id> <10d>");
  }
  const durationStr = parts[2] || "30d";
  const days = durationStr.endsWith("d") ? parseInt(durationStr.slice(0,-1)) : parseInt(durationStr);
  if (!Number.isInteger(days) || days <= 0) return ctx.reply("Durasi tidak valid, contoh: 10d");
  const entry = addPremiumUser(PREMIUM_FILE, target.id, days);
  return ctx.reply(`✅ User ${target.username ? "@"+target.username : target.id} menjadi premium selama ${days} hari. Exp: ${entry.expires_str}`);
});

// /listprem
bot.command("listprem", async (ctx) => {
  if (ctx.from.id !== config.owner.id) {
    const is = isPremiumUser(PREMIUM_FILE, ctx.from.id);
    return ctx.reply(is ? "Kamu premium ✅" : "Kamu belum premium ❌");
  }
  const all = listPremium(PREMIUM_FILE);
  if (!all.length) return ctx.reply("Belum ada user premium.");
  const text = all.map(a => `${a.id} — ${a.expires_str}`).join("\n");
  return ctx.replyWithMarkdown(`*Daftar premium:*\n\n${text}`);
});

// /premium
bot.command("premium", async (ctx) => {
  const is = isPremiumUser(PREMIUM_FILE, ctx.from.id);
  if (is) return ctx.reply("💎 Kamu premium ✅");
  return ctx.reply("🚫 Kamu belum premium. Beli via pricelist / contact owner.");
});

// broadcast owner
bot.command("bcall", async (ctx) => {
  if (ctx.from.id !== config.owner.id) return ctx.reply("Hanya owner.");
  const text = ctx.message.text.split(" ").slice(1).join(" ");
  if (!text) return ctx.reply("Gunakan: /bcall pesan");
  const users = Object.keys(readJSONSafe(USERS_FILE) || {});
  let sent = 0;
  for (const u of users) {
    try {
      await bot.telegram.sendMessage(u, text);
      sent++;
      await new Promise(r => setTimeout(r, 200));
    } catch {}
  }
  return ctx.reply(`✅ Broadcast terkirim ke ${sent} user`);
});

bot.command("bcprem", async (ctx) => {
  if (ctx.from.id !== config.owner.id) return ctx.reply("Hanya owner.");
  const text = ctx.message.text.split(" ").slice(1).join(" ");
  if (!text) return ctx.reply("Gunakan: /bcprem pesan");
  const premiumList = listPremium(PREMIUM_FILE).map(p => p.id);
  let sent = 0;
  for (const pid of premiumList) {
    try {
      await bot.telegram.sendMessage(parseInt(pid), text);
      sent++;
      await new Promise(r => setTimeout(r, 200));
    } catch {}
  }
  return ctx.reply(`✅ Broadcast premium terkirim ke ${sent} user`);
});

// /pricelist command
bot.command("pricelist", (ctx) => {
  const text = config.priceList.map(p => p.days === 0 ? `Permanen — ${p.price}` : `${p.days} hari — ${p.price}`).join("\n");
  return ctx.replyWithMarkdown(`💎 *Pricelist:*\n\n${text}\n\nChat: ${config.owner.username}`);
});

// owner menu
bot.command("ownermenu", (ctx) => {
  if (ctx.from.id !== config.owner.id) return ctx.reply("Hanya owner.");
  return ctx.replyWithMarkdown(`👑 *Owner Menu*\n\n/addprem (reply) — Tambah premium\n/listprem — List premium\n/bcall <msg> — Broadcast all\n/bcprem <msg> — Broadcast premium\n/addsender — Add email sender (interactive)\n/removeaccount <email> — remove account\n/pairing — Pair WA client`);
});

// /removeaccount
bot.command("removeaccount", (ctx) => {
  if (ctx.from.id !== config.owner.id) return ctx.reply("Hanya owner.");
  const email = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!email) return ctx.reply("Gunakan: /removeaccount email@example.com");
  let accs = readJSONSafe(ACCOUNTS_FILE) || [];
  const newAccs = accs.filter(a => a.email !== email);
  writeJSONSafe(ACCOUNTS_FILE, newAccs);
  return ctx.reply(`✅ Jika ada, akun ${email} sudah dihapus.`);
});

// /listemail
bot.command("listemail", async (ctx) => {
  try {
    const accountsPath = ACCOUNTS_FILE;
    if (!fs.existsSync(accountsPath)) return ctx.reply("Belum ada email tersimpan.");
    const accs = JSON.parse(fs.readFileSync(accountsPath));
    if (accs.length === 0) return ctx.reply("Belum ada email tersimpan.");
    let text = "📋 *Daftar Email Tersimpan:*\n\n";
    accs.forEach((acc, i) => {
      text += `${i + 1}. ${acc.email}\n`;
    });
    await ctx.replyWithMarkdown(text);
  } catch (err) {
    console.error("Error listemail:", err);
    await ctx.reply("❌ Gagal menampilkan daftar email.");
  }
});

// === BACKUP: zip (exclude node_modules & package-lock.json), manual and auto hourly ===
async function createZipBackup() {
  return new Promise((resolve, reject) => {
    try {
      const outDir = path.join(__dirname, "backup");
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const filename = `backup_${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
      const outFile = path.join(outDir, filename);

      // zip command: exclude node_modules and package-lock.json
      // Use -x patterns (POSIX). If zip not available, fallback to tar.gz creation and return that path.
      const zipCmd = `zip -r "${outFile}" . -x "node_modules/*" "package-lock.json"`;
      child_process.exec(zipCmd, { cwd: __dirname, maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
        if (!err) {
          return resolve(outFile);
        }
        console.warn("zip failed, trying tar.gz fallback:", err && err.message);
        // fallback tar.gz
        try {
          const tgzName = `backup_${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`;
          const tgzPath = path.join(outDir, tgzName);
          // exclude patterns for tar
          const tarCmd = `tar --exclude='./node_modules' --exclude='./package-lock.json' -czf "${tgzPath}" .`;
          child_process.execSync(tarCmd, { cwd: __dirname, stdio: "ignore" });
          return resolve(tgzPath);
        } catch (e2) {
          return reject(e2);
        }
      });
    } catch (e) {
      return reject(e);
    }
  });
}

// manual /backup -> owner
bot.command("backup", async (ctx) => {
  if (ctx.from.id !== config.owner.id) return ctx.reply("Hanya owner.");
  await ctx.reply("⏳ Membuat backup (.zip) — mohon tunggu...");
  try {
    const file = await createZipBackup();
    // send to owner via Telegram
    try {
      await ctx.reply("📤 Mengirim backup ke owner...");
      await bot.telegram.sendDocument(config.owner.id, { source: file });
      await ctx.reply(`✅ Backup dibuat & dikirim: ${path.basename(file)}`);
      console.log(`📦 [BACKUP MANUAL] dibuat & dikirim: ${file}`);
      // remove local backup file after sending to save space
      try { fs.unlinkSync(file); } catch {}
    } catch (sendErr) {
      console.error("Gagal kirim backup ke owner:", sendErr);
      ctx.reply(`✅ Backup dibuat: ${file} (gagal kirim via Telegram)`);
    }
  } catch (err) {
    console.error("Backup gagal:", err);
    ctx.reply("❌ Backup gagal dibuat.");
  }
});

// auto-backup setiap 1 jam -> kirim ke owner
const AUTO_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 jam
setInterval(async () => {
  try {
    const file = await createZipBackup();
    console.log(`⏰ [AUTO-BACKUP] dibuat: ${file}`);
    try {
      await bot.telegram.sendDocument(config.owner.id, { source: file });
      console.log(`📤 [AUTO-BACKUP] dikirim ke owner: ${config.owner.id}`);
      try { fs.unlinkSync(file); } catch {}
    } catch (sendErr) {
      console.error("Gagal kirim auto-backup ke owner:", sendErr);
    }
  } catch (err) {
    console.error("Auto-backup gagal:", err);
  }
}, AUTO_BACKUP_INTERVAL_MS);

// message handler for pending flows and general messages
bot.on("message", async (ctx) => {
  try {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    // auto register user in users.json
    const usersPath = USERS_FILE;
    let users = [];
    if (fs.existsSync(usersPath)) users = JSON.parse(fs.readFileSync(usersPath));
    else fs.writeFileSync(usersPath, "[]");
    if (!users.includes(userId)) {
      users.push(userId);
      fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
    }

    const state = pending[userId];
    const text = ctx.message.text ? ctx.message.text.trim() : null;

    // If user clicked back button (startback) we already handled.
    if (!state) return;

    // Allow /cancel text
    if (text && text.toLowerCase() === "/cancel") {
      delete pending[userId];
      return ctx.reply("✅ Aksi dibatalkan.", mainKeyboard());
    }

    // ceknomor flow
    if (state.action === "ceknomor") {
      if (!text) return ctx.reply("Kirim nomor text saja.", backKeyboard());
      if (!text.startsWith("+") || text.length < 6) return ctx.reply("Format nomor tidak valid. Contoh: +628123456789", backKeyboard());
      delete pending[userId];
      return ctx.reply(`✅ Nomor valid: ${text}`, mainKeyboard());
    }

    // addemail flow (interactive)
    if (state.action === "addemail") {
      if (state.step === 1) {
        // got email address
        const email = text;
        if (!email || !email.includes("@")) return ctx.reply("Format email tidak valid. Contoh: example@gmail.com", backKeyboard());
        state.data = { email };
        state.step = 2;
        return ctx.reply("🔑 Sekarang kirim App Password (atau password) untuk email tersebut.", backKeyboard());
      } else if (state.step === 2) {
        const pass = text;
        const existing = readJSONSafe(ACCOUNTS_FILE) || [];
        existing.push({ email: state.data.email, password: pass });
        writeJSONSafe(ACCOUNTS_FILE, existing);
        delete pending[userId];
        accounts = existing;
        return ctx.reply("✅ Email berhasil ditambahkan!", mainKeyboard());
      }
    }

    // addsender owner
    if (state.action === "addsender") {
      if (ctx.from.id !== config.owner.id) { delete pending[userId]; return ctx.reply("Hanya owner.", mainKeyboard()); }
      if (state.step === 1) {
        const email = text;
        if (!email || !email.includes("@")) return ctx.reply("Format email tidak valid.");
        state.data = { email }; state.step = 2;
        return ctx.reply("🔑 Sekarang kirim App Password (owner).");
      } else if (state.step === 2) {
        const pass = text;
        const existing = readJSONSafe(ACCOUNTS_FILE) || [];
        existing.push({ email: state.data.email, password: pass });
        writeJSONSafe(ACCOUNTS_FILE, existing);
        delete pending[userId];
        accounts = existing;
        return ctx.reply("✅ Email owner berhasil ditambahkan!", mainKeyboard());
      }
    }

    // fixmerah flow: user must send +number only — then send email automatically
    if (state.action === "fixmerah") {
      if (!text) return ctx.reply("Kirim nomor text saja (contoh: +628123456789).", backKeyboard());
      const num = text.trim();
      if (!num.startsWith("+") || num.length < 6) return ctx.reply("Format nomor tidak valid. Contoh: +628123456789", backKeyboard());

      // cooldown check (only for fixmerah)
      if (!canDoAction(String(userId))) {
        const wait = config.limits.globalCooldownSeconds || 10;
        return ctx.reply(`⏳ Tunggu ${wait} detik sebelum mengirim banding lagi.`, backKeyboard());
      }

      // mark stats
      const usersStats = readJSONSafe(STATS_FILE) || {};
      const today = new Date().toISOString().slice(0,10);
      usersStats[today] = usersStats[today] || {};
      usersStats[today][userId] = (usersStats[today][userId] || 0) + 1;
      writeJSONSafe(STATS_FILE, usersStats);

      // pick account
      const acc = pickRandomAccount();
      if (!acc) {
        delete pending[userId];
        return ctx.reply("❌ Tidak ada akun email tersimpan untuk mengirim. Tambah dulu via /addsender atau gunakan /addemail.", mainKeyboard());
      }

      // choose random template among 3
      const tpl = EMAIL_TEMPLATES[Math.floor(Math.random() * EMAIL_TEMPLATES.length)];
      const subject = tpl.subject;
      const body = tpl.build(num);

      // send email
      const transporter = createTransporter(acc.email, acc.password);
      const mailOptions = {
        from: acc.email,
        to: config.whatsappSupportEmail || acc.email,
        subject,
        text: body
      };

      try {
        await transporter.sendMail(mailOptions);

        // mark cooldown
        markAction(String(userId));

        // console log details
        console.log("📨 [EMAIL SENT]");
        console.log(`├ Time     : ${new Date().toISOString()}`);
        console.log(`├ Dari     : ${acc.email}`);
        console.log(`├ Bahasa   : ${tpl.id.toUpperCase()}`);
        console.log(`├ User ID  : ${ctx.from.id} (${ctx.from.username || "-"})`);
        console.log(`└ Nomor    : ${num}`);

        delete pending[userId];
        return ctx.replyWithMarkdown(`✅ Sukses! Kami mengirim banding untuk nomor \`${num}\`.\nDikirim via: \`${acc.email}\`\nSubject: _${subject}_`, mainKeyboard());
      } catch (e) {
        console.error("sendMail error:", e);
        delete pending[userId];
        return ctx.reply(`❌ Gagal mengirim email (akun ${acc.email}). Error: ${e.message || e}`, mainKeyboard());
      }
    }

    // default: if unknown action
    return;
  } catch (err) {
    console.error("Terjadi error di handler pesan:", err);
    try { await ctx.reply("❌ Terjadi kesalahan internal, coba lagi nanti."); } catch {}
  }
});

// graceful start & launch
(async () => {
  try {
    await bot.launch();
    console.log(`🚀 ${config.botName} aktif. Owner: ${config.owner.id}`);
    console.log(`ℹ️ Runtime logging aktif — started at ${new Date().toISOString()}`);
  } catch (e) {
    console.error("Gagal launch bot:", e);
    process.exit(1);
  }
})();

// graceful shutdown logs
process.once("SIGINT", () => {
  console.log("🛑 SIGINT diterima, menghentikan bot...");
  bot.stop("SIGINT");
  console.log("✅ Bot berhenti (SIGINT).");
});
process.once("SIGTERM", () => {
  console.log("🛑 SIGTERM diterima, menghentikan bot...");
  bot.stop("SIGTERM");
  console.log("✅ Bot berhenti (SIGTERM).");
});