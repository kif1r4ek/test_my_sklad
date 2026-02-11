export function normalizeSkus(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value == null) return [];
  return [String(value)];
}

export function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeArticleKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  const str = String(value).trim();
  return str ? str : null;
}

export function normalizeSupplyId(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str ? str : null;
}

export function normalizeStoreId(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim().toLowerCase();
  return str ? str : null;
}

export function normalizeBarcode(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, "").trim();
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
