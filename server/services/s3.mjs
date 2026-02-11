import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { PDFDocument } from "pdf-lib";
import {
  S3_REGION,
  S3_ENDPOINT,
  S3_BUCKET,
  S3_ACCESS_KEY,
  S3_SECRET_KEY,
  S3_FORCE_PATH_STYLE,
  S3_PUBLIC_BASE,
} from "../config.mjs";

let s3Client = null;

export function getS3Client() {
  if (!S3_ACCESS_KEY || !S3_SECRET_KEY) return null;
  if (s3Client) return s3Client;
  s3Client = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    credentials: {
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
    },
    forcePathStyle: S3_FORCE_PATH_STYLE,
  });
  return s3Client;
}

export function slugify(value) {
  if (!value) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function buildLabelsPrefix(supplyId, supplyName) {
  const name = slugify(supplyName || "");
  const base = name ? `${supplyId}-${name}` : String(supplyId || "").trim();
  return base || `supply-${Date.now()}`;
}

export function buildS3Key(prefix, orderId) {
  return `${prefix}/${orderId}.pdf`;
}

export function buildS3Url(key) {
  const safe = key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${S3_PUBLIC_BASE}/${safe}`;
}

export async function pngBase64ToPdf(base64) {
  const pngBytes = Buffer.from(base64, "base64");
  const pdfDoc = await PDFDocument.create();
  const image = await pdfDoc.embedPng(pngBytes);
  const { width, height } = image.scale(1);
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(image, { x: 0, y: 0, width, height });
  return await pdfDoc.save();
}

export async function uploadPdfToS3(key, pdfBytes) {
  const client = getS3Client();
  if (!client) {
    throw new Error("S3 credentials are missing");
  }
  await client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: pdfBytes,
      ContentType: "application/pdf",
      ACL: "public-read",
    })
  );
}
