import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");

function decodeTextFile(filePath) {
  const buf = fs.readFileSync(filePath);
  if (!buf || buf.length === 0) return "";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString("utf8");
  }
  return buf.toString("utf8");
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = decodeTextFile(filePath);
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv(path.join(PROJECT_ROOT, ".env"));

export const SITES_ROOT = process.env.SITES_ROOT || path.resolve(PROJECT_ROOT, "..");
export const ROOT_SITE = process.env.ROOT_SITE || "root";
export const DEFAULT_SITE = process.env.DEFAULT_SITE || "my_sklad";
export const HOST = process.env.HOST || "127.0.0.1";
export const PORT = Number(process.env.PORT || 3000);

export const WB_API_TOKEN = process.env.WB_API_TOKEN || "";
export const WB_API_TOKEN_2 = process.env.WB_API_TOKEN_2 || "";
export const WB_CLIENT_SECRET = process.env.WB_CLIENT_SECRET || "";
export const WB_CLIENT_SECRET_2 = process.env.WB_CLIENT_SECRET_2 || "";
export const WB_STORE_1_ID = process.env.WB_STORE_1_ID || "irina";
export const WB_STORE_2_ID = process.env.WB_STORE_2_ID || "evgeny";
export const WB_STORE_1_NAME = process.env.WB_STORE_1_NAME || "ИП Ирина";
export const WB_STORE_2_NAME = process.env.WB_STORE_2_NAME || "ИП Евгений";
export const API_BASE = "https://marketplace-api.wildberries.ru";
export const CONTENT_BASE = "https://content-api.wildberries.ru";

export const MS_TOKEN = process.env.MS_TOKEN || "";
export const MS_BASE_URL = process.env.MS_BASE_URL || "https://api.moysklad.ru/api/remap/1.2";
export const MS_CACHE_MS = Number(process.env.MS_CACHE_MS || 10 * 60 * 1000);

export const MAX_CREATE_COUNT = Number(process.env.MAX_CREATE_COUNT || 0);
export const ORDER_BATCH_SIZE = Number(process.env.ORDER_BATCH_SIZE || 100);
export const NAME_BACKFILL_ENABLED = process.env.NAME_BACKFILL_ENABLED === "0" ? false : true;
export const NAME_BACKFILL_BATCH = Number(process.env.NAME_BACKFILL_BATCH || 30);
export const NAME_BACKFILL_INTERVAL_MS = Number(process.env.NAME_BACKFILL_INTERVAL_MS || 10 * 60 * 1000);
export const NAME_BACKFILL_DELAY_MS = Number(process.env.NAME_BACKFILL_DELAY_MS || 8000);

export const DB_HOST = process.env.DB_HOST || "212.193.30.22";
export const DB_PORT = Number(process.env.DB_PORT || 5432);
export const DB_USER = process.env.DB_USER || "gen_user";
export const DB_PASSWORD = process.env.DB_PASSWORD || "";
export const DB_NAME = process.env.DB_NAME || "default_db";
export const DB_SSL = (process.env.DB_SSL || "auto").toLowerCase();

export const S3_ENDPOINT = (process.env.S3_ENDPOINT || "https://s3.twcstorage.ru").replace(/\/$/, "");
export const S3_BUCKET = process.env.S3_BUCKET || "postav";
export const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "";
export const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "";
export const S3_REGION = process.env.S3_REGION || "ru-1";
export const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE === "0" ? false : true;
export const S3_PUBLIC_BASE = (process.env.S3_PUBLIC_BASE || `${S3_ENDPOINT}/${S3_BUCKET}`).replace(/\/$/, "");

export const LABEL_TYPE = (process.env.LABEL_TYPE || "png").toLowerCase();
export const LABEL_WIDTH = Number(process.env.LABEL_WIDTH || 58);
export const LABEL_HEIGHT = Number(process.env.LABEL_HEIGHT || 40);
export const LABEL_BATCH_SIZE = 100;

export const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const COOKIE_NAME = "sid";
export const COOKIE_PATH = "/" + ROOT_SITE;

export const ROLE_SUPER = "super_admin";
export const ROLE_ADMIN = "admin";
export const ROLE_EMPLOYEE = "employee";

export const PRODUCT_CACHE_MS = 6 * 60 * 60 * 1000;
export const PRODUCT_NEGATIVE_CACHE_MS = Number(process.env.PRODUCT_NEGATIVE_CACHE_MS || 15 * 60 * 1000);
export const PRODUCT_RESOLVE_BATCH = Number(process.env.PRODUCT_RESOLVE_BATCH || 30);
export const CARDS_CACHE_MS = 12 * 60 * 60 * 1000;

const DEFAULT_CACHE_DIR = process.env.CACHE_DIR || path.join(PROJECT_ROOT, "var");
try {
  fs.mkdirSync(DEFAULT_CACHE_DIR, { recursive: true });
} catch {}
export const CACHE_DIR = DEFAULT_CACHE_DIR;
export const CARDS_CACHE_FILE =
  process.env.CARDS_CACHE_FILE || path.join(DEFAULT_CACHE_DIR, "cards-cache.json");

export const CACHE_MS = 25000;
export const CACHE_SUPPLIES_MS = Number(process.env.CACHE_SUPPLIES_MS || 5000);
export const CACHE_ORDERS_MS = Number(process.env.CACHE_ORDERS_MS || 12000);
export const CACHE_NEW_ORDERS_MS = Number(process.env.CACHE_NEW_ORDERS_MS || 15000);
export const SUPPLY_SYNC_MS = Number(process.env.SUPPLY_SYNC_MS || 60 * 1000);
