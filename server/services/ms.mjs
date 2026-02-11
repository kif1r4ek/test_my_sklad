import { MS_TOKEN, MS_BASE_URL, MS_CACHE_MS } from "../config.mjs";
import { normalizeArticleKey } from "../utils.mjs";

const msCache = new Map();

export async function msRequest(endpoint, options = {}) {
  if (!MS_TOKEN) {
    throw new Error("MS_TOKEN is missing");
  }
  const { method = "GET" } = options;
  const resp = await fetch(`${MS_BASE_URL}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${MS_TOKEN}`,
      Accept: "application/json;charset=utf-8",
      "Accept-Encoding": "gzip",
      ...options.headers,
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`MS API ${resp.status}: ${text.slice(0, 400)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function extractMsBarcodes(product) {
  const out = [];
  const list = Array.isArray(product?.barcodes) ? product.barcodes : [];
  for (const entry of list) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry === "string" || typeof entry === "number") {
      const value = String(entry).trim();
      if (value && !out.includes(value)) out.push(value);
      continue;
    }
    if (typeof entry === "object") {
      for (const value of Object.values(entry)) {
        if (value === null || value === undefined) continue;
        const str = String(value).trim();
        if (str && !out.includes(str)) out.push(str);
      }
    }
  }
  return out;
}

async function fetchMsProductByArticle(article, options = {}) {
  const force = options?.force === true;
  const key = normalizeArticleKey(article);
  if (!key) {
    return { article: null, found: false, barcodes: [] };
  }
  const cached = msCache.get(key);
  const now = Date.now();
  if (!force && cached && now - cached.ts < MS_CACHE_MS) {
    const cachedFound = cached.found ?? (cached.barcodes && cached.barcodes.length > 0);
    return { article: key, found: Boolean(cachedFound), barcodes: cached.barcodes || [] };
  }

  const attempt = async () => {
    const data = await msRequest(`/entity/product?filter=article=${encodeURIComponent(key)}`);
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const product = rows[0] || null;
    const barcodes = extractMsBarcodes(product);
    const found = Boolean(product);
    msCache.set(key, { ts: now, barcodes, found });
    return { article: key, found, barcodes };
  };

  try {
    return await attempt();
  } catch (err) {
    // Short retry to reduce transient MS API failures.
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return await attempt();
    } catch {
      if (cached) {
        const cachedFound = cached.found ?? (cached.barcodes && cached.barcodes.length > 0);
        return { article: key, found: Boolean(cachedFound), barcodes: cached.barcodes || [] };
      }
      throw err;
    }
  }
}

export async function getMsBarcodesByArticle(article) {
  const result = await fetchMsProductByArticle(article);
  return result.barcodes || [];
}

export async function getMsProductStatusByArticle(article, options = {}) {
  const result = await fetchMsProductByArticle(article, options);
  return { found: Boolean(result.found), barcodes: result.barcodes || [] };
}
