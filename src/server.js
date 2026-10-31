require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { query, pool, migrate, close } = require("./db");
const { tokenize, haversine, scoreItems, scoreQuery } = require("./services/matching");
const { perceptualHash, visualScore } = require("./services/vision");
const { searchSocial } = require("./services/social");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
if (isProduction && !process.env.JWT_SECRET) throw new Error("JWT_SECRET is required in production.");
const JWT_SECRET = process.env.JWT_SECRET || "local-development-secret-change-me";
const uploadDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use("/uploads", express.static(uploadDir, { maxAge: isProduction ? "7d" : 0 }));
app.use(express.static(path.join(__dirname, "..", "public")));

const imageFilter = (req, file, done) => {
  if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) return done(null, true);
  return done(new Error("Only JPEG, PNG, and WebP images are accepted."));
};
const storage = multer.diskStorage({
  destination: (req, file, done) => done(null, uploadDir),
  filename: (req, file, done) => done(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({ storage, fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024, files: 5 } });
const memoryUpload = multer({ storage: multer.memoryStorage(), fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } });

const CATEGORIES = ["Accessories", "Bags", "Books", "Cards & IDs", "Clothing", "Documents", "Electronics", "Jewelry", "Keys", "Sports", "Other"];
const itemColumns = `
  i.*, u.name AS reporter_name,
  COALESCE(json_agg(json_build_object('id', im.id, 'url', im.storage_path, 'altText', im.alt_text, 'visualHash', im.visual_hash) ORDER BY im.created_at)
    FILTER (WHERE im.id IS NOT NULL), '[]'::json) AS images`;
const itemJoins = ` FROM items i JOIN users u ON u.id = i.user_id LEFT JOIN item_images im ON im.item_id = i.id`;
const itemGroup = ` GROUP BY i.id, u.id`;

function cleanString(value, max = 200) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}
function parseKeywords(value) {
  return [...new Set(String(value || "").split(/[,\n]/).map((word) => cleanString(word, 40).toLowerCase()).filter(Boolean))].slice(0, 20);
}
function numberOrNull(value, min, max) {
  if (value === "" || value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}
function itemForClient(row, viewerId) {
  if (!row) return null;
  const item = { ...row, images: row.images || [] };
  item.primaryImage = item.images[0]?.url || null;
  item.visual_hash = item.images[0]?.visualHash || null;
  delete item.password_hash;
  if (item.user_id !== viewerId) delete item.whatsapp;
  return item;
}
function signUser(user) {
  return jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
}
function setSession(res, user) {
  res.cookie("session", signUser(user), { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: 7 * 24 * 60 * 60 * 1000, path: "/" });
}
function maybeUser(req, res, next) {
  const token = req.cookies.session || req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch { /* anonymous */ }
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in to continue." });
  next();
}
async function notify(userId, kind, title, body, link = null) {
  await query("INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5)", [userId, kind, title, body, link]);
}
async function getItem(id, viewerId) {
  const { rows } = await query(`SELECT ${itemColumns}${itemJoins} WHERE i.id = $1${itemGroup}`, [id]);
  return itemForClient(rows[0], viewerId);
}
async function fetchAllItems(where = "", params = []) {
  const { rows } = await query(`SELECT ${itemColumns}${itemJoins} ${where}${itemGroup}`, params);
  return rows.map((row) => itemForClient(row));
}
async function findMatches(item) {
  const opposite = item.report_type === "lost" ? "found" : "lost";
  const candidates = await fetchAllItems("WHERE i.report_type = $1 AND i.status IN ('open', 'matched') AND i.id <> $2", [opposite, item.id]);
  return candidates.map((candidate) => ({ ...itemForClient(candidate), match: scoreItems(item, candidate) })).filter((candidate) => candidate.match.score >= 25).sort((a, b) => b.match.score - a.match.score).slice(0, 12);
}

app.use(maybeUser);
app.get("/api/health", async (req, res, next) => {
  try { await query("SELECT 1"); res.json({ ok: true, database: "neon-postgresql" }); } catch (error) { next(error); }
});
app.get("/api/categories", (req, res) => res.json({ categories: CATEGORIES }));

app.post("/api/auth/signup", async (req, res, next) => {
  try {
    const name = cleanString(req.body.name, 80);
    const email = cleanString(req.body.email, 255).toLowerCase();
    const password = String(req.body.password || "");
    if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return res.status(400).json({ error: "Enter a name, valid email, and password of at least 8 characters." });
    const passwordHash = await bcrypt.hash(password, 12);
    const { rows } = await query("INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id,name,email,avatar_url", [name, email, passwordHash]);
    setSession(res, rows[0]);
    res.status(201).json({ user: rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That email is already registered." });
    next(error);
  }
});
app.post("/api/auth/login", async (req, res, next) => {
  try {
    const email = cleanString(req.body.email, 255).toLowerCase();
    const password = String(req.body.password || "");
    const { rows } = await query("SELECT id,name,email,avatar_url,password_hash FROM users WHERE email = $1", [email]);
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) return res.status(401).json({ error: "Incorrect email or password." });
    const user = rows[0]; delete user.password_hash;
    setSession(res, user);
    res.json({ user });
  } catch (error) { next(error); }
});
app.post("/api/auth/logout", (req, res) => { res.clearCookie("session", { path: "/" }); res.json({ ok: true }); });
app.get("/api/me", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query("SELECT id,name,email,avatar_url,created_at FROM users WHERE id=$1", [req.user.id]);
    res.json({ user: rows[0] });
  } catch (error) { next(error); }
});
app.put("/api/me", requireAuth, async (req, res, next) => {
  try {
    const name = cleanString(req.body.name, 80);
    const email = cleanString(req.body.email, 255).toLowerCase();
    if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a name and valid email address." });
    const { rows } = await query("UPDATE users SET name=$1, email=$2, updated_at=now() WHERE id=$3 RETURNING id,name,email,avatar_url", [name, email, req.user.id]);
    setSession(res, rows[0]); res.json({ user: rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That email is already registered." });
    next(error);
  }
});

app.get("/api/items", async (req, res, next) => {
  try {
    const conditions = []; const params = [];
    const add = (sql, value) => { params.push(value); conditions.push(sql.replace("?", `$${params.length}`)); };
    if (["lost", "found"].includes(req.query.type)) add("i.report_type = ?", req.query.type);
    if (req.query.category && CATEGORIES.includes(req.query.category)) add("i.category = ?", req.query.category);
    if (req.query.status && ["open", "matched", "claimed", "returned", "closed"].includes(req.query.status)) add("i.status = ?", req.query.status);
    const q = cleanString(req.query.q, 160);
    if (q) add("lower(concat_ws(' ', i.title, i.description, i.category, i.color, i.location_name, array_to_string(i.keywords, ' '))) LIKE ?", `%${q.toLowerCase()}%`);
    const latitude = numberOrNull(req.query.latitude, -90, 90);
    const longitude = numberOrNull(req.query.longitude, -180, 180);
    const radius = numberOrNull(req.query.radiusKm, 0.1, 500);
    if (latitude !== null && longitude !== null && radius !== null) {
      params.push(latitude, longitude, radius);
      const [lat, lng, km] = [params.length - 2, params.length - 1, params.length];
      conditions.push(`i.latitude IS NOT NULL AND i.longitude IS NOT NULL AND 6371 * acos(LEAST(1, GREATEST(-1, cos(radians($${lat})) * cos(radians(i.latitude)) * cos(radians(i.longitude) - radians($${lng})) + sin(radians($${lat})) * sin(radians(i.latitude))))) <= $${km}`);
    }
    params.push(Math.min(Math.max(Number(req.query.limit) || 30, 1), 100));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await query(`SELECT ${itemColumns}${itemJoins} ${where}${itemGroup} ORDER BY i.created_at DESC LIMIT $${params.length}`, params);
    res.json({ items: rows.map((row) => itemForClient(row, req.user?.id)) });
  } catch (error) { next(error); }
});

app.post("/api/items", requireAuth, upload.array("images", 5), async (req, res, next) => {
  const uploaded = req.files || [];
  try {
    const reportType = cleanString(req.body.reportType, 5).toLowerCase();
    const title = cleanString(req.body.title, 140), category = cleanString(req.body.category, 80), locationName = cleanString(req.body.locationName, 180);
    const description = cleanString(req.body.description, 3000), color = cleanString(req.body.color, 80) || null;
    const latitude = numberOrNull(req.body.latitude, -90, 90), longitude = numberOrNull(req.body.longitude, -180, 180);
    const occurredAt = req.body.occurredAt ? new Date(req.body.occurredAt) : null;
    if (!["lost", "found"].includes(reportType) || !title || !CATEGORIES.includes(category) || !locationName) return res.status(400).json({ error: "Report type, title, category, and location are required." });
    if (req.body.occurredAt && Number.isNaN(occurredAt.getTime())) return res.status(400).json({ error: "Enter a valid date and time." });
    if ((latitude === null) !== (longitude === null)) return res.status(400).json({ error: "Provide both latitude and longitude, or neither." });
    const client = await pool.connect(); let item;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`INSERT INTO items (user_id,report_type,title,description,category,color,keywords,location_name,latitude,longitude,occurred_at,whatsapp)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [req.user.id, reportType, title, description, category, color, parseKeywords(req.body.keywords), locationName, latitude, longitude, occurredAt, cleanString(req.body.whatsapp, 30) || null]);
      item = rows[0];
      for (const file of uploaded) {
        const visualHash = await perceptualHash(file.path);
        await client.query("INSERT INTO item_images (item_id,storage_path,alt_text,visual_hash) VALUES ($1,$2,$3,$4)", [item.id, `/uploads/${file.filename}`, cleanString(req.body.imageAlt || title, 180), visualHash]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    const saved = await getItem(item.id, req.user.id);
    const matches = await findMatches(saved);
    if (matches[0]?.match.score >= 60) {
      await query("UPDATE items SET status='matched', updated_at=now() WHERE id=$1", [item.id]);
      await notify(req.user.id, "match", "Possible match found", `${matches[0].title} scored ${matches[0].match.score}% against your new report.`, `/items/${matches[0].id}`);
    }
    res.status(201).json({ item: await getItem(item.id, req.user.id), matches: matches.slice(0, 3) });
  } catch (error) {
    for (const file of uploaded) fs.unlink(file.path, () => {});
    next(error);
  }
});

app.get("/api/items/:id", async (req, res, next) => {
  try { const item = await getItem(req.params.id, req.user?.id); if (!item) return res.status(404).json({ error: "Item not found." }); res.json({ item }); } catch (error) { next(error); }
});
app.patch("/api/items/:id/status", requireAuth, async (req, res, next) => {
  try {
    const status = cleanString(req.body.status, 12);
    if (!["open", "matched", "claimed", "returned", "closed"].includes(status)) return res.status(400).json({ error: "Invalid status." });
    const { rows } = await query("UPDATE items SET status=$1,updated_at=now() WHERE id=$2 AND user_id=$3 RETURNING id", [status, req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: "Report not found or you do not own it." });
    res.json({ item: await getItem(req.params.id, req.user.id) });
  } catch (error) { next(error); }
});
app.delete("/api/items/:id", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query("DELETE FROM items WHERE id=$1 AND user_id=$2 RETURNING id", [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: "Report not found or you do not own it." });
    res.status(204).end();
  } catch (error) { next(error); }
});
app.get("/api/items/:id/matches", async (req, res, next) => {
  try { const item = await getItem(req.params.id, req.user?.id); if (!item) return res.status(404).json({ error: "Item not found." }); res.json({ matches: await findMatches(item) }); } catch (error) { next(error); }
});

app.post("/api/visual-search", requireAuth, memoryUpload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Upload an image to search." });
    const queryHash = await perceptualHash(req.file.buffer);
    const category = cleanString(req.body.category, 80);
    let candidates = await fetchAllItems(category && CATEGORIES.includes(category) ? "WHERE i.category = $1" : "", category && CATEGORIES.includes(category) ? [category] : []);
    const results = candidates.map((item) => ({ ...item, visualScore: visualScore(queryHash, item.visual_hash) })).filter((item) => item.visualScore !== null).sort((a, b) => b.visualScore - a.visualScore).slice(0, 20);
    res.json({ queryHash, results, method: "private perceptual image similarity" });
  } catch (error) { next(error); }
});

app.post("/api/assistant", requireAuth, async (req, res, next) => {
  try {
    const question = cleanString(req.body.question, 500);
    if (question.length < 3) return res.status(400).json({ error: "Ask a little more about the item you need help finding." });
    const words = tokenize(question);
    const candidates = await fetchAllItems("WHERE i.status IN ('open','matched')");
    const matches = candidates.map((item) => ({ ...item, match: scoreQuery(question, item) })).filter((item) => item.match.score >= 18).sort((a, b) => b.match.score - a.match.score).slice(0, 6);
    const inferredType = /found|find|seen/.test(question.toLowerCase()) ? "found" : "lost";
    const answer = matches.length ? `I searched ${candidates.length} active reports for “${words.join(", ")}”. These are the ${matches.length} closest ${inferredType === "lost" ? "reports" : "results"}; compare their location, description, and images before contacting the poster.` : "I could not find a strong match yet. Try adding the item type, color, a landmark, and any distinctive marks, or post a report so the platform can notify you about future matches.";
    res.json({ answer, extractedKeywords: words, matches });
  } catch (error) { next(error); }
});

app.post("/api/conversations", requireAuth, async (req, res, next) => {
  try {
    const item = await getItem(req.body.itemId, req.user.id);
    if (!item) return res.status(404).json({ error: "Item not found." });
    if (item.user_id === req.user.id) return res.status(400).json({ error: "You cannot message yourself about this report." });
    const { rows } = await query(`INSERT INTO conversations (item_id,requester_id,owner_id) VALUES ($1,$2,$3)
      ON CONFLICT (item_id,requester_id) DO UPDATE SET item_id=EXCLUDED.item_id RETURNING id,item_id,requester_id,owner_id,created_at`, [item.id, req.user.id, item.user_id]);
    const conversation = rows[0];
    await notify(item.user_id, "message", "New inquiry", `${req.user.name} started a conversation about ${item.title}.`, `/messages/${conversation.id}`);
    res.status(201).json({ conversation });
  } catch (error) { next(error); }
});
app.get("/api/conversations", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT c.*, i.title AS item_title, i.report_type, (SELECT storage_path FROM item_images WHERE item_id=i.id ORDER BY created_at LIMIT 1) AS item_image,
      CASE WHEN c.owner_id=$1 THEN requester.name ELSE owner.name END AS counterpart_name,
      (SELECT body FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
      FROM conversations c JOIN items i ON i.id=c.item_id JOIN users owner ON owner.id=c.owner_id JOIN users requester ON requester.id=c.requester_id
      WHERE c.owner_id=$1 OR c.requester_id=$1 ORDER BY COALESCE((SELECT created_at FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1),c.created_at) DESC`, [req.user.id]);
    res.json({ conversations: rows });
  } catch (error) { next(error); }
});
app.get("/api/conversations/:id/messages", requireAuth, async (req, res, next) => {
  try {
    const { rows: allowed } = await query("SELECT id FROM conversations WHERE id=$1 AND (owner_id=$2 OR requester_id=$2)", [req.params.id, req.user.id]);
    if (!allowed[0]) return res.status(404).json({ error: "Conversation not found." });
    const { rows } = await query(`SELECT m.*, u.name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=$1 ORDER BY m.created_at`, [req.params.id]);
    res.json({ messages: rows });
  } catch (error) { next(error); }
});
app.post("/api/conversations/:id/messages", requireAuth, async (req, res, next) => {
  try {
    const body = cleanString(req.body.body, 2000);
    if (!body) return res.status(400).json({ error: "Message cannot be empty." });
    const { rows: conversations } = await query("SELECT * FROM conversations WHERE id=$1 AND (owner_id=$2 OR requester_id=$2)", [req.params.id, req.user.id]);
    const conversation = conversations[0]; if (!conversation) return res.status(404).json({ error: "Conversation not found." });
    const { rows } = await query("INSERT INTO messages (conversation_id,sender_id,body) VALUES ($1,$2,$3) RETURNING *", [conversation.id, req.user.id, body]);
    const recipient = conversation.owner_id === req.user.id ? conversation.requester_id : conversation.owner_id;
    await notify(recipient, "message", "New message", `${req.user.name}: ${body.slice(0, 120)}`, `/messages/${conversation.id}`);
    res.status(201).json({ message: { ...rows[0], sender_name: req.user.name } });
  } catch (error) { next(error); }
});

app.get("/api/notifications", requireAuth, async (req, res, next) => {
  try { const { rows } = await query("SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30", [req.user.id]); res.json({ notifications: rows }); } catch (error) { next(error); }
});
app.patch("/api/notifications/read", requireAuth, async (req, res, next) => {
  try { await query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [req.user.id]); res.json({ ok: true }); } catch (error) { next(error); }
});

