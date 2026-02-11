import express from "express";
import compression from "compression";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, "dist");

const app = express();
app.disable("x-powered-by");
app.use(compression());
app.use(express.static(distPath, { extensions: ["html"], index: false }));

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.get(/.*/, (req, res) => {
  const indexPath = path.join(distPath, "index.html");
  if (!fs.existsSync(indexPath)) {
    res.status(503).send("Build not found. Run npm run build.");
    return;
  }
  res.sendFile(indexPath);
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
app.listen(port, host, () => {
  console.log(`Server running at http://${host}:${port}`);
});
