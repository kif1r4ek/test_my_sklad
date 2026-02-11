import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  API_BASE,
  CARDS_CACHE_FILE,
  CARDS_CACHE_MS,
  CACHE_MS,
  CACHE_NEW_ORDERS_MS,
  CACHE_ORDERS_MS,
  CACHE_SUPPLIES_MS,
  CONTENT_BASE,
  COOKIE_NAME,
  COOKIE_PATH,
  COOKIE_SECURE,
  DB_HOST,
  DB_NAME,
  DB_PASSWORD,
  DB_PORT,
  DB_SSL,
  DB_USER,
  DEFAULT_SITE,
  HOST,
  LABEL_BATCH_SIZE,
  LABEL_HEIGHT,
  LABEL_TYPE,
  LABEL_WIDTH,
  MAX_CREATE_COUNT,
  NAME_BACKFILL_BATCH,
  NAME_BACKFILL_DELAY_MS,
  NAME_BACKFILL_ENABLED,
  NAME_BACKFILL_INTERVAL_MS,
  ORDER_BATCH_SIZE,
  PORT,
  PRODUCT_CACHE_MS,
  PRODUCT_NEGATIVE_CACHE_MS,
  PRODUCT_RESOLVE_BATCH,
  ROLE_ADMIN,
  ROLE_EMPLOYEE,
  ROLE_SUPER,
  ROOT_SITE,
  SESSION_TTL_MS,
  SITES_ROOT,
  SUPPLY_SYNC_MS,
  WB_API_TOKEN,
  WB_API_TOKEN_2,
  WB_CLIENT_SECRET,
  WB_CLIENT_SECRET_2,
  WB_STORE_1_ID,
  WB_STORE_1_NAME,
  WB_STORE_2_ID,
  WB_STORE_2_NAME,
} from "./server/config.mjs";
import {
  buildLabelsPrefix,
  buildS3Key,
  buildS3Url,
  pngBase64ToPdf,
  uploadPdfToS3,
} from "./server/services/s3.mjs";
import { getMsBarcodesByArticle, getMsProductStatusByArticle } from "./server/services/ms.mjs";
import {
  escapeHtml,
  normalizeArticleKey,
  normalizeBarcode,
  normalizeSkus,
  normalizeStoreId,
  normalizeSupplyId,
  normalizeText,
} from "./server/utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storeList = [];
const storeMap = new Map();

function registerStore(store) {
  if (!store || !store.id || !store.token) return;
  storeList.push(store);
  storeMap.set(store.id, store);
}

registerStore({
  id: WB_STORE_1_ID,
  name: WB_STORE_1_NAME,
  token: WB_API_TOKEN,
  clientSecret: WB_CLIENT_SECRET,
});
if (WB_API_TOKEN_2) {
  registerStore({
    id: WB_STORE_2_ID,
    name: WB_STORE_2_NAME,
    token: WB_API_TOKEN_2,
    clientSecret: WB_CLIENT_SECRET_2,
  });
}

const DEFAULT_STORE = storeList[0] || null;

function resolveStore(storeId) {
  if (!storeId) return DEFAULT_STORE;
  return storeMap.get(storeId) || DEFAULT_STORE;
}

const storeCaches = new Map();
function createStoreCache() {
  return {
    newOrders: { ts: 0, data: [], error: null, loading: null },
    orders: { ts: 0, data: [], error: null, loading: null },
    supplies: { ts: 0, data: [], error: null, loading: null },
    productCache: new Map(),
    cardsCache: { ts: 0, map: new Map(), loading: null },
    contentBackoffUntil: 0,
  };
}
function getStoreCache(storeId) {
  const key = storeId || DEFAULT_STORE?.id || "default";
  if (!storeCaches.has(key)) {
    storeCaches.set(key, createStoreCache());
  }
  return storeCaches.get(key);
}

const labelJobs = new Map();
const supplySyncJobs = new Map();

const sseClients = new Map();
let sseClientId = 1;
const SSE_PING_MS = 20000;
const sseLastNotify = new Map();

function sendSse(res, event, data) {
  const payload = data ? JSON.stringify(data) : "{}";
  res.write(`event: ${event}\n`);
  res.write(`data: ${payload}\n\n`);
}

function addSseClient(res, user) {
  const id = sseClientId++;
  const client = { id, res, userId: Number(user.id), role: user.role };
  sseClients.set(id, client);
  res.on("close", () => {
    sseClients.delete(id);
  });
  sendSse(res, "hello", { time: new Date().toISOString() });
  return client;
}

function broadcastSse(event, data, filter) {
  for (const [id, client] of sseClients) {
    if (filter && !filter(client)) continue;
    try {
      sendSse(client.res, event, data);
    } catch {
      sseClients.delete(id);
    }
  }
}

function notifySupplyUpdate(supplyId, force = false) {
  const key = String(supplyId || "");
  const now = Date.now();
  const last = sseLastNotify.get(key) || 0;
  if (!force && now - last < 800) return;
  sseLastNotify.set(key, now);
  broadcastSse("supply_update", { supplyId: key });
}

setInterval(() => {
  for (const [id, client] of sseClients) {
    try {
      client.res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    } catch {
      sseClients.delete(id);
    }
  }
}, SSE_PING_MS);

for (const store of storeList) {
  loadCardsCacheFromDisk(store.id);
  getCardsCache(store).catch(() => {});
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function siteDist(site) {
  return path.join(SITES_ROOT, site, "dist");
}

function siteIndex(site) {
  return path.join(siteDist(site), "index.html");
}

function siteExists(site) {
  return fs.existsSync(siteIndex(site));
}

function hasExt(p) {
  return path.extname(p || "") !== "";
}

function safeJoin(base, rel) {
  const basePath = path.resolve(base);
  const target = path.resolve(base, rel);
  const baseLower = basePath.toLowerCase();
  const targetLower = target.toLowerCase();
  if (targetLower === baseLower) return target;
  if (!targetLower.startsWith(baseLower + path.sep.toLowerCase())) return null;
  return target;
}

function resolveSite(pathname) {
  if (pathname === "/" || pathname === "") {
    return { site: ROOT_SITE, subpath: "/" };
  }
  const parts = pathname.split("/").filter(Boolean);
  const candidate = parts[0];
  if (candidate && siteExists(candidate)) {
    const rest = parts.slice(1).join("/");
    return { site: candidate, subpath: rest ? `/${rest}` : "/" };
  }
  return { site: ROOT_SITE, subpath: pathname };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function streamFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

function cacheFresh(entry, ttl = CACHE_MS) {
  return entry.data && Date.now() - entry.ts < ttl;
}

function cacheHasData(entry) {
  return Array.isArray(entry.data) && entry.data.length > 0;
}

function getCardsCacheFile(storeId) {
  if (!storeId) return CARDS_CACHE_FILE;
  const ext = path.extname(CARDS_CACHE_FILE) || ".json";
  const base = CARDS_CACHE_FILE.replace(ext, "");
  return `${base}-${storeId}${ext}`;
}

function loadCardsCacheFromDisk(storeId) {
  try {
    const filePath = getCardsCacheFile(storeId);
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return;
    const map = new Map();
    for (const item of parsed.items) {
      const vendorCode = normalizeArticleKey(item?.vendorCode);
      if (!vendorCode) continue;
      map.set(vendorCode, {
        ts: parsed.ts || Date.now(),
        title: item.title || null,
        barcodes: Array.isArray(item.barcodes) ? item.barcodes : [],
      });
    }
    if (map.size > 0) {
      const cache = getStoreCache(storeId);
      cache.cardsCache.map = map;
      cache.cardsCache.ts = parsed.ts || Date.now();
    }
  } catch {
    // ignore cache load errors
  }
}

function saveCardsCacheToDisk(storeId, map) {
  try {
    const items = Array.from(map.entries()).map(([vendorCode, info]) => ({
      vendorCode,
      title: info?.title || null,
      barcodes: Array.isArray(info?.barcodes) ? info.barcodes : [],
    }));
    const payload = JSON.stringify({ ts: Date.now(), items });
    const filePath = getCardsCacheFile(storeId);
    fs.writeFileSync(filePath, payload, "utf8");
  } catch {
    // ignore cache save errors
  }
}

function normalizeOrder(order, fallbackSupplyId = null) {
  if (!order) return null;
  const quantityRaw = order.quantity ?? order.qty ?? order.count ?? 1;
  const quantity = Number.isFinite(Number(quantityRaw)) ? Number(quantityRaw) : 1;
  const skus = normalizeSkus(order.skus ?? order.sku ?? order.barcodes ?? null);
  const rawBarcode = normalizeBarcode(order.barcode ?? order.barCode ?? null);
  const barcode = rawBarcode || skus[0] || null;
  const supplyId = normalizeSupplyId(order.supplyId ?? order.supplyID ?? order.supply_id ?? null);
  const resolvedSupplyId = supplyId || normalizeSupplyId(fallbackSupplyId);
  const createdAt =
    order.createdAt ?? order.created_at ?? order.dateCreated ?? order.date_created ?? null;
  return {
    id: order.id ?? order.orderId ?? order.orderID ?? order.order_id ?? null,
    createdAt,
    article: normalizeArticleKey(order.article ?? order.vendorCode ?? order.vendor_code ?? null),
    nmId: order.nmId ?? order.nmID ?? order.nm_id ?? null,
    warehouseId: order.warehouseId ?? order.warehouse_id ?? null,
    cargoType: order.cargoType ?? order.cargo_type ?? null,
    supplyId: resolvedSupplyId,
    quantity: quantity > 0 ? quantity : 1,
    skus,
    barcode,
    productName: order.productName ?? order.product_name ?? order.name ?? order.goodsName ?? null,
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  return JSON.parse(raw);
}

function parseCookies(header = "") {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function isPlaceholderName(name, article) {
  const raw = name === null || name === undefined ? "" : String(name).trim();
  if (!raw) return true;
  if (raw === "—" || raw === "-" || raw === "_") return true;
  const junkMatch = raw.match(/[�\?]/g);
  if (junkMatch && junkMatch.length >= Math.max(2, Math.floor(raw.length * 0.3))) {
    return true;
  }
  const art = normalizeArticleKey(article);
  if (art && raw.toLowerCase() === art.toLowerCase()) return true;
  return false;
}

function extractCardTitle(card) {
  if (!card) return null;
  if (card.title) return card.title;
  const chars = Array.isArray(card.characteristics) ? card.characteristics : [];
  const pickValue = (value) => {
    if (Array.isArray(value)) {
      const first = value.find((v) => v !== null && v !== undefined && String(v).trim());
      return first ? String(first).trim() : null;
    }
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    return str || null;
  };
  for (const c of chars) {
    if (Number(c?.id) === 15000785) {
      const picked = pickValue(c.value);
      if (picked) return picked;
    }
  }
  for (const c of chars) {
    const name = String(c?.name || "").toLowerCase();
    if (name.includes("торгов") && name.includes("наимен")) {
      const picked = pickValue(c.value);
      if (picked) return picked;
    }
    if (name === "наименование" || name.includes("наименование")) {
      const picked = pickValue(c.value);
      if (picked) return picked;
    }
  }
  const direct = card.subjectName || card.brand || null;
  if (direct) return direct;
  return null;
}

function extractCardInfo(card) {
  if (!card) return null;
  const title = extractCardTitle(card);
  const barcodes = [];
  if (Array.isArray(card.sizes)) {
    for (const size of card.sizes) {
      const skus = normalizeSkus(size?.skus);
      for (const sku of skus) {
        if (!barcodes.includes(sku)) barcodes.push(sku);
      }
    }
  }
  const vendorCode = normalizeArticleKey(card.vendorCode || null);
  const nmId = card.nmID ?? card.nmId ?? card.nm_id ?? null;
  return { title, barcodes, vendorCode, nmId };
}

function getStoreFromRequest(req) {
  const raw = req.headers["x-store-id"] || req.headers["x-store"] || "";
  const id = normalizeStoreId(raw);
  return resolveStore(id);
}

function formatPgError(err) {
  if (!err) return null;
  const keys = [
    "code",
    "message",
    "detail",
    "hint",
    "severity",
    "where",
    "position",
    "schema",
    "table",
    "column",
    "dataType",
    "constraint",
  ];
  const out = {};
  for (const key of keys) {
    if (err[key]) out[key] = err[key];
  }
  if (!out.message) out.message = String(err);
  return out;
}

function testTcp(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, error: error || null, elapsedMs: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, null));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (err) => finish(false, err?.message || String(err)));
    try {
      socket.connect(port, host);
    } catch (err) {
      finish(false, err?.message || String(err));
    }
  });
}

async function testDbConnection(useSsl) {
  const pool = new Pool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 4000,
  });
  try {
    await pool.query("select 1 as ok");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: formatPgError(err) };
  } finally {
    try {
      await pool.end();
    } catch {}
  }
}