app.post("/api/social/search", requireAuth, async (req, res, next) => {
  try {
    const search = cleanString(req.body.query, 300);
    if (!search) return res.status(400).json({ error: "Enter terms to search Meta-connected sources." });
    const result = await searchSocial(search);
    if (result.configured) await query("INSERT INTO social_search_cache (source,query,payload) VALUES ('meta',$1,$2)", [search, JSON.stringify(result.results)]);
    res.json(result);
  } catch (error) { next(error); }
});
app.get("/api/stats", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE report_type='lost')::int AS lost, COUNT(*) FILTER (WHERE report_type='found')::int AS found, COUNT(*) FILTER (WHERE status='returned')::int AS returned FROM items`);
    res.json(rows[0]);
  } catch (error) { next(error); }
});

app.use((req, res) => res.status(404).json({ error: "Route not found." }));
app.use((error, req, res, next) => {
  console.error(error);
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.message });
  const status = error.status || 500;
  res.status(status).json({ error: status === 500 ? "Something went wrong. Please try again." : error.message });
});

async function start() {
  await migrate();
  app.listen(PORT, () => console.log(`Recoverly is running at http://localhost:${PORT}`));
}
start().catch((error) => { console.error("Startup failed:", error.message); process.exit(1); });
process.on("SIGINT", async () => { await close(); process.exit(0); });
process.on("SIGTERM", async () => { await close(); process.exit(0); });

