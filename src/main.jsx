import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

const rootEl = document.getElementById("root");

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const showError = (err) => {
  if (!rootEl) return;
  const message = err?.stack || err?.message || String(err);
  rootEl.innerHTML = `
    <div style="min-height:100vh;background:#0b0d12;color:#e7e9ee;padding:32px;font-family:Arial,sans-serif;">
      <h1 style="margin:0 0 12px 0;font-size:20px;">Ошибка приложения</h1>
      <div style="color:#a0a6b5;margin-bottom:12px;">Скопируйте текст и пришлите мне.</div>
      <pre style="white-space:pre-wrap;background:#151a23;padding:16px;border-radius:12px;border:1px solid #232936;">${escapeHtml(message)}</pre>
    </div>
  `;
};

window.addEventListener("error", (event) => {
  showError(event?.error || event?.message);
});

window.addEventListener("unhandledrejection", (event) => {
  showError(event?.reason || "Unhandled promise rejection");
});

import("./App.jsx")
  .then(({ default: App }) => {
    if (!rootEl) return;
    createRoot(rootEl).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  })
  .catch(showError);

