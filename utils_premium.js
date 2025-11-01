// utils_premium.js
import fs from "fs";

export function ensurePremiumFile(p) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({}, null, 2));
}

export function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

export function saveJSON(p, d) {
  fs.writeFileSync(p, JSON.stringify(d, null, 2));
}

export function isPremiumUser(premiumFile, userId) {
  try {
    const d = JSON.parse(fs.readFileSync(premiumFile, "utf8"));
    const entry = d[String(userId)];
    if (!entry) return false;
    const now = Date.now();
    return entry.expires > now;
  } catch (e) { return false; }
}

export function addPremiumUser(premiumFile, userId, days) {
  const d = JSON.parse(fs.readFileSync(premiumFile, "utf8") || "{}");
  const now = Date.now();
  const expires = now + (days * 24 * 60 * 60 * 1000);
  d[String(userId)] = { id: userId, expires, expires_str: new Date(expires).toISOString() };
  fs.writeFileSync(premiumFile, JSON.stringify(d, null, 2));
  return d[String(userId)];
}

export function listPremium(premiumFile) {
  try {
    const d = JSON.parse(fs.readFileSync(premiumFile, "utf8") || "{}");
    return Object.values(d).filter(x => x && x.expires && x.expires > Date.now());
  } catch (e) { return []; }
}