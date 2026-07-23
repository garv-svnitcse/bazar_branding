/**
 * BAZAAR BRANDING — BACKEND API
 * ------------------------------------------------------------
 * A single-file Express backend that replaces the artifact's
 * built-in window.storage calls with a real server + database,
 * so referral codes, feedback, and diagnosis leads are stored
 * durably and can be managed from outside the browser.
 *
 * STORAGE: lowdb (a JSON file on disk: data/db.json). No native
 * build tools required, so it runs anywhere Node runs (Render,
 * Railway, Fly.io, a VPS, etc.). Swap it for Postgres/Supabase
 * later without changing the route logic much — see the DB
 * section below.
 *
 * ------------------------------------------------------------
 * SETUP
 * ------------------------------------------------------------
 *  1. mkdir bazaar-branding-backend && cd bazaar-branding-backend
 *  2. Save this file as server.js
 *  3. npm init -y
 *  4. npm install express cors dotenv lowdb nanoid express-rate-limit helmet morgan
 *  5. Create a .env file (see .env.example content at the bottom
 *     of this file, in the comment block) with at least:
 *       PORT=4000
 *       ADMIN_KEY=choose-a-long-random-string
 *       ALLOWED_ORIGIN=https://your-frontend-domain.com
 *  6. node server.js
 *  7. Confirm it's alive: curl http://localhost:4000/api/health
 *
 * DEPLOYMENT (quick options):
 *  - Render.com: New Web Service -> connect the GitHub repo ->
 *    build command "npm install", start command "node server.js".
 *    Add PORT, ADMIN_KEY, ALLOWED_ORIGIN as environment variables
 *    in the Render dashboard. Render sets PORT itself, so this
 *    code reads process.env.PORT with a fallback.
 *  - Railway.app: similar — "Deploy from GitHub repo", set the
 *    same environment variables in the Railway dashboard.
 *  - NOTE: lowdb writes to a local JSON file. On most serverless/
 *    ephemeral hosts (e.g. Vercel serverless functions) that file
 *    will NOT persist between deploys/restarts. Render/Railway/Fly
 *    with a persistent disk (or a small VPS) is the right target
 *    for this file-based version. If you want proper persistence
 *    on Vercel, swap lowdb for Supabase/Postgres — flagged below.
 * ------------------------------------------------------------
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { nanoid } = require("nanoid");
const { Low } = require("lowdb");
const { JSONFile } = require("lowdb/node");

// ------------------------------------------------------------
// DATABASE SETUP (lowdb / JSON file)
// ------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const DB_FILE = path.join(DATA_DIR, "db.json");
const adapter = new JSONFile(DB_FILE);
const defaultData = {
  referrals: [],   // { code, name, cafe, createdAt, redemptions }
  redemptions: [], // { code, appliedAt } - one row per time a code was applied, for basic fraud visibility
  feedback: [],    // { id, name, cafe, rating, message, createdAt }
  leads: [],       // { id, phone, footfall, bill, reviews, estimatedLeak, createdAt }
};
const db = new Low(adapter, defaultData);

async function initDb() {
  await db.read();
  db.data ||= defaultData;
  await db.write();
}

// ------------------------------------------------------------
// WORKSHOP CODES (server-side now — not visible in browser source)
// ------------------------------------------------------------
// This was previously a hardcoded array in the frontend <script>,
// which meant anyone could view-source the page and find valid
// codes. Moving it here means the codes never ship to the client.
const WORKSHOP_CODES = new Set(["SGCCI10", "HRAWI10", "WORKSHOP10"]);
// Add new workshop codes here, e.g. WORKSHOP_CODES.add("NEWCODE10");

// ------------------------------------------------------------
// APP SETUP
// ------------------------------------------------------------
const app = express();
app.use(helmet());
app.use(morgan("combined"));
app.use(express.json({ limit: "50kb" }));

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
app.use(
  cors({
    origin: allowedOrigin === "*" ? true : allowedOrigin.split(",").map((s) => s.trim()),
  })
);

// Basic abuse protection on write endpoints
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,                  // 30 writes per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function isValidPhone(phone) {
  return typeof phone === "string" && /^[0-9+ ]{8,15}$/.test(phone.trim());
}

// ------------------------------------------------------------
// HEALTH CHECK
// ------------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "bazaar-branding-backend", time: new Date().toISOString() });
});

// ------------------------------------------------------------
// REFERRALS
// ------------------------------------------------------------

// Create a new referral code for a café owner
app.post("/api/referrals", writeLimiter, async (req, res) => {
  const { name, cafe } = req.body || {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "A name is required to generate a referral code." });
  }

  await db.read();
  const base = name.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 4) || "BAZR";
  let code;
  do {
    code = base + Math.floor(100 + Math.random() * 900);
  } while (db.data.referrals.some((r) => r.code === code));

  const record = {
    code,
    name: name.trim(),
    cafe: (cafe || "").trim(),
    createdAt: Date.now(),
    redemptions: 0,
  };
  db.data.referrals.push(record);
  await db.write();

  res.status(201).json({ code: record.code, name: record.name, cafe: record.cafe, redemptions: 0 });
});

// Look up a referral code's stats (used by the frontend to show "X referrals redeemed")
app.get("/api/referrals/:code", async (req, res) => {
  const code = (req.params.code || "").toUpperCase();
  await db.read();
  const rec = db.data.referrals.find((r) => r.code === code);
  if (!rec) return res.status(404).json({ error: "Referral code not found." });
  res.json({ code: rec.code, name: rec.name, cafe: rec.cafe, redemptions: rec.redemptions });
});

// ------------------------------------------------------------
// DISCOUNT CODE APPLICATION (workshop or referral)
// ------------------------------------------------------------
// Frontend calls this once with whatever the user typed. The
// server decides if it's a workshop code, a referral code, or
// invalid — this is the logic that used to live client-side.
app.post("/api/codes/apply", writeLimiter, async (req, res) => {
  const raw = (req.body && req.body.code) || "";
  const code = String(raw).trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Enter a code first." });

  if (WORKSHOP_CODES.has(code)) {
    return res.json({
      valid: true,
      type: "workshop",
      discount: 10,
      label: code,
      message: "Workshop discount applied — 10% off, thanks for coming.",
    });
  }

  await db.read();
  const rec = db.data.referrals.find((r) => r.code === code);
  if (rec) {
    rec.redemptions += 1;
    db.data.redemptions.push({ code, appliedAt: Date.now() });
    await db.write();
    return res.json({
      valid: true,
      type: "referral",
      discount: 10,
      label: code,
      redemptions: rec.redemptions,
      message: "Referral code applied — 10% off your first month.",
    });
  }

  res.status(404).json({
    valid: false,
    message: "That code doesn't match a workshop or referral code we recognise.",
  });
});

// ------------------------------------------------------------
// FEEDBACK
// ------------------------------------------------------------
app.post("/api/feedback", writeLimiter, async (req, res) => {
  const { name, cafe, rating, message } = req.body || {};
  const ratingNum = Number(rating);

  if (!name || !message || !ratingNum || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: "Please provide a name, a 1–5 rating, and a message." });
  }

  const entry = {
    id: nanoid(10),
    name: String(name).trim().slice(0, 80),
    cafe: String(cafe || "").trim().slice(0, 80),
    rating: ratingNum,
    message: String(message).trim().slice(0, 1000),
    createdAt: Date.now(),
  };

  await db.read();
  db.data.feedback.push(entry);
  await db.write();

  res.status(201).json(entry);
});

// Public: latest feedback, newest first, capped at 12 (mirrors old frontend behavior)
app.get("/api/feedback", async (req, res) => {
  await db.read();
  const items = [...db.data.feedback].sort((a, b) => b.createdAt - a.createdAt).slice(0, 12);
  res.json(items);
});

// ------------------------------------------------------------
// DIAGNOSIS LEADS (the "instant diagnosis" WhatsApp capture)
// ------------------------------------------------------------
app.post("/api/leads", writeLimiter, async (req, res) => {
  const { phone, footfall, bill, reviews, estimatedLeak } = req.body || {};
  if (!isValidPhone(phone)) {
    return res.status(400).json({ error: "Enter a valid WhatsApp number." });
  }

  const entry = {
    id: nanoid(10),
    phone: String(phone).trim(),
    footfall: footfall || null,
    bill: bill || null,
    reviews: reviews || null,
    estimatedLeak: estimatedLeak || null,
    createdAt: Date.now(),
  };

  await db.read();
  db.data.leads.push(entry);
  await db.write();

  res.status(201).json({ ok: true });
});

// ------------------------------------------------------------
// ADMIN — simple protected views (header: x-admin-key: <ADMIN_KEY>)
// ------------------------------------------------------------
app.get("/api/admin/leads", requireAdmin, async (req, res) => {
  await db.read();
  res.json([...db.data.leads].sort((a, b) => b.createdAt - a.createdAt));
});

app.get("/api/admin/referrals", requireAdmin, async (req, res) => {
  await db.read();
  res.json([...db.data.referrals].sort((a, b) => b.createdAt - a.createdAt));
});

app.get("/api/admin/feedback", requireAdmin, async (req, res) => {
  await db.read();
  res.json([...db.data.feedback].sort((a, b) => b.createdAt - a.createdAt));
});

// ------------------------------------------------------------
// START
// ------------------------------------------------------------
const PORT = process.env.PORT || 4000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Bazaar Branding backend listening on port ${PORT}`);
  });
});

/**
 * ------------------------------------------------------------
 * package.json (create this alongside server.js)
 * ------------------------------------------------------------
 * {
 *   "name": "bazaar-branding-backend",
 *   "version": "1.0.0",
 *   "description": "Backend API for the Bazaar Branding café growth landing page",
 *   "main": "server.js",
 *   "scripts": {
 *     "start": "node server.js",
 *     "dev": "node --watch server.js"
 *   },
 *   "dependencies": {
 *     "cors": "^2.8.5",
 *     "dotenv": "^16.4.5",
 *     "express": "^4.19.2",
 *     "express-rate-limit": "^7.2.0",
 *     "helmet": "^7.1.0",
 *     "lowdb": "^7.0.1",
 *     "morgan": "^1.10.0",
 *     "nanoid": "^3.3.7"
 *   }
 * }
 *
 * NOTE: use nanoid@^3 (not v4+) since v4 is ESM-only and this
 * file uses CommonJS require(). If you convert this project to
 * ESM ("type": "module" in package.json + import syntax), any
 * nanoid version works.
 *
 * ------------------------------------------------------------
 * .env.example
 * ------------------------------------------------------------
 * PORT=4000
 * ADMIN_KEY=replace-with-a-long-random-string
 * ALLOWED_ORIGIN=https://your-frontend-domain.com
 *
 * ------------------------------------------------------------
 * .gitignore
 * ------------------------------------------------------------
 * node_modules/
 * data/
 * .env
 * ------------------------------------------------------------
 */
