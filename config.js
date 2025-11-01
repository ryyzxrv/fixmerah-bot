// config.js
export const config = {
  botToken: "8211066098:AAF1jNINOWGeF7QQBpQhalZW1tzZLJvdqS0",
  botName: "FDora Bot",
  version: "2.0.1",

  owner: {
    id: 7562165596,
    username: "@audrienovzx",
    name: "AudrienZ"
  },

  whatsappSupportEmail: "support@support.whatsapp.com",

  ui: {
    startPhoto: "https://files.catbox.moe/rbgp4o.jpg",
    startAudio: "https://ar-hosting.pages.dev/1761965613558.mp3"
  },

  limits: {
    freeLimitPerDay: 3,
    globalCooldownSeconds: 10
  },

  priceList: [
    { days: 7, price: "7K" },
    { days: 30, price: "20K" },
    { days: 0, price: "45K (Permanen)" }
  ],

  databaseFolder: "./database",

  baileys: {
    sessionName: "./wa-session"
  },

  // 🆕 Tambahkan ini 👇
  joinRequirement: {
    type: "channel", // "channel" atau "group"
    username: "@rayzz_ry", // ubah sesuai username publik
    link: "https://t.me/rayzz_ry" // link buat tombol join
  }
};