async function handleDebugPage(req, res, url) {
  const started = Date.now();
  const [tcp, dbSsl, dbNoSsl] = await Promise.all([
    testTcp(DB_HOST, DB_PORT, 3000),
    testDbConnection(true),
    testDbConnection(false),
  ]);

  const rows = [
    ["time", new Date().toISOString()],
    ["node", process.version],
    ["pid", process.pid],
    ["cwd", process.cwd()],
    ["__dirname", __dirname],
    ["request_url", url?.href || req.url],
    ["host_header", req.headers.host || ""],
    ["client_ip", req.socket?.remoteAddress || ""],
    ["root_site", ROOT_SITE],
    ["cookie_path", COOKIE_PATH],
    ["db_host", DB_HOST],
    ["db_port", DB_PORT],
    ["db_user", DB_USER],
    ["db_name", DB_NAME],
    ["db_ssl_mode", DB_SSL],
    ["db_password_set", DB_PASSWORD ? "yes" : "no"],
    ["db_password_len", DB_PASSWORD ? DB_PASSWORD.length : 0],
    ["tcp_ok", String(tcp.ok)],
    ["tcp_error", tcp.error || ""],
    ["tcp_elapsed_ms", String(tcp.elapsedMs || 0)],
    ["db_ssl_true_ok", String(dbSsl.ok)],
    ["db_ssl_true_error", dbSsl.error ? JSON.stringify(dbSsl.error) : ""],
    ["db_ssl_false_ok", String(dbNoSsl.ok)],
    ["db_ssl_false_error", dbNoSsl.error ? JSON.stringify(dbNoSsl.error) : ""],
    ["elapsed_ms", String(Date.now() - started)],
  ];

  const body = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DB Debug</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; padding: 16px; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #ddd; padding: 6px 8px; vertical-align: top; }
    th { text-align: left; background: #f5f5f5; }
    .muted { color: #666; }
    pre { white-space: pre-wrap; margin: 0; }
  </style>
</head>
<body>
  <h1>DB Debug</h1>
  <p class="muted">Пароль не показывается, только длина.</p>
  <table>
    <thead><tr><th>Key</th><th>Value</th></tr></thead>
    <tbody>
      ${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td><pre>${escapeHtml(v)}</pre></td></tr>`).join("")}
    </tbody>
  </table>
</body>
</html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
let poolPromise = null;

function makePool(useSsl) {
  return new Pool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
}

async function createAndTestPool(useSsl) {
  const pool = makePool(useSsl);
  try {
    await pool.query("select 1 as ok");
    return pool;
  } catch (err) {
    try {
      await pool.end();
    } catch {}
    throw err;
  }
}

async function getPool() {
  if (poolPromise) return poolPromise;
  poolPromise = (async () => {
    if (DB_SSL === "disable") {
      return await createAndTestPool(false);
    }
    if (DB_SSL === "require") {
      return await createAndTestPool(true);
    }
    try {
      return await createAndTestPool(true);
    } catch {
      return await createAndTestPool(false);
    }
  })();
  return poolPromise;
}

async function dbQuery(text, params) {
  const pool = await getPool();
  return pool.query(text, params);
}

async function ensureStoreSchema() {
  await dbQuery("alter table supply_settings add column if not exists store_id text", []);
  await dbQuery("alter table supply_settings add column if not exists store_name text", []);
  if (DEFAULT_STORE?.id) {
    await dbQuery(
      "update supply_settings set store_id = $1, store_name = $2 where store_id is null",
      [DEFAULT_STORE.id, DEFAULT_STORE.name]
    );
  }
  for (const store of storeList) {
    if (!store?.id) continue;
    await dbQuery(
      "update supply_settings set store_name = $2 where store_id = $1",
      [store.id, store.name]
    );
  }
}

ensureStoreSchema().catch((err) => {
  console.error("Store schema init failed", err);
});

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const derived = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, "hex");
  if (stored.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, stored);
}

function toPublicUser(row) {
  return {
    id: Number(row.id),
    surname: row.surname,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
  };
}

function toEmployeeUser(row) {
  return {
    id: Number(row.id),
    surname: row.surname,
    name: row.name,
  };
}

async function listEmployees() {
  const result = await dbQuery(
    "select id, surname, name from users where role = $1 order by surname, name, id",
    [ROLE_EMPLOYEE]
  );
  return result.rows || [];
}

async function ensureSupplySettings(supplyId, supplyName = null, store = null) {
  if (!supplyId) return null;
  const storeId = store?.id || null;
  const storeName = store?.name || null;
  const result = await dbQuery(
    `insert into supply_settings (supply_id, supply_name, store_id, store_name, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (supply_id)
     do update set supply_name = coalesce(excluded.supply_name, supply_settings.supply_name),
                   store_id = coalesce(excluded.store_id, supply_settings.store_id),
                   store_name = coalesce(excluded.store_name, supply_settings.store_name),
                   updated_at = now()
     returning *`,
    [supplyId, supplyName, storeId, storeName]
  );
  return result.rows?.[0] || null;
}

async function getSupplySettings(supplyId) {
  const result = await dbQuery(
    `select supply_id, supply_name, access_mode, labels_status, labels_format,
            labels_s3_prefix, labels_total, labels_loaded, labels_error,
            store_id, store_name,
            labels_started_at, labels_finished_at, created_at, updated_at
     from supply_settings where supply_id = $1`,
    [supplyId]
  );
  return result.rows?.[0] || null;
}

async function getSupplyStore(supplyId, supplyName = null, fallbackStore = null) {
  if (!supplyId) return fallbackStore || DEFAULT_STORE;
  await ensureSupplySettings(supplyId, supplyName, fallbackStore);
  const settings = await getSupplySettings(supplyId);
  const storedId = normalizeStoreId(settings?.store_id);
  const store = resolveStore(storedId) || fallbackStore || DEFAULT_STORE;
  if (store && (!storedId || !settings?.store_name)) {
    await dbQuery(
      "update supply_settings set store_id = $2, store_name = $3, updated_at = now() where supply_id = $1",
      [supplyId, store.id, store.name]
    );
  }
  return store;
}

async function setSupplyAccessMode(supplyId, mode) {
  await dbQuery(
    "update supply_settings set access_mode = $2, updated_at = now() where supply_id = $1",
    [supplyId, mode]
  );
}

async function getSupplyAccessUserIds(supplyId) {
  const result = await dbQuery(
    "select user_id from supply_access_users where supply_id = $1 order by user_id",
    [supplyId]
  );
  return result.rows.map((row) => Number(row.user_id));
}

async function setSupplyAccessUsers(supplyId, userIds) {
  await dbQuery("delete from supply_access_users where supply_id = $1", [supplyId]);
  if (!userIds.length) return;
  const values = [];
  const placeholders = userIds.map((userId, idx) => {
    values.push(userId);
    return `($1, $${idx + 2})`;
  });
  await dbQuery(
    `insert into supply_access_users (supply_id, user_id) values ${placeholders.join(", ")}`,
    [supplyId, ...values]
  );
}

async function upsertSupplyOrders(supplyId, orders) {
  if (!orders.length) return;
  const deduped = new Map();
  for (const order of orders) {
    const id = Number(order?.id);
    if (!Number.isFinite(id)) continue;
    deduped.set(id, order);
  }
  if (deduped.size === 0) return;
  const values = [];
  const rows = Array.from(deduped.values()).map((order, idx) => {
    const base = idx * 11;
    const qty = Number(order.quantity ?? 1);
    values.push(
      supplyId,
      Number(order.id),
      order.createdAt ? new Date(order.createdAt) : null,
      order.article ?? null,
      order.barcode ?? null,
      order.productName ?? null,
      order.nmId ?? null,
      Number.isFinite(qty) && qty > 0 ? qty : 1,
      order.warehouseId ?? null,
      order.cargoType ?? null,
      new Date()
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
  });

  await dbQuery(
    `insert into supply_orders
      (supply_id, wb_order_id, order_created_at, article, barcode, product_name, nm_id, quantity, warehouse_id, cargo_type, synced_at)
     values ${rows.join(", ")}
     on conflict (supply_id, wb_order_id) do update set
       order_created_at = coalesce(excluded.order_created_at, supply_orders.order_created_at),
       article = coalesce(excluded.article, supply_orders.article),
       barcode = coalesce(excluded.barcode, supply_orders.barcode),
       product_name = coalesce(excluded.product_name, supply_orders.product_name),
       nm_id = coalesce(excluded.nm_id, supply_orders.nm_id),
       quantity = coalesce(excluded.quantity, supply_orders.quantity),
       warehouse_id = coalesce(excluded.warehouse_id, supply_orders.warehouse_id),
       cargo_type = coalesce(excluded.cargo_type, supply_orders.cargo_type),
       synced_at = now(),
       updated_at = now()`,
    values
  );
}

async function refreshSupplySnapshot(supplyId, supplyName = null) {
  if (!supplyId) return [];
  if (supplySyncJobs.has(supplyId)) return supplySyncJobs.get(supplyId);
  const job = (async () => {
    const store = await getSupplyStore(supplyId, supplyName);
    await ensureSupplySettings(supplyId, supplyName, store);
    let ordersRaw = [];
    try {
      ordersRaw = await fetchSupplyOrders(store, supplyId);
    } catch (err) {
      try {
        const fallback = await getOrders(store?.id);
        ordersRaw = fallback.filter((order) => String(order.supplyId || "") === String(supplyId));
      } catch (fallbackErr) {
        console.error("Supply snapshot fallback failed", {
          supplyId,
          error: fallbackErr?.message || String(fallbackErr),
        });
        ordersRaw = [];
      }
    }
    const normalized = ordersRaw
      .map((order) => normalizeOrder(order, supplyId))
      .filter((order) => order && order.id);
    if (normalized.length) {
      await upsertSupplyOrders(supplyId, normalized);
      await fillMissingOrderInfo(supplyId, normalized, store);
    }
    return normalized;
  })();
  supplySyncJobs.set(supplyId, job);
  job.finally(() => supplySyncJobs.delete(supplyId));
  return job;
}

async function ensureSupplySnapshot(supplyId, supplyName = null) {
  return refreshSupplySnapshot(supplyId, supplyName);
}

async function ensureSupplySnapshotIfStale(supplyId, supplyName = null) {
  if (!supplyId) return;
  const result = await dbQuery(
    "select max(synced_at) as last_sync from supply_orders where supply_id = $1",
    [supplyId]
  );
  const last = result.rows?.[0]?.last_sync;
  if (!last) {
    try {
      await refreshSupplySnapshot(supplyId, supplyName);
    } catch {}
    return;
  }
  const lastTs = new Date(last).getTime();
  if (!Number.isFinite(lastTs) || Date.now() - lastTs > SUPPLY_SYNC_MS) {
    try {
      await refreshSupplySnapshot(supplyId, supplyName);
    } catch {}
  }
}

async function ensureSupplySnapshotIfEmpty(supplyId, supplyName = null) {
  if (!supplyId) return;
  const check = await dbQuery(
    "select 1 from supply_orders where supply_id = $1 limit 1",
    [supplyId]
  );
  if (!check.rows || check.rows.length === 0) {
    await refreshSupplySnapshot(supplyId, supplyName);
  }
}

async function fillMissingOrderInfo(supplyId, orders, store) {
  const missing = orders.filter((order) => {
    if (!order.article) return false;
    const rawName = order.product_name || order.productName || "";
    const needsName = isPlaceholderName(rawName, order.article);
    return needsName || !order.barcode;
  });
  if (!missing.length) return orders;
  const infoMap = await resolveProductInfoForOrders(store, missing);
  const updates = [];
  for (const order of missing) {
    const info = infoMap.get(order.article);
    if (!info) continue;
    const rawName = order.product_name || order.productName || "";
    const needsName = isPlaceholderName(rawName, order.article);
    const nextName = needsName ? info.title || null : rawName || null;
    const nextBarcode = order.barcode || (info.barcodes && info.barcodes[0]) || null;
    if (!nextName && !nextBarcode) continue;
    if (nextName) order.product_name = nextName;
    order.barcode = nextBarcode;
    updates.push({ id: order.wb_order_id, name: nextName, barcode: nextBarcode });
  }
  for (const update of updates) {
    await dbQuery(
      `update supply_orders set product_name = coalesce($3, product_name),
       barcode = coalesce($4, barcode), updated_at = now()
       where supply_id = $1 and wb_order_id = $2`,
      [supplyId, update.id, update.name, update.barcode]
    );
  }
  return orders;
}

let nameBackfillRunning = false;
let nameBackfillTimer = null;

async function backfillMissingNamesBatch() {
  if (nameBackfillRunning) return;
  nameBackfillRunning = true;
  try {
    const result = await dbQuery(
      `select o.article, o.nm_id, s.store_id, count(*) as cnt
       from supply_orders o
       left join supply_settings s on s.supply_id = o.supply_id
       where o.article is not null
         and (o.product_name is null or o.product_name = '' or lower(o.product_name) = lower(o.article))
       group by o.article, o.nm_id, s.store_id
       order by cnt desc
       limit $1`,
      [NAME_BACKFILL_BATCH]
    );
    const rows = result.rows || [];
    if (!rows.length) return;
    const byStore = new Map();
    for (const row of rows) {
      const article = normalizeArticleKey(row.article);
      if (!article) continue;
      const storeId = normalizeStoreId(row.store_id) || DEFAULT_STORE?.id || null;
      if (!storeId) continue;
      if (!byStore.has(storeId)) byStore.set(storeId, []);
      byStore.get(storeId).push({
        article,
        nmId: row.nm_id,
        productName: null,
      });
    }
    for (const [storeId, orders] of byStore) {
      const store = resolveStore(storeId) || DEFAULT_STORE;
      if (!store) continue;
      const infoMap = await resolveProductInfoForOrders(store, orders);
      for (const order of orders) {
        const info = infoMap.get(order.article);
        const title = info?.title || null;
        if (!title) continue;
        await dbQuery(
          `update supply_orders o
           set product_name = $1, updated_at = now()
           from supply_settings s
           where o.supply_id = s.supply_id
             and s.store_id = $2
             and o.article = $3
             and (o.product_name is null or o.product_name = '' or lower(o.product_name) = lower(o.article))`,
          [title, store.id, order.article]
        );
      }
    }
  } catch (err) {
    console.error("Name backfill failed", err?.message || err);
  } finally {
    nameBackfillRunning = false;
  }
}

function startNameBackfill() {
  if (!NAME_BACKFILL_ENABLED) return;
  if (nameBackfillTimer) return;
  const run = () => {
    backfillMissingNamesBatch().catch(() => {});
  };
  setTimeout(run, NAME_BACKFILL_DELAY_MS);
  nameBackfillTimer = setInterval(run, NAME_BACKFILL_INTERVAL_MS);
}

function countDistinctItems(orders) {
  if (!orders || !orders.length) return 0;
  const set = new Set();
  for (const order of orders) {
    const key = [
      order.productName || order.product_name || "",
      order.barcode || "",
      order.article || "",
      order.nmId || order.nm_id || "",
    ].join("||");
    set.add(key);
  }
  return set.size;
}

async function getSupplyAggregates(supplyIds) {
  if (!supplyIds.length) return new Map();
  const result = await dbQuery(
    `select supply_id,
            count(*) as order_count,
            count(*) filter (where collected_at is not null) as collected_count,
            count(distinct (coalesce(product_name, ''), coalesce(barcode, ''), coalesce(article, ''), coalesce(nm_id::text, ''))) as item_count,
            count(distinct assigned_user_id) filter (where assigned_user_id is not null) as assigned_users
     from supply_orders
     where supply_id = any($1)
     group by supply_id`,
    [supplyIds]
  );
  const map = new Map();
  for (const row of result.rows || []) {
    map.set(row.supply_id, {
      orderCount: Number(row.order_count || 0),
      collectedCount: Number(row.collected_count || 0),
      itemCount: Number(row.item_count || 0),
      assignedUsers: Number(row.assigned_users || 0),
    });
  }
  return map;
}

async function getSupplyAccessStats(supplyIds) {
  if (!supplyIds.length) {
    return { accessUsers: new Map(), accessModes: new Map() };
  }
  const usersResult = await dbQuery(
    `select supply_id, count(*) as access_users
     from supply_access_users
     where supply_id = any($1)
     group by supply_id`,
    [supplyIds]
  );
  const modeResult = await dbQuery(
    "select supply_id, access_mode from supply_settings where supply_id = any($1)",
    [supplyIds]
  );
  const accessUsers = new Map();
  for (const row of usersResult.rows || []) {
    accessUsers.set(row.supply_id, Number(row.access_users || 0));
  }
  const accessModes = new Map();
  for (const row of modeResult.rows || []) {
    accessModes.set(row.supply_id, row.access_mode);
  }
  return { accessUsers, accessModes };
}

async function getSupplyProgress(supplyId, accessMode) {
  let rows = [];
  let baseUserIds = [];
  if (accessMode === "selected_split") {
    const result = await dbQuery(
      `select assigned_user_id as user_id,
              count(*) as total,
              count(*) filter (where collected_at is not null) as collected
       from supply_orders
       where supply_id = $1 and assigned_user_id is not null
       group by assigned_user_id`,
      [supplyId]
    );
    rows = result.rows || [];
    baseUserIds = await getSupplyAccessUserIds(supplyId);
  } else {
    const result = await dbQuery(
      `select collected_by as user_id,
              count(*) as collected
       from supply_orders
       where supply_id = $1 and collected_by is not null
       group by collected_by`,
      [supplyId]
    );
    rows = result.rows || [];
    if (accessMode === "selected") {
      baseUserIds = await getSupplyAccessUserIds(supplyId);
    }
  }

  const rowMap = new Map(rows.map((row) => [Number(row.user_id), row]));
  const userIds =
    baseUserIds.length > 0
      ? baseUserIds.map((id) => Number(id)).filter(Boolean)
      : Array.from(rowMap.keys());
  if (!userIds.length) return [];

  const users = await dbQuery(
    "select id, surname, name from users where id = any($1)",
    [userIds]
  );
  const byId = new Map((users.rows || []).map((row) => [Number(row.id), row]));

  return userIds
    .map((userId) => {
      const user = byId.get(Number(userId));
      if (!user) return null;
      const row = rowMap.get(Number(userId));
      return {
        userId: Number(userId),
        surname: user.surname,
        name: user.name,
        total: row?.total ? Number(row.total) : accessMode === "selected_split" ? 0 : null,
        collected: row?.collected ? Number(row.collected) : 0,
      };
    })
    .filter(Boolean);
}

async function splitSupplyOrders(supplyId, userIds, mode = "split") {
  if (!userIds.length) {
    throw new Error("Не выбраны сотрудники для распределения");
  }
  if (mode === "redistribute") {
    await dbQuery(
      "update supply_orders set assigned_user_id = null, assigned_at = null where supply_id = $1 and collected_at is null",
      [supplyId]
    );
  }
  const result = await dbQuery(
    `select wb_order_id, order_created_at
     from supply_orders
     where supply_id = $1 and collected_at is null ${mode === "split" ? "and assigned_user_id is null" : ""}`,
    [supplyId]
  );
  const orders = (result.rows || []).sort((a, b) => {
    const aTime = a.order_created_at ? new Date(a.order_created_at).getTime() : 0;
    const bTime = b.order_created_at ? new Date(b.order_created_at).getTime() : 0;
    if (aTime === bTime) return Number(a.wb_order_id) - Number(b.wb_order_id);
    return aTime - bTime;
  });
  if (!orders.length) {
    return { total: 0, assigned: 0, perUser: [] };
  }

  const sortedUsers = [...userIds].map(Number).sort((a, b) => a - b);
  const total = orders.length;
  const perUser = [];
  const base = Math.floor(total / sortedUsers.length);
  const extra = total % sortedUsers.length;

  let offset = 0;
  for (let i = 0; i < sortedUsers.length; i += 1) {
    const userId = sortedUsers[i];
    const count = base + (i < extra ? 1 : 0);
    const slice = orders.slice(offset, offset + count).map((row) => Number(row.wb_order_id));
    offset += count;
    if (slice.length) {
      await dbQuery(
        "update supply_orders set assigned_user_id = $3, assigned_at = now() where supply_id = $1 and wb_order_id = any($2)",
        [supplyId, slice, userId]
      );
    }
    perUser.push({ userId, count: slice.length });
  }

  return {
    total,
    assigned: orders.length,
    perUser,
  };
}

async function resetSupplyAccess(supplyId) {
  await setSupplyAccessMode(supplyId, "all");
  await dbQuery("delete from supply_access_users where supply_id = $1", [supplyId]);
  await dbQuery(
    "update supply_orders set assigned_user_id = null, assigned_at = null where supply_id = $1",
    [supplyId]
  );
}

async function startLabelsJob(supplyId, supplyName, force = false) {
  if (labelJobs.has(supplyId)) return labelJobs.get(supplyId);
  const job = (async () => {
    const store = await getSupplyStore(supplyId, supplyName);
    await ensureSupplySettings(supplyId, supplyName, store);
    await ensureSupplySnapshot(supplyId, supplyName);
    const settings = await getSupplySettings(supplyId);
    const prefix = settings?.labels_s3_prefix || buildLabelsPrefix(supplyId, settings?.supply_name || supplyName);
    if (!settings?.labels_s3_prefix || force) {
      await dbQuery(
        "update supply_settings set labels_s3_prefix = $2, updated_at = now() where supply_id = $1",
        [supplyId, prefix]
      );
    }

    const ordersResult = await dbQuery(
      "select wb_order_id, sticker_url from supply_orders where supply_id = $1 order by wb_order_id",
      [supplyId]
    );
    const allOrders = ordersResult.rows || [];
    const total = allOrders.length;
    const alreadyLoaded = allOrders.filter((row) => row.sticker_url).length;
    const toFetch = force
      ? allOrders
      : allOrders.filter((row) => !row.sticker_url);

    await dbQuery(
      `update supply_settings set labels_status = 'loading', labels_total = $2,
       labels_loaded = $3, labels_error = null, labels_started_at = now(),
       labels_finished_at = null, updated_at = now() where supply_id = $1`,
      [supplyId, total, force ? 0 : alreadyLoaded]
    );
    notifySupplyUpdate(supplyId, true);

    let loaded = force ? 0 : alreadyLoaded;
    let errors = 0;

    for (let i = 0; i < toFetch.length; i += LABEL_BATCH_SIZE) {
      const batch = toFetch.slice(i, i + LABEL_BATCH_SIZE).map((row) => Number(row.wb_order_id));
      if (!batch.length) continue;
      const data = await wbRequest(
        store,
        `/api/v3/orders/stickers?type=${LABEL_TYPE}&width=${LABEL_WIDTH}&height=${LABEL_HEIGHT}`,
        {
          method: "POST",
          body: { orders: batch },
        }
      );
      const stickers = Array.isArray(data?.stickers) ? data.stickers : [];
      const byId = new Map(stickers.map((item) => [Number(item.orderId), item]));

      for (const orderId of batch) {
        const sticker = byId.get(Number(orderId));
        if (!sticker?.file) {
          errors += 1;
          await dbQuery(
            `update supply_orders set sticker_error = $3, updated_at = now()
             where supply_id = $1 and wb_order_id = $2`,
            [supplyId, orderId, "Sticker not returned by WB"]
          );
          continue;
        }
        try {
          const pdfBytes = await pngBase64ToPdf(sticker.file);
          const key = buildS3Key(prefix, orderId);
          await uploadPdfToS3(key, pdfBytes);
          const url = buildS3Url(key);
          await dbQuery(
            `update supply_orders set sticker_url = $3, sticker_format = 'pdf',
             sticker_s3_key = $4, sticker_barcode = $5, sticker_loaded_at = now(),
             sticker_error = null, updated_at = now()
             where supply_id = $1 and wb_order_id = $2`,
            [supplyId, orderId, url, key, sticker.barcode || null]
          );
          loaded += 1;
        } catch (err) {
          errors += 1;
          await dbQuery(
            `update supply_orders set sticker_error = $3, updated_at = now()
             where supply_id = $1 and wb_order_id = $2`,
            [supplyId, orderId, err?.message || "Sticker upload failed"]
          );
        }
        await dbQuery(
          "update supply_settings set labels_loaded = $2, updated_at = now() where supply_id = $1",
          [supplyId, loaded]
        );
        notifySupplyUpdate(supplyId);
      }
    }

    const status = errors > 0 ? "error" : "ready";
    const errorText = errors > 0 ? `Ошибок: ${errors}` : null;
    await dbQuery(
      `update supply_settings set labels_status = $2, labels_error = $3,
       labels_finished_at = now(), updated_at = now() where supply_id = $1`,
      [supplyId, status, errorText]
    );
    notifySupplyUpdate(supplyId, true);
  })();

  labelJobs.set(supplyId, job);
  job.finally(() => labelJobs.delete(supplyId));
  return job;
}

async function findUserBySurname(surname) {
  const result = await dbQuery(
    "select id, surname, name, role, password_hash, password_salt, created_at from users where surname = $1 order by id",
    [surname]
  );
  return result.rows || [];
}

async function findUserById(id) {
  const result = await dbQuery(
    "select id, surname, name, role, password_hash, password_salt, created_at from users where id = $1",
    [id]
  );
  return result.rows?.[0] || null;
}

async function ensureUniqueSurnamePassword(surname, password, excludeId = null) {
  const users = await findUserBySurname(surname);
  for (const user of users) {
    if (excludeId && Number(user.id) === Number(excludeId)) continue;
    if (verifyPassword(password, user.password_salt, user.password_hash)) {
      throw new Error("Пользователь с такой фамилией и паролем уже существует. Задайте другой пароль.");
    }
  }
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await dbQuery(
    "insert into sessions (token, user_id, expires_at, created_at, updated_at) values ($1, $2, $3, now(), now())",
    [token, userId, expires]
  );
  return { token, expires };
}

async function getSession(token) {
  const result = await dbQuery(
    "select s.token, s.expires_at, u.id as user_id, u.surname, u.name, u.role from sessions s join users u on u.id = s.user_id where s.token = $1",
    [token]
  );
  return result.rows?.[0] || null;
}

async function refreshSession(token, expires) {
  await dbQuery("update sessions set expires_at = $1, updated_at = now() where token = $2", [expires, token]);
}

async function deleteSession(token) {
  await dbQuery("delete from sessions where token = $1", [token]);
}

function shouldUseSecureCookie(req) {
  if (COOKIE_SECURE) return true;
  const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  return proto === "https";
}

function setSessionCookie(res, token, expires, req) {
  const secure = shouldUseSecureCookie(req);
  const parts = [
    `${COOKIE_NAME}=${token}`,
    `Path=${COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expires.toUTCString()}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res, req) {
  const secure = shouldUseSecureCookie(req);
  const parts = [
    `${COOKIE_NAME}=`,
    `Path=${COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}async function getAuth(req, res) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const session = await getSession(token);
  if (!session) {
    clearSessionCookie(res, req);
    return null;
  }
  const expiresAt = new Date(session.expires_at);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    await deleteSession(token);
    clearSessionCookie(res, req);
    return null;
  }
  const newExpires = new Date(Date.now() + SESSION_TTL_MS);
  await refreshSession(token, newExpires);
  setSessionCookie(res, token, newExpires, req);
  return {
    id: Number(session.user_id),
    surname: session.surname,
    name: session.name,
    role: session.role,
  };
}

async function requireAuth(req, res, roles = []) {
  const user = await getAuth(req, res);
  if (!user) {
    sendJson(res, 401, { error: "AUTH_REQUIRED" });
    return null;
  }
  if (roles.length && !roles.includes(user.role)) {
    sendJson(res, 403, { error: "FORBIDDEN" });
    return null;
  }
  return user;
}
async function wbRequest(store, endpoint, options = {}) {
  if (!store?.token) {
    throw new Error("WB_API_TOKEN is missing");
  }
  const { method = "GET", body } = options;
  const headers = {
    Authorization: `Bearer ${store.token}`,
    Accept: "application/json",
    "User-Agent": "my_sklad/1.0",
  };
  if (store.clientSecret) {
    headers["X-Client-Secret"] = store.clientSecret;
  }
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`WB API ${resp.status}: ${text.slice(0, 400)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function wbContentRequest(store, endpoint, body) {
  if (!store?.token) {
    throw new Error("WB_API_TOKEN is missing");
  }
  const resp = await fetch(`${CONTENT_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: store.token,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "my_sklad/1.0",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`WB Content ${resp.status}: ${text.slice(0, 400)}`);
  }
  if (!text) return null;
  return JSON.parse(text);
}

async function fetchAllProductCards(store) {
  const map = new Map();
  let updatedAt = null;
  let nmID = null;
  const limit = 100;
  const cache = getStoreCache(store?.id);

  for (let i = 0; i < 2000; i += 1) {
    const cursor = { limit };
    if (updatedAt) cursor.updatedAt = updatedAt;
    if (nmID) cursor.nmID = nmID;
    const body = {
      settings: {
        cursor,
        sort: { ascending: true },
        filter: { withPhoto: -1 },
      },
    };
    let data;
    try {
      data = await wbContentRequest(store, "/content/v2/get/cards/list", body);
    } catch (err) {
      const msg = err?.message || "";
      if (msg.includes("429")) {
        cache.contentBackoffUntil = Date.now() + 60_000;
        break;
      }
      throw err;
    }
    const cards = Array.isArray(data?.cards) ? data.cards : [];
    for (const card of cards) {
      const vendorCode = normalizeArticleKey(card?.vendorCode);
      if (!vendorCode) continue;
      const title = card.title || card.subjectName || card.brand || null;
      const barcodes = [];
      if (Array.isArray(card.sizes)) {
        for (const size of card.sizes) {
          const skus = normalizeSkus(size?.skus);
          for (const sku of skus) {
            if (!barcodes.includes(sku)) barcodes.push(sku);
          }
        }
      }
      map.set(vendorCode, { ts: Date.now(), title, barcodes });
    }

    const nextUpdatedAt = data?.cursor?.updatedAt ?? null;
    const nextNmID = data?.cursor?.nmID ?? null;
    const total = data?.cursor?.total ?? cards.length;

    if (cards.length === 0 || total < limit) break;
    if (!nextUpdatedAt && !nextNmID) break;
    if (nextUpdatedAt === updatedAt && nextNmID === nmID) break;
    updatedAt = nextUpdatedAt;
    nmID = nextNmID;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return map;
}

async function getCardsCache(store, force = false) {
  const cache = getStoreCache(store?.id);
  if (!force && cache.cardsCache.map.size > 0 && Date.now() - cache.cardsCache.ts < CARDS_CACHE_MS) {
    return cache.cardsCache.map;
  }
  if (cache.cardsCache.loading) return cache.cardsCache.loading;
  cache.cardsCache.loading = (async () => {
    const map = await fetchAllProductCards(store);
    cache.cardsCache.map = map;
    cache.cardsCache.ts = Date.now();
    saveCardsCacheToDisk(store?.id, map);
    cache.cardsCache.loading = null;
    return map;
  })();
  try {
    return await cache.cardsCache.loading;
  } catch (err) {
    cache.cardsCache.loading = null;
    throw err;
  }
}

async function fetchProductInfoBySearch(store, search, options = {}) {
  const query = normalizeArticleKey(search);
  if (!query) return null;
  const body = {
    settings: {
      cursor: { limit: 10 },
      filter: { textSearch: query, withPhoto: -1 },
    },
  };
  const data = await wbContentRequest(store, "/content/v2/get/cards/list", body);
  const cards = Array.isArray(data?.cards) ? data.cards : [];
  if (cards.length === 0) return null;

  const expectedVendor = normalizeArticleKey(options.expectedVendorCode || null);
  const expectedNmIdRaw = options.expectedNmId ?? null;
  const expectedNmId = expectedNmIdRaw === null || expectedNmIdRaw === undefined ? null : Number(expectedNmIdRaw);
  let card = null;

  if (expectedVendor) {
    const lower = expectedVendor.toLowerCase();
    card = cards.find(
      (c) => String(normalizeArticleKey(c.vendorCode || "") || "").toLowerCase() === lower
    );
  }
  if (!card && Number.isFinite(expectedNmId)) {
    card = cards.find((c) => Number(c.nmID ?? c.nmId ?? c.nm_id) === expectedNmId);
  }
  if (!card) {
    card = cards[0] || null;
  }
  if (!card) return null;

  return extractCardInfo(card);
}

async function fetchProductInfoByArticle(store, article) {
  const primary = await fetchProductInfoBySearch(store, article, { expectedVendorCode: article });
  if (primary && primary.title) return primary;
  const fallback = await fetchProductInfoFromTrash(store, article);
  if (!fallback) return primary;
  if (!primary) return fallback;
  return {
    title: primary.title || fallback.title || null,
    barcodes: (primary.barcodes && primary.barcodes.length ? primary.barcodes : fallback.barcodes) || [],
    vendorCode: primary.vendorCode || fallback.vendorCode || null,
    nmId: primary.nmId || fallback.nmId || null,
  };
}

async function fetchProductInfoFromTrash(store, article) {
  const search = normalizeArticleKey(article);
  if (!search) return null;
  const cache = getStoreCache(store?.id);
  if (Date.now() < cache.contentBackoffUntil) return null;

  try {
    const body = {
      settings: {
        cursor: { limit: 20 },
        filter: { textSearch: search, withPhoto: -1 },
        sort: { ascending: true },
      },
    };
    const data = await wbContentRequest(store, "/content/v2/get/cards/trash", body);
    const cards = Array.isArray(data?.cards) ? data.cards : [];
    const lower = search.toLowerCase();
    const match = cards.find(
      (c) => String(normalizeArticleKey(c.vendorCode || "") || "").toLowerCase() === lower
    );
    if (match) return extractCardInfo(match);
  } catch (err) {
    const msg = err?.message || "";
    if (msg.includes("429")) {
      cache.contentBackoffUntil = Date.now() + 60_000;
      return null;
    }
  }

  let cursor = { limit: 100 };
  const maxPages = 20;
  for (let page = 0; page < maxPages; page += 1) {
    let data = null;
    try {
      const body = { settings: { cursor, sort: { ascending: true } } };
      data = await wbContentRequest(store, "/content/v2/get/cards/trash", body);
    } catch (err) {
      const msg = err?.message || "";
      if (msg.includes("429")) {
        cache.contentBackoffUntil = Date.now() + 60_000;
      }
      break;
    }
    const cards = Array.isArray(data?.cards) ? data.cards : [];
    const lower = search.toLowerCase();
    const match = cards.find(
      (c) => String(normalizeArticleKey(c.vendorCode || "") || "").toLowerCase() === lower
    );
    if (match) return extractCardInfo(match);
    const next = data?.cursor || {};
    if (!cards.length) break;
    if (!next.trashedAt && !next.nmID) break;
    cursor = { limit: cursor.limit, trashedAt: next.trashedAt, nmID: next.nmID };
    await new Promise((resolve) => setTimeout(resolve, 650));
  }

  return null;
}

async function resolveProductInfo(store, articles, options = {}) {
  const unique = Array.from(new Set((articles || []).map(normalizeArticleKey).filter(Boolean)));
  const forceArticles = options?.forceArticles instanceof Set ? options.forceArticles : new Set();
  const results = new Map();
  const missing = [];
  const now = Date.now();
  const cache = getStoreCache(store?.id);
  const cardsMap = cache.cardsCache.map;
  const hasCardsCache = cardsMap.size > 0;
  const cardsFresh = hasCardsCache && now - cache.cardsCache.ts < CARDS_CACHE_MS;

  for (const article of unique) {
    const cached = cache.productCache.get(article);
    const age = cached ? now - cached.ts : Infinity;
    const isFresh = cached && age < PRODUCT_CACHE_MS;
    const hasData = cached && (cached.title || (cached.barcodes && cached.barcodes.length));
    if (cached && isFresh && hasData) {
      results.set(article, cached);
      continue;
    }
    if (cached && cached.missing && age < PRODUCT_NEGATIVE_CACHE_MS && !forceArticles.has(article)) {
      if (hasCardsCache) {
        const card = cardsMap.get(article);
        if (card && (card.title || (card.barcodes && card.barcodes.length))) {
          const payload = {
            ts: Date.now(),
            title: card.title || null,
            barcodes: Array.isArray(card.barcodes) ? card.barcodes : [],
          };
          results.set(article, payload);
          cache.productCache.set(article, payload);
        }
      }
      continue;
    }
    if (hasCardsCache) {
      const card = cardsMap.get(article);
      if (card && (card.title || (card.barcodes && card.barcodes.length))) {
        const payload = {
          ts: Date.now(),
          title: card.title || null,
          barcodes: Array.isArray(card.barcodes) ? card.barcodes : [],
        };
        results.set(article, payload);
        cache.productCache.set(article, payload);
        continue;
      }
    }
    missing.push(article);
  }

  if (missing.length === 0) {
    return results;
  }

  if (!cardsFresh && !cache.cardsCache.loading) {
    getCardsCache(store, true).catch(() => {});
  }

  if (now < cache.contentBackoffUntil) {
    return results;
  }

  const maxPerBatch = PRODUCT_RESOLVE_BATCH;
  for (let i = 0; i < Math.min(missing.length, maxPerBatch); i += 1) {
    const article = missing[i];
    try {
      const info = await fetchProductInfoByArticle(store, article);
      if (info) {
        const payload = {
          ts: Date.now(),
          title: info.title || null,
          barcodes: Array.isArray(info.barcodes) ? info.barcodes : [],
        };
        cache.productCache.set(article, payload);
        results.set(article, payload);
      } else {
        cache.productCache.set(article, { ts: Date.now(), title: null, barcodes: [], missing: true });
      }
    } catch (err) {
      const msg = err?.message || "";
      if (msg.includes("429")) {
        cache.contentBackoffUntil = Date.now() + 60_000;
        break;
      }
    }
  }

  return results;
}

async function resolveProductInfoForOrders(store, orders) {
  const forceArticles = new Set();
  const list = [];
  for (const order of orders || []) {
    const article = normalizeArticleKey(order?.article);
    if (!article) continue;
    list.push(article);
    const rawName = order?.product_name || order?.productName || "";
    if (isPlaceholderName(rawName, article)) {
      forceArticles.add(article);
    }
  }
  const infoMap = await resolveProductInfo(store, list, { forceArticles });
  const cache = getStoreCache(store?.id);
  const now = Date.now();
  if (now < cache.contentBackoffUntil) {
    return infoMap;
  }

  const missingArticles = new Set();
  for (const order of orders || []) {
    const article = normalizeArticleKey(order?.article);
    if (!article) continue;
    if (infoMap.has(article)) continue;
    missingArticles.add(article);
  }
  if (missingArticles.size > 0 && (!cache.cardsCache.map.size || now - cache.cardsCache.ts > CARDS_CACHE_MS)) {
    try {
      await getCardsCache(store, true);
    } catch {}
  }
  if (missingArticles.size > 0 && cache.cardsCache.map.size) {
    for (const article of missingArticles) {
      if (infoMap.has(article)) continue;
      const card = cache.cardsCache.map.get(article);
      if (card && (card.title || (card.barcodes && card.barcodes.length))) {
        const payload = {
          ts: Date.now(),
          title: card.title || null,
          barcodes: Array.isArray(card.barcodes) ? card.barcodes : [],
        };
        cache.productCache.set(article, payload);
        infoMap.set(article, payload);
      }
    }
  }

  const missing = (orders || []).filter((order) => {
    const article = normalizeArticleKey(order?.article);
    if (!article) return false;
    if (infoMap.has(article)) return false;
    const nmId = order?.nmId ?? order?.nmID ?? order?.nm_id ?? null;
    return nmId !== null && nmId !== undefined;
  });
  if (!missing.length) return infoMap;

  const byNmId = new Map();
  for (const order of missing) {
    const nmId = order?.nmId ?? order?.nmID ?? order?.nm_id ?? null;
    const article = normalizeArticleKey(order?.article);
    if (!article || nmId === null || nmId === undefined) continue;
    const key = String(nmId);
    if (!byNmId.has(key)) byNmId.set(key, new Set());
    byNmId.get(key).add(article);
  }

  const maxPerBatch = Math.max(5, Math.floor(PRODUCT_RESOLVE_BATCH / 2));
  let processed = 0;
  for (const [nmId, articles] of byNmId) {
    if (processed >= maxPerBatch) break;
    processed += 1;
    try {
      const info = await fetchProductInfoBySearch(store, nmId, { expectedNmId: Number(nmId) });
      if (!info) continue;
      if (info.nmId !== null && info.nmId !== undefined && Number(info.nmId) !== Number(nmId)) {
        continue;
      }
      const payload = {
        ts: Date.now(),
        title: info.title || null,
        barcodes: Array.isArray(info.barcodes) ? info.barcodes : [],
      };
      for (const article of articles) {
        cache.productCache.set(article, payload);
        infoMap.set(article, payload);
      }
    } catch (err) {
      const msg = err?.message || "";
      if (msg.includes("429")) {
        cache.contentBackoffUntil = Date.now() + 60_000;
        break;
      }
    }
  }

  return infoMap;
}

async function ensureStickerBarcode(supplyId, orderId) {
  const existing = await dbQuery(
    "select sticker_barcode from supply_orders where supply_id = $1 and wb_order_id = $2",
    [supplyId, orderId]
  );
  const current = existing.rows?.[0]?.sticker_barcode || null;
  if (current) return current;
  const store = await getSupplyStore(supplyId);
  const data = await wbRequest(
    store,
    `/api/v3/orders/stickers?type=${LABEL_TYPE}&width=${LABEL_WIDTH}&height=${LABEL_HEIGHT}`,
    {
      method: "POST",
      body: { orders: [Number(orderId)] },
    }
  );
  const sticker = Array.isArray(data?.stickers) ? data.stickers[0] : null;
  const barcode = sticker?.barcode || null;
  if (barcode) {
    await dbQuery(
      "update supply_orders set sticker_barcode = $3, updated_at = now() where supply_id = $1 and wb_order_id = $2",
      [supplyId, orderId, barcode]
    );
  }
  return barcode;
}

async function refreshNewOrders(store) {
  const data = await wbRequest(store, "/api/v3/orders/new");
  const orders = Array.isArray(data?.orders) ? data.orders : [];
  const normalized = orders
    .map((order) => normalizeOrder(order))
    .filter((o) => o && o.id && o.createdAt)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const infoMap = await resolveProductInfoForOrders(store, normalized);
  const enriched = normalized.map((order) => {
    const info = infoMap.get(order.article);
    const barcode = order.barcode || info?.barcodes?.[0] || null;
    const currentName = order.productName;
    const needsName = isPlaceholderName(currentName, order.article);
    return {
      ...order,
      productName: needsName ? info?.title || null : currentName,
      barcode,
    };
  });
  const cache = getStoreCache(store?.id).newOrders;
  Object.assign(cache, { ts: Date.now(), data: enriched, error: null });
  return enriched;
}

async function getNewOrders(storeId) {
  const store = resolveStore(storeId);
  const cache = getStoreCache(store?.id).newOrders;
  if (cacheFresh(cache, CACHE_NEW_ORDERS_MS)) return cache.data;
  if (cacheHasData(cache)) {
    if (!cache.loading) {
      cache.loading = refreshNewOrders(store)
        .catch((err) => {
          cache.error = err.message;
        })
        .finally(() => {
          cache.loading = null;
        });
    }
    return cache.data;
  }
  try {
    return await refreshNewOrders(store);
  } catch (err) {
    Object.assign(cache, { ts: Date.now(), error: err.message });
    throw err;
  }
}

async function fetchOrdersRange(store) {
  const nowSec = Math.floor(Date.now() / 1000);
  const dateFrom = nowSec - 30 * 24 * 3600;
  const limit = 1000;
  let next = 0;
  const all = [];
  for (let i = 0; i < 50; i += 1) {
    const resp = await wbRequest(
      store,
      `/api/v3/orders?limit=${limit}&next=${next}&dateFrom=${dateFrom}&dateTo=${nowSec}`
    );
    const orders = Array.isArray(resp?.orders) ? resp.orders : [];
    all.push(...orders);
    if (!resp?.next || resp.next === next || orders.length === 0) break;
    next = resp.next;
  }
  return all;
}

async function refreshOrders(store) {
  const orders = await fetchOrdersRange(store);
  const normalized = orders
    .map((order) => normalizeOrder(order))
    .filter((o) => o && o.id && o.createdAt);
  const infoMap = await resolveProductInfoForOrders(store, normalized);
  const enriched = normalized.map((order) => {
    const info = infoMap.get(order.article);
    const barcode = order.barcode || info?.barcodes?.[0] || null;
    const currentName = order.productName;
    const needsName = isPlaceholderName(currentName, order.article);
    return {
      ...order,
      productName: needsName ? info?.title || null : currentName,
      barcode,
    };
  });
  const cache = getStoreCache(store?.id).orders;
  Object.assign(cache, { ts: Date.now(), data: enriched, error: null });
  return enriched;
}

async function getOrders(storeId) {
  const store = resolveStore(storeId);
  const cache = getStoreCache(store?.id).orders;
  if (cacheFresh(cache, CACHE_ORDERS_MS)) return cache.data;
  if (cacheHasData(cache)) {
    if (!cache.loading) {
      cache.loading = refreshOrders(store)
        .catch((err) => {
          cache.error = err.message;
        })
        .finally(() => {
          cache.loading = null;
        });
    }
    return cache.data;
  }
  try {
    return await refreshOrders(store);
  } catch (err) {
    Object.assign(cache, { ts: Date.now(), error: err.message });
    throw err;
  }
}

async function fetchSupplies(store) {
  const limit = 1000;
  let next = 0;
  const all = [];
  for (let i = 0; i < 50; i += 1) {
    const resp = await wbRequest(store, `/api/v3/supplies?limit=${limit}&next=${next}`);
    const supplies = Array.isArray(resp?.supplies) ? resp.supplies : [];
    all.push(...supplies);
    if (!resp?.next || resp.next === next || supplies.length === 0) break;
    next = resp.next;
  }
  return all;
}

async function fetchSupplyOrders(store, supplyId) {
  const limit = 1000;
  let next = 0;
  const all = [];
  for (let i = 0; i < 50; i += 1) {
    let resp;
    try {
      resp = await wbRequest(
        store,
        `/api/v3/supplies/${encodeURIComponent(supplyId)}/orders?limit=${limit}&next=${next}`
      );
    } catch {
      resp = await wbRequest(
        store,
        `/api/marketplace/v3/supplies/${encodeURIComponent(supplyId)}/orders?limit=${limit}&next=${next}`
      );
    }
    const orders = Array.isArray(resp?.orders)
      ? resp.orders
      : Array.isArray(resp?.data?.orders)
      ? resp.data.orders
      : Array.isArray(resp?.data)
      ? resp.data
      : Array.isArray(resp)
      ? resp
      : [];
    all.push(...orders);
    const respNext = resp?.next ?? resp?.data?.next ?? null;
    if (!respNext || respNext === next || orders.length === 0) break;
    next = respNext;
  }
  return all;
}

async function refreshSupplies(store) {
  const supplies = await fetchSupplies(store);

  const normalized = supplies
    .filter((s) => s && s.id)
    .map((s) => {
      const supplyId = normalizeSupplyId(s.id);
      return {
        id: supplyId,
        createdAt: s.createdAt,
        name: s.name,
        done: s.done,
        storeId: store?.id || null,
        storeName: store?.name || null,
      };
    })
    .filter((s) => s.done === false || s.done === 0 || s.done === null || s.done === undefined)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  if (normalized.length) {
    await Promise.all(
      normalized.map((supply) => ensureSupplySettings(supply.id, supply.name || null, store))
    );
    const supplyIds = normalized.map((item) => item.id);
    const aggregates = await getSupplyAggregates(supplyIds);
    const accessStats = await getSupplyAccessStats(supplyIds);
    for (const supply of normalized) {
      const agg = aggregates.get(supply.id);
      if (agg) {
        supply.orderCount = agg.orderCount;
        supply.itemCount = agg.itemCount;
        supply.collectedCount = agg.collectedCount;
        supply.remainingCount = Math.max(0, agg.orderCount - agg.collectedCount);
        supply.assignedUsers = agg.assignedUsers;
      } else {
        supply.orderCount = 0;
        supply.itemCount = 0;
        supply.collectedCount = 0;
        supply.remainingCount = 0;
        supply.assignedUsers = 0;
      }
      supply.accessUserCount = accessStats.accessUsers.get(supply.id) || 0;
      supply.accessMode = accessStats.accessModes.get(supply.id) || "hidden";
      if (!agg || agg.orderCount === 0) {
        ensureSupplySnapshotIfStale(supply.id, supply.name || null).catch(() => {});
      }
    }
  }

  const cache = getStoreCache(store?.id).supplies;
  Object.assign(cache, { ts: Date.now(), data: normalized, error: null });
  return normalized;
}

async function getSupplies(storeId) {
  const store = resolveStore(storeId);
  const cache = getStoreCache(store?.id).supplies;
  if (cacheFresh(cache, CACHE_SUPPLIES_MS)) return cache.data;
  if (cacheHasData(cache)) {
    if (!cache.loading) {
      cache.loading = refreshSupplies(store)
        .catch((err) => {
          cache.error = err.message;
        })
        .finally(() => {
          cache.loading = null;
        });
    }
    return cache.data;
  }
  try {
    return await refreshSupplies(store);
  } catch (err) {
    Object.assign(cache, { ts: Date.now(), error: err.message });
    throw err;
  }
}

function resolveSettingsStoreId(settings) {
  return normalizeStoreId(settings?.store_id) || DEFAULT_STORE?.id || null;
}

async function getActiveSupplyIdSet(storeId) {
  if (!storeId) return null;
  try {
    const supplies = await getSupplies(storeId);
    return new Set((supplies || []).map((supply) => supply.id));
  } catch {
    return null;
  }
}

async function isSupplyActiveForSettings(supplyId, settings) {
  const storeId = resolveSettingsStoreId(settings);
  if (!storeId) return true;
  const activeSet = await getActiveSupplyIdSet(storeId);
  if (!activeSet) return true;
  return activeSet.has(supplyId);
}

async function getSupplyOrders(supplyId, supplyName = null) {
  const normalizedId = normalizeSupplyId(supplyId);
  if (!normalizedId) return [];
  const store = await getSupplyStore(normalizedId, supplyName);
  await ensureSupplySettings(normalizedId, supplyName, store);
  await ensureSupplySnapshotIfStale(normalizedId, supplyName);
  const result = await dbQuery(
    `select wb_order_id, order_created_at, article, barcode, product_name, nm_id, quantity
     from supply_orders
     where supply_id = $1
     order by order_created_at asc, wb_order_id asc`,
    [normalizedId]
  );
  const rows = result.rows || [];
  if (rows.length) {
    await fillMissingOrderInfo(normalizedId, rows, store);
  }
  return rows.map((o) => ({
    id: Number(o.wb_order_id),
    createdAt: o.order_created_at,
    article: o.article ?? null,
    nmId: o.nm_id ?? null,
    quantity: o.quantity ?? 1,
    productName: o.product_name ?? null,
    barcode: o.barcode ?? null,
  }));
}

async function createSupply(store, name, orderIds) {
  let created = null;
  let useLegacy = false;
  try {
    created = await wbRequest(store, "/api/v3/supplies", {
      method: "POST",
      body: { name },
    });
  } catch (err) {
    created = await wbRequest(store, "/api/marketplace/v3/supplies", {
      method: "POST",
      body: { name },
    });
    useLegacy = true;
  }
  const supplyId = normalizeSupplyId(created?.id);
  if (!supplyId) {
    throw new Error("Не удалось создать поставку");
  }
  const batchSize = Number.isFinite(ORDER_BATCH_SIZE) && ORDER_BATCH_SIZE > 0 ? ORDER_BATCH_SIZE : 100;
  const uniqueOrders = Array.from(new Set(orderIds));

  const addBatch = async (batch) => {
    if (useLegacy) {
      await wbRequest(store, `/api/marketplace/v3/supplies/${encodeURIComponent(supplyId)}/orders`, {
        method: "PATCH",
        body: { orders: batch },
      });
      return;
    }
    try {
      await wbRequest(store, `/api/v3/supplies/${encodeURIComponent(supplyId)}/orders`, {
        method: "PATCH",
        body: { orders: batch },
      });
    } catch (err) {
      await wbRequest(store, `/api/marketplace/v3/supplies/${encodeURIComponent(supplyId)}/orders`, {
        method: "PATCH",
        body: { orders: batch },
      });
      useLegacy = true;
    }
  };

  const added = [];
  const failed = [];
  const addWithSplit = async (batch) => {
    try {
      await addBatch(batch);
      added.push(...batch);
      return;
    } catch (err) {
      if (batch.length <= 1) {
        failed.push({ id: batch[0], error: err?.message || "WB error" });
        return;
      }
      const mid = Math.ceil(batch.length / 2);
      await addWithSplit(batch.slice(0, mid));
      await addWithSplit(batch.slice(mid));
    }
  };

  for (let i = 0; i < uniqueOrders.length; i += batchSize) {
    const batch = uniqueOrders.slice(i, i + batchSize);
    await addWithSplit(batch);
    if (i + batchSize < uniqueOrders.length) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  try {
    await ensureSupplySettings(supplyId, name, store);
    await refreshSupplySnapshot(supplyId, name);
  } catch {
    // ignore snapshot failures
  }

  const cache = getStoreCache(store?.id);
  cache.newOrders.ts = 0;
  cache.orders.ts = 0;
  cache.supplies.ts = 0;
  const failedIds = failed.slice(0, 20).map((item) => item.id);
  const failedReason = failed[0]?.error || null;
  return {
    supplyId,
    addedCount: added.length,
    failedCount: failed.length,
    failedIds,
    failedReason,
  };
}

async function handleApi(req, res, pathname, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS" });
    res.end();
    return;
  }

    if (pathname === "/api/health") {
      sendJson(res, 200, { ok: true, time: new Date().toISOString() });
      return;
    }

    if (pathname === "/api/stores") {
      const auth = await requireAuth(req, res, [ROLE_ADMIN]);
      if (!auth) return;
      sendJson(res, 200, {
        stores: storeList.map((store) => ({ id: store.id, name: store.name })),
        defaultStoreId: DEFAULT_STORE?.id || null,
      });
      return;
    }

  try {
    if (pathname === "/api/auth/login" && req.method === "POST") {
      const body = await readJson(req);
      const surname = normalizeText(body?.surname);
      const password = typeof body?.password === "string" ? body.password : "";
      if (!surname || !password) {
        sendJson(res, 400, { error: "Введите фамилию и пароль" });
        return;
      }
      const users = await findUserBySurname(surname);
      const matched = users.find((user) => verifyPassword(password, user.password_salt, user.password_hash));
      if (!matched) {
        sendJson(res, 401, { error: "Неверные данные для входа" });
        return;
      }
      const session = await createSession(matched.id);
      setSessionCookie(res, session.token, session.expires, req);
      sendJson(res, 200, { user: toPublicUser(matched) });
      return;
    }

    if (pathname === "/api/auth/logout") {
      const cookies = parseCookies(req.headers.cookie || "");
      const token = cookies[COOKIE_NAME];
      if (token) {
        await deleteSession(token);
      }
      clearSessionCookie(res, req);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/auth/me") {
      const user = await getAuth(req, res);
      if (!user) {
        // Return 200 to avoid noisy console errors on initial auth check.
        sendJson(res, 200, { user: null });
        return;
      }
      sendJson(res, 200, { user });
      return;
    }

    if (pathname === "/api/links/wb-articles") {
      const auth = await requireAuth(req, res, [ROLE_ADMIN]);
      if (!auth) return;
      const store = getStoreFromRequest(req);
      const force = url?.searchParams?.get("force") === "1";
      const cardsMap = await getCardsCache(store, force);
      const items = Array.from(cardsMap.entries()).map(([article, info]) => ({
        article,
        title: info?.title || null,
        wbBarcodes: Array.isArray(info?.barcodes) ? info.barcodes : [],
      }));
      items.sort((a, b) => a.article.localeCompare(b.article, "ru-RU"));
      sendJson(res, 200, { updatedAt: new Date().toISOString(), items });
      return;
    }

    if (pathname === "/api/links/ms-barcodes" && req.method === "POST") {
      const auth = await requireAuth(req, res, [ROLE_ADMIN]);
      if (!auth) return;
      const body = await readJson(req);
      const raw = Array.isArray(body?.articles) ? body.articles : [];
      const articles = raw.map(normalizeArticleKey).filter(Boolean);
      if (articles.length === 0) {
        sendJson(res, 200, { items: [] });
        return;
      }
      const unique = Array.from(new Set(articles));
      const results = new Map();
      const concurrency = 6;
      for (let i = 0; i < unique.length; i += concurrency) {
        const batch = unique.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map(async (article) => {
            try {
              const info = await getMsProductStatusByArticle(article);
              return { article, barcodes: info.barcodes || [], found: info.found };
            } catch (err) {
              return { article, barcodes: [], found: false, error: err?.message || "MS error" };
            }
          })
        );
        for (const item of batchResults) {
          results.set(item.article, item);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const items = articles.map((article) => {
        const entry = results.get(article);
        if (!entry) return { article, barcodes: [], missing: true };
        return {
          article,
          barcodes: entry.barcodes || [],
          missing: !entry.found,
          error: entry.error || null,
        };
      });
      sendJson(res, 200, { items });
      return;
    }

    if (pathname === "/api/events") {
      const auth = await requireAuth(req, res, [ROLE_SUPER, ROLE_ADMIN, ROLE_EMPLOYEE]);
      if (!auth) return;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (res.flushHeaders) res.flushHeaders();
      addSseClient(res, auth);
      return;
    }

    if (pathname === "/api/users" && req.method === "GET") {
      const auth = await requireAuth(req, res, [ROLE_SUPER, ROLE_ADMIN]);
      if (!auth) return;
      let roleFilter = null;
      if (auth.role === ROLE_ADMIN) {
        roleFilter = ROLE_EMPLOYEE;
      } else {
        const requested = url?.searchParams?.get("role");
        if ([ROLE_ADMIN, ROLE_EMPLOYEE, ROLE_SUPER].includes(requested)) {
          roleFilter = requested;
        }
      }
      let query = "select id, surname, name, role, created_at from users";
      const params = [];
      if (roleFilter) {
        query += " where role = $1";
        params.push(roleFilter);
      }
      query += " order by created_at desc";
      const result = await dbQuery(query, params);
      sendJson(res, 200, { users: (result.rows || []).map(toPublicUser) });
      return;
    }

    if (pathname === "/api/users" && req.method === "POST") {
      const auth = await requireAuth(req, res, [ROLE_SUPER, ROLE_ADMIN]);
      if (!auth) return;
      const body = await readJson(req);
      const surname = normalizeText(body?.surname);
      const name = normalizeText(body?.name);
      const password = typeof body?.password === "string" ? body.password : "";
      let role = body?.role;
      if (auth.role === ROLE_ADMIN) {
        role = ROLE_EMPLOYEE;
      }
      if (!surname || !name || !password) {
        sendJson(res, 400, { error: "Заполните фамилию, имя и пароль" });
        return;
      }
      if (![ROLE_ADMIN, ROLE_EMPLOYEE].includes(role)) {
        sendJson(res, 400, { error: "Некорректная роль" });
        return;
      }
      await ensureUniqueSurnamePassword(surname, password);
      const hashed = createPasswordHash(password);
      const result = await dbQuery(
        "insert into users (surname, name, role, password_hash, password_salt, created_at, updated_at) values ($1, $2, $3, $4, $5, now(), now()) returning id, surname, name, role, created_at",
        [surname, name, role, hashed.hash, hashed.salt]
      );
      sendJson(res, 200, { user: toPublicUser(result.rows[0]) });
      return;
    }

    const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
    if (userMatch) {
      const userId = Number(userMatch[1]);
      const auth = await requireAuth(req, res, [ROLE_SUPER, ROLE_ADMIN]);
      if (!auth) return;
      const target = await findUserById(userId);
      if (!target) {
        sendJson(res, 404, { error: "Пользователь не найден" });
        return;
      }
      if (auth.role === ROLE_ADMIN && target.role !== ROLE_EMPLOYEE) {
        sendJson(res, 403, { error: "FORBIDDEN" });
        return;
      }

      if (req.method === "DELETE") {
        if (auth.id === target.id) {
          sendJson(res, 400, { error: "Нельзя удалить себя" });
          return;
        }
        await dbQuery("delete from users where id = $1", [target.id]);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "PATCH") {
        const body = await readJson(req);
        const surname = body?.surname !== undefined ? normalizeText(body.surname) : target.surname;
        const name = body?.name !== undefined ? normalizeText(body.name) : target.name;
        const password = typeof body?.password === "string" ? body.password : "";
        if (!surname || !name) {
          sendJson(res, 400, { error: "Фамилия и имя обязательны" });
          return;
        }
        if (password) {
          await ensureUniqueSurnamePassword(surname, password, target.id);
        } else if (surname !== target.surname) {
          const sameSurname = await findUserBySurname(surname);
          const hasOther = sameSurname.some((u) => Number(u.id) !== Number(target.id));
          if (hasOther) {
            sendJson(res, 400, { error: "При смене фамилии на уже существующую задайте новый пароль" });
            return;
          }
        }

        const fields = ["surname = $1", "name = $2", "updated_at = now()"];
        const values = [surname, name];
        let paramIndex = 3;
        if (password) {
          const hashed = createPasswordHash(password);
          fields.push(`password_hash = ${paramIndex++}`);
          values.push(hashed.hash);
          fields.push(`password_salt = ${paramIndex++}`);
          values.push(hashed.salt);
        }
        values.push(target.id);
        const query = `update users set ${fields.join(", ")} where id = ${paramIndex} returning id, surname, name, role, created_at`;
        const result = await dbQuery(query, values);
        sendJson(res, 200, { user: toPublicUser(result.rows[0]) });
        return;
      }
    }

    const settingsMatch = pathname.match(/^\/api\/supplies\/([^/]+)\/settings$/);
    if (settingsMatch) {
      const auth = await requireAuth(req, res, [ROLE_ADMIN]);
      if (!auth) return;
      const supplyId = decodeURIComponent(settingsMatch[1]);
      await getSupplyStore(supplyId);
      await ensureSupplySnapshotIfStale(supplyId);
      if (req.method === "PATCH") {
        const body = await readJson(req);
        const accessMode = typeof body?.accessMode === "string" ? body.accessMode : null;
        if (!["hidden", "all", "selected", "selected_split"].includes(accessMode)) {
          sendJson(res, 400, { error: "Некорректный режим доступа" });
          return;
        }
        await setSupplyAccessMode(supplyId, accessMode);
        if (accessMode === "all" || accessMode === "hidden") {
          await dbQuery("delete from supply_access_users where supply_id = $1", [supplyId]);
        }
        if (accessMode !== "selected_split") {
          await dbQuery(
            "update supply_orders set assigned_user_id = null, assigned_at = null where supply_id = $1 and collected_at is null",
            [supplyId]
          );
        }
        notifySupplyUpdate(supplyId, true);
      }
      const settings = await getSupplySettings(supplyId);
      const totalResult = await dbQuery(
        `select count(*) as total,
                count(*) filter (where collected_at is not null) as collected
         from supply_orders
         where supply_id = $1`,
        [supplyId]
      );
      const totalOrders = Number(totalResult.rows?.[0]?.total || 0);
      const collectedOrders = Number(totalResult.rows?.[0]?.collected || 0);
      const remainingOrders = Math.max(0, totalOrders - collectedOrders);
      const effectiveLabelsTotal =
        settings && settings.labels_total && Number(settings.labels_total) > 0
          ? Number(settings.labels_total)
          : totalOrders;
      const accessUserIds = await getSupplyAccessUserIds(supplyId);
      const employees = (await listEmployees()).map(toEmployeeUser);
      const progress = await getSupplyProgress(supplyId, settings?.access_mode);
      sendJson(res, 200, {
        settings: settings
          ? {
              supplyId: settings.supply_id,
              supplyName: settings.supply_name,
              accessMode: settings.access_mode,
              labelsStatus: settings.labels_status,
              labelsFormat: settings.labels_format,
              labelsTotal: effectiveLabelsTotal,
              labelsLoaded: settings.labels_loaded,
              labelsError: settings.labels_error,
              storeId: settings.store_id,
              storeName: settings.store_name,
              labelsStartedAt: settings.labels_started_at,
              labelsFinishedAt: settings.labels_finished_at,
            }
          : null,
        totals: {
          total: totalOrders,
          collected: collectedOrders,
          remaining: remainingOrders,
        },
        accessUserIds,
        employees,
        progress,
      });
      return;
    }

    const accessMatch = pathname.match(/^\/api\/supplies\/([^/]+)\/access$/);
    if (accessMatch && req.method === "POST") {
      const auth = await requireAuth(req, res, [ROLE_ADMIN]);
      if (!auth) return;
      const supplyId = decodeURIComponent(accessMatch[1]);
      const body = await readJson(req);
      const userIds = Array.isArray(body?.userIds)
        ? body.userIds.map((id) => Number(id)).filter((id) => Number.isFinite(id))
        : [];
      await getSupplyStore(supplyId);
      await setSupplyAccessUsers(supplyId, userIds);
      notifySupplyUpdate(supplyId, true);
      sendJson(res, 200, { ok: true });
      return;
    }

    const splitMatch = pathname.match(/^\/api\/supplies\/([^/]+)\/split$/);
    if (splitMatch && req.method === "POST") {
      const auth = await requireAuth(req, res, [ROLE_ADMIN]);
      if (!auth) return;
      const supplyId = decodeURIComponent(splitMatch[1]);
      await getSupplyStore(supplyId);
      await ensureSupplySnapshot(supplyId);
      const userIds = await getSupplyAccessUserIds(supplyId);
      if (!userIds.length) {
        sendJson(res, 400, { error: "Не выбраны сотрудники" });
        return;
      }
      await setSupplyAccessMode(supplyId, "selected_split");
      const result = await splitSupplyOrders(supplyId, userIds, "split");
      notifySupplyUpdate(supplyId, true);
      sendJson(res, 200, result);
      return;
    }

    const redistributeMatch = pathname.match(/^\/api\/supplies\/([^/]+)\/redistribute$/);
    if (redistributeMatch && req.method === "POST") {
      const auth = await requireAuth(req, res, [ROLE_ADMIN]);
      if (!auth) return;
      const supplyId = decodeURIComponent(redistributeMatch[1]);
      await getSupplyStore(supplyId);
      await ensureSupplySnapshot(supplyId);
      const userIds = await getSupplyAccessUserIds(supplyId);
      if (!userIds.length) {
        sendJson(res, 400, { error: "Не выбраны сотрудники" });
        return;
      }
      await setSupplyAccessMode(supplyId, "selected_split");
      const result = await splitSupplyOrders(supplyId, userIds, "redistribute");
      notifySupplyUpdate(supplyId, true);
      sendJson(res, 200, result);
      return;
    }

    const resetMatch = pathname.match(/^\/api\/supplies\/([^/]+)\/reset-access$/);
    if (resetMatch && req.method === "POST") {
      const auth = await requireAuth(req, res, [ROLE_ADMIN]);
      if (!auth) return;
      const supplyId = decodeURIComponent(resetMatch[1]);
      await getSupplyStore(supplyId);
      await resetSupplyAccess(supplyId);
      notifySupplyUpdate(supplyId, true);
      sendJson(res, 200, { ok: true });
      return;
    }

    const labelsMatch = pathname.match(/^\/api\/supplies\/([^/]+)\/labels$/);
    if (labelsMatch && req.method === "POST") {
      const auth = await requireAuth(req, res, [ROLE_ADMIN]);
      if (!auth) return;
      const supplyId = decodeURIComponent(labelsMatch[1]);
      const body = await readJson(req);
      const force = body?.force === true;
      startLabelsJob(supplyId, body?.supplyName || null, force).catch(() => {});
      notifySupplyUpdate(supplyId, true);
      sendJson(res, 200, { ok: true });
      return;
    }

    const employeeSuppliesMatch = pathname === "/api/employee/supplies";
    if (employeeSuppliesMatch && req.method === "GET") {
      const auth = await requireAuth(req, res, [ROLE_EMPLOYEE]);
      if (!auth) return;
      const settingsResult = await dbQuery(
        "select supply_id, supply_name, access_mode, store_id, store_name from supply_settings where access_mode <> 'hidden'",
        []
      );
      const allSettings = settingsResult.rows || [];
      if (!allSettings.length) {
        sendJson(res, 200, { supplies: [] });
        return;
      }
      const storeIds = new Set();
      for (const setting of allSettings) {
        const storeId = resolveSettingsStoreId(setting);
        if (storeId) storeIds.add(storeId);
      }
      const activeByStore = new Map();
      await Promise.all(
        Array.from(storeIds).map(async (storeId) => {
          activeByStore.set(storeId, await getActiveSupplyIdSet(storeId));
        })
      );
      const accessResult = await dbQuery(
        "select supply_id from supply_access_users where user_id = $1",
        [auth.id]
      );
      const allowedSet = new Set(accessResult.rows.map((row) => row.supply_id));
      const supplies = [];
      for (const setting of allSettings) {
        const mode = setting.access_mode;
        if (mode === "hidden") continue;
        const storeKey = resolveSettingsStoreId(setting);
        const activeSet = storeKey ? activeByStore.get(storeKey) : null;
        if (activeSet && !activeSet.has(setting.supply_id)) {
          continue;
        }
        if ((mode === "selected" || mode === "selected_split") && !allowedSet.has(setting.supply_id)) {
          continue;
        }
        const isSplit = mode === "selected_split";
        const countResult = await dbQuery(
          `select count(*) as total,
                  count(*) filter (where collected_at is null) as remaining,
                  count(*) filter (where collected_at is not null) as collected
           from supply_orders
           where supply_id = $1 ${isSplit ? "and assigned_user_id = $2" : ""}`,
          isSplit ? [setting.supply_id, auth.id] : [setting.supply_id]
        );
        const counts = countResult.rows?.[0];
        const remaining = Number(counts?.remaining || 0);
        if (remaining < 1) continue;
        const store = resolveStore(normalizeStoreId(setting.store_id));
        supplies.push({
          id: setting.supply_id,
          name: setting.supply_name,
          accessMode: mode,
          storeId: setting.store_id || null,
          storeName: setting.store_name || store?.name || null,
          remaining,
          total: Number(counts?.total || 0),
          collected: Number(counts?.collected || 0),
        });
      }
      sendJson(res, 200, { supplies });
      return;
    }

    const employeeItemsMatch = pathname.match(/^\/api\/employee\/supplies\/([^/]+)\/items$/);
    if (employeeItemsMatch && req.method === "GET") {
      const auth = await requireAuth(req, res, [ROLE_EMPLOYEE]);
      if (!auth) return;
      const supplyId = decodeURIComponent(employeeItemsMatch[1]);
      const settings = await getSupplySettings(supplyId);
      if (!settings || settings.access_mode === "hidden") {
        sendJson(res, 404, { error: "Поставка недоступна" });
        return;
      }
      const store = await getSupplyStore(supplyId, settings.supply_name || null);
      if (["selected", "selected_split"].includes(settings.access_mode)) {
        const accessUserIds = await getSupplyAccessUserIds(supplyId);
        if (!accessUserIds.includes(Number(auth.id))) {
          sendJson(res, 403, { error: "FORBIDDEN" });
          return;
        }
      }
      if (!(await isSupplyActiveForSettings(supplyId, settings))) {
        sendJson(res, 404, { error: "Поставка недоступна" });
        return;
      }
      const countCheck = await dbQuery("select count(*) as count from supply_orders where supply_id = $1", [supplyId]);
      if (Number(countCheck.rows?.[0]?.count || 0) === 0) {
        await ensureSupplySnapshot(supplyId, settings.supply_name || null);
      }
      const isSplit = settings.access_mode === "selected_split";
      const result = await dbQuery(
        `select article, barcode, product_name, nm_id,
                count(*)::int as count
         from supply_orders
         where supply_id = $1 and collected_at is null ${isSplit ? "and assigned_user_id = $2" : ""}
         group by article, barcode, product_name, nm_id
         order by count desc`,
        isSplit ? [supplyId, auth.id] : [supplyId]
      );
      const items = (result.rows || []).map((row) => ({
        article: row.article,
        barcode: row.barcode,
        productName: row.product_name,
        nmId: row.nm_id,
        count: Number(row.count || 0),
      }));
      sendJson(res, 200, { items });
      return;
    }

    const employeeOrdersMatch = pathname.match(/^\/api\/employee\/supplies\/([^/]+)\/orders$/);
    if (employeeOrdersMatch && req.method === "GET") {
      const auth = await requireAuth(req, res, [ROLE_EMPLOYEE]);
      if (!auth) return;
      const supplyId = decodeURIComponent(employeeOrdersMatch[1]);
      const settings = await getSupplySettings(supplyId);
      if (!settings || settings.access_mode === "hidden") {
        sendJson(res, 404, { error: "Поставка недоступна" });
        return;
      }
      const store = await getSupplyStore(supplyId, settings.supply_name || null);
      if (["selected", "selected_split"].includes(settings.access_mode)) {
        const accessUserIds = await getSupplyAccessUserIds(supplyId);
        if (!accessUserIds.includes(Number(auth.id))) {
          sendJson(res, 403, { error: "FORBIDDEN" });
          return;
        }
      }
      if (!(await isSupplyActiveForSettings(supplyId, settings))) {
        sendJson(res, 404, { error: "Поставка недоступна" });
        return;
      }
      const countCheck = await dbQuery("select count(*) as count from supply_orders where supply_id = $1", [supplyId]);
      if (Number(countCheck.rows?.[0]?.count || 0) === 0) {
        await ensureSupplySnapshot(supplyId, settings.supply_name || null);
      }
      const params = [supplyId];
      let where = "supply_id = $1 and collected_at is null";
      if (settings.access_mode === "selected_split") {
        params.push(auth.id);
        where += " and assigned_user_id = $2";
      }
      const article = normalizeArticleKey(url?.searchParams?.get("article"));
      const barcode = normalizeText(url?.searchParams?.get("barcode"));
      const nmId = url?.searchParams?.get("nmId");
      if (article) {
        params.push(article);
        where += ` and article = $${params.length}`;
      }
      if (barcode) {
        params.push(barcode);
        where += ` and barcode = $${params.length}`;
      }
      if (nmId) {
        params.push(Number(nmId));
        where += ` and nm_id = $${params.length}`;
      }
      const result = await dbQuery(
        `select wb_order_id, order_created_at, article, barcode, product_name, nm_id,
                quantity, sticker_url, sticker_barcode,
                scan_passed_at, scan_barcode,
                label_scan_passed_at, label_scan_barcode
         from supply_orders
         where ${where}
         order by order_created_at asc`,
        params
      );
      const orders = await fillMissingOrderInfo(supplyId, result.rows || [], store);
      sendJson(res, 200, {
        orders: orders.map((row) => ({
          id: Number(row.wb_order_id),
          createdAt: row.order_created_at,
          article: row.article,
          barcode: row.barcode,
          productName: row.product_name,
          nmId: row.nm_id,
          quantity: row.quantity,
          stickerUrl: row.sticker_url,
          stickerBarcode: row.sticker_barcode,
          scanPassedAt: row.scan_passed_at,
          scanBarcode: row.scan_barcode,
          labelScanPassedAt: row.label_scan_passed_at,
          labelScanBarcode: row.label_scan_barcode,
        })),
      });
      return;
    }

    const scanMatch = pathname.match(/^\/api\/employee\/supplies\/([^/]+)\/orders\/(\d+)\/scan$/);
    if (scanMatch && req.method === "POST") {
      const auth = await requireAuth(req, res, [ROLE_EMPLOYEE]);
      if (!auth) return;
      const supplyId = decodeURIComponent(scanMatch[1]);
      const orderId = Number(scanMatch[2]);
      const settings = await getSupplySettings(supplyId);
      if (!settings || settings.access_mode === "hidden") {
        sendJson(res, 404, { error: "Поставка недоступна" });
        return;
      }
      if (["selected", "selected_split"].includes(settings.access_mode)) {
        const accessUserIds = await getSupplyAccessUserIds(supplyId);
        if (!accessUserIds.includes(Number(auth.id))) {
          sendJson(res, 403, { error: "FORBIDDEN" });
          return;
        }
      }
      if (settings.access_mode === "selected_split") {
        const check = await dbQuery(
          "select assigned_user_id from supply_orders where supply_id = $1 and wb_order_id = $2",
          [supplyId, orderId]
        );
        const assignedId = check.rows?.[0]?.assigned_user_id;
        if (assignedId && Number(assignedId) !== Number(auth.id)) {
          sendJson(res, 403, { error: "FORBIDDEN" });
          return;
        }
      }
      if (!(await isSupplyActiveForSettings(supplyId, settings))) {
        sendJson(res, 404, { error: "Поставка недоступна" });
        return;
      }
      const body = await readJson(req);
      const rawBarcode = typeof body?.barcode === "string" ? body.barcode : "";
      const inputBarcode = normalizeBarcode(rawBarcode);
      if (!inputBarcode) {
        sendJson(res, 400, { error: "Отсканируйте повторно" });
        return;
      }
      const orderResult = await dbQuery(
        "select article, scan_passed_at from supply_orders where supply_id = $1 and wb_order_id = $2",
        [supplyId, orderId]
      );
      const order = orderResult.rows?.[0] || null;
      if (!order) {
        sendJson(res, 404, { error: "Заказ не найден" });
        return;
      }
      if (order.scan_passed_at) {
        sendJson(res, 200, { ok: true, passed: true });
        return;
      }
      let barcodes = [];
      try {
        barcodes = await getMsBarcodesByArticle(order.article);
      } catch (err) {
        sendJson(res, 400, { error: "Отсканируйте повторно" });
        return;
      }
      const normalized = barcodes.map(normalizeBarcode).filter(Boolean);
      let matched = normalized.some((code) => code === inputBarcode);
      if (!matched) {
        try {
          const fresh = await getMsProductStatusByArticle(order.article, { force: true });
          const freshNormalized = (fresh.barcodes || []).map(normalizeBarcode).filter(Boolean);
          matched = freshNormalized.some((code) => code === inputBarcode);
        } catch {}
      }
      if (!matched) {
        sendJson(res, 400, { error: "Отсканируйте повторно" });
        return;
      }
      await dbQuery(
        `update supply_orders
         set scan_passed_at = now(), scan_passed_by = $3, scan_barcode = $4,
             scan_error = null, updated_at = now()
         where supply_id = $1 and wb_order_id = $2`,
        [supplyId, orderId, auth.id, inputBarcode]
      );
      notifySupplyUpdate(supplyId, true);
      sendJson(res, 200, { ok: true, passed: true });
      return;
    }

    const labelScanMatch = pathname.match(/^\/api\/employee\/supplies\/([^/]+)\/orders\/(\d+)\/label-scan$/);
    if (labelScanMatch && req.method === "POST") {
      const auth = await requireAuth(req, res, [ROLE_EMPLOYEE]);
      if (!auth) return;
      const supplyId = decodeURIComponent(labelScanMatch[1]);
      const orderId = Number(labelScanMatch[2]);
      const settings = await getSupplySettings(supplyId);
      if (!settings || settings.access_mode === "hidden") {
        sendJson(res, 404, { error: "Поставка недоступна" });
        return;
      }
      if (["selected", "selected_split"].includes(settings.access_mode)) {
        const accessUserIds = await getSupplyAccessUserIds(supplyId);
        if (!accessUserIds.includes(Number(auth.id))) {
          sendJson(res, 403, { error: "FORBIDDEN" });
          return;
        }
      }
      if (settings.access_mode === "selected_split") {
        const check = await dbQuery(
          "select assigned_user_id from supply_orders where supply_id = $1 and wb_order_id = $2",
          [supplyId, orderId]
        );
        const assignedId = check.rows?.[0]?.assigned_user_id;
        if (assignedId && Number(assignedId) !== Number(auth.id)) {
          sendJson(res, 403, { error: "FORBIDDEN" });
          return;
        }
      }
      if (!(await isSupplyActiveForSettings(supplyId, settings))) {
        sendJson(res, 404, { error: "Поставка недоступна" });
        return;
      }
      const body = await readJson(req);
      const rawBarcode = typeof body?.barcode === "string" ? body.barcode : "";
      const inputBarcode = normalizeBarcode(rawBarcode);
      if (!inputBarcode) {
        sendJson(res, 400, { error: "Отсканируйте повторно" });
        return;
      }
      const orderResult = await dbQuery(
        "select scan_passed_at, label_scan_passed_at from supply_orders where supply_id = $1 and wb_order_id = $2",
        [supplyId, orderId]
      );
      const order = orderResult.rows?.[0] || null;
      if (!order) {
        sendJson(res, 404, { error: "Заказ не найден" });
        return;
      }
      if (!order.scan_passed_at) {
        sendJson(res, 400, { error: "Сначала пройдите безошибочную сборку" });
        return;
      }
      if (order.label_scan_passed_at) {
        sendJson(res, 200, { ok: true, passed: true });
        return;
      }
      let expected = null;
      try {
        expected = await ensureStickerBarcode(supplyId, orderId);
      } catch {
        sendJson(res, 400, { error: "Отсканируйте повторно" });
        return;
      }
      if (!expected) {
        sendJson(res, 400, { error: "Отсканируйте повторно" });
        return;
      }
      const normalizedExpected = normalizeBarcode(expected);
      if (!normalizedExpected || normalizedExpected !== inputBarcode) {
        sendJson(res, 400, { error: "Отсканируйте повторно" });
        return;
      }
      await dbQuery(
        `update supply_orders
         set label_scan_passed_at = now(), label_scan_passed_by = $3, label_scan_barcode = $4,
             label_scan_error = null, updated_at = now()
         where supply_id = $1 and wb_order_id = $2`,
        [supplyId, orderId, auth.id, inputBarcode]
      );
      await dbQuery(
        `update supply_orders
         set collected_at = now(), collected_by = $3, collected_via = 'label_scan', updated_at = now()
         where supply_id = $1 and wb_order_id = $2 and collected_at is null`,
        [supplyId, orderId, auth.id]
      );
      notifySupplyUpdate(supplyId, true);
      sendJson(res, 200, { ok: true, passed: true });
      return;
    }

    const collectMatch = pathname.match(/^\/api\/employee\/supplies\/([^/]+)\/orders\/(\d+)\/collect$/);
    if (collectMatch && req.method === "POST") {
      const auth = await requireAuth(req, res, [ROLE_EMPLOYEE]);
      if (!auth) return;
      const supplyId = decodeURIComponent(collectMatch[1]);
      const orderId = Number(collectMatch[2]);
      const settings = await getSupplySettings(supplyId);
      if (!settings || settings.access_mode === "hidden") {
        sendJson(res, 404, { error: "Поставка недоступна" });
        return;
      }
      if (["selected", "selected_split"].includes(settings.access_mode)) {
        const accessUserIds = await getSupplyAccessUserIds(supplyId);
        if (!accessUserIds.includes(Number(auth.id))) {
          sendJson(res, 403, { error: "FORBIDDEN" });
          return;
        }
      }
      const check = await dbQuery(
        "select assigned_user_id, scan_passed_at, label_scan_passed_at from supply_orders where supply_id = $1 and wb_order_id = $2",
        [supplyId, orderId]
      );
      const assignedId = check.rows?.[0]?.assigned_user_id;
      if (settings.access_mode === "selected_split" && assignedId && Number(assignedId) !== Number(auth.id)) {
        sendJson(res, 403, { error: "FORBIDDEN" });
        return;
      }
      if (!(await isSupplyActiveForSettings(supplyId, settings))) {
        sendJson(res, 404, { error: "Поставка недоступна" });
        return;
      }
      if (!check.rows?.[0]?.scan_passed_at) {
        sendJson(res, 400, { error: "Безошибочная сборка не пройдена" });
        return;
      }
      if (!check.rows?.[0]?.label_scan_passed_at) {
        sendJson(res, 400, { error: "Скан этикетки не пройден" });
        return;
      }
      await dbQuery(
        `update supply_orders set collected_at = now(), collected_by = $3, collected_via = 'label', updated_at = now()
         where supply_id = $1 and wb_order_id = $2 and collected_at is null`,
        [supplyId, orderId, auth.id]
      );
      notifySupplyUpdate(supplyId, true);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/new-orders") {
      const auth = await requireAuth(req, res, [ROLE_ADMIN]);
      if (!auth) return;
      const store = getStoreFromRequest(req);
      const orders = await getNewOrders(store?.id);
      sendJson(res, 200, { updatedAt: new Date().toISOString(), orders });
      return;
    }

    if (pathname === "/api/supplies") {
      const auth = await requireAuth(req, res, [ROLE_ADMIN]);
      if (!auth) return;
      const store = getStoreFromRequest(req);
      const supplies = await getSupplies(store?.id);
      sendJson(res, 200, { updatedAt: new Date().toISOString(), supplies });
      return;
    }

    if (pathname === "/api/supplies/create" && req.method === "POST") {
      const auth = await requireAuth(req, res, [ROLE_ADMIN]);
      if (!auth) return;
      const store = getStoreFromRequest(req);
      const body = await readJson(req);
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      const orders = Array.isArray(body?.orders) ? body.orders : [];
      if (!name || name.length > 128) {
        sendJson(res, 400, { error: "Неверное имя поставки" });
        return;
      }
      const orderIds = orders.filter((id) => Number.isFinite(id) || typeof id === "number");
      const maxAllowed = Number.isFinite(MAX_CREATE_COUNT) && MAX_CREATE_COUNT > 0 ? MAX_CREATE_COUNT : null;
      if (orderIds.length < 1 || (maxAllowed && orderIds.length > maxAllowed)) {
        const suffix = maxAllowed ? ` до ${maxAllowed}` : "";
        sendJson(res, 400, { error: `Нужно выбрать от 1${suffix} заказов` });
        return;
      }
      const result = await createSupply(store, name, orderIds);
      notifySupplyUpdate(result?.supplyId || null, true);
      sendJson(res, 200, result);
      return;
    }

    const match = pathname.match(/^\/api\/supplies\/([^/]+)\/orders$/);
    if (match) {
      const auth = await requireAuth(req, res, [ROLE_ADMIN]);
      if (!auth) return;
      const supplyId = decodeURIComponent(match[1]);
      const settings = await getSupplySettings(supplyId);
      const orders = await getSupplyOrders(supplyId, settings?.supply_name || null);
      sendJson(res, 200, { updatedAt: new Date().toISOString(), orders });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { error: err.message || "API error" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

        let apiPath = null;
    const siteApiPrefix = `/${ROOT_SITE}/api`;
    if (pathname === siteApiPrefix || pathname === `${siteApiPrefix}/`) {
      apiPath = "/api";
    } else if (pathname.startsWith(`${siteApiPrefix}/`)) {
      apiPath = pathname.slice(`/${ROOT_SITE}`.length);
    } else if (pathname.startsWith("/api/")) {
      apiPath = pathname;
    }

    if (apiPath) {
      await handleApi(req, res, apiPath, url);
      return;
    }

    const debugPaths = new Set([`/${ROOT_SITE}/test`, `/${ROOT_SITE}/test/`, "/test", "/test/"]);
    if (debugPaths.has(pathname)) {
      await handleDebugPage(req, res, url);
      return;
    }

    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const { site, subpath } = resolveSite(pathname);

    if (!siteExists(site)) {
      if ((pathname === "/" || pathname === "") && DEFAULT_SITE && siteExists(DEFAULT_SITE)) {
        res.writeHead(302, { Location: `/${DEFAULT_SITE}/` });
        res.end();
        return;
      }
      send(res, 404, "Site not found");
      return;
    }

    const siteRoot = siteDist(site);
    const rel = subpath === "/" ? "index.html" : subpath.replace(/^\/+/, "");
    let filePath = safeJoin(siteRoot, rel);
    if (!filePath) {
      send(res, 400, "Bad request");
      return;
    }

    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {}

    if (stat && stat.isDirectory()) {
      const indexPath = path.join(filePath, "index.html");
      if (fs.existsSync(indexPath)) {
        streamFile(req, res, indexPath);
        return;
      }
      send(res, 404, "Not found");
      return;
    }

    if (stat && stat.isFile()) {
      streamFile(req, res, filePath);
      return;
    }

    if (!hasExt(subpath)) {
      const indexPath = siteIndex(site);
      if (fs.existsSync(indexPath)) {
        streamFile(req, res, indexPath);
        return;
      }
    }

    send(res, 404, "Not found");
  } catch (err) {
    send(res, 500, "Server error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Multi-site server running on http://${HOST}:${PORT}`);
  startNameBackfill();
});












