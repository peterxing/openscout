// Builds the public browser demo (the real web UI + an in-browser simulated backend) into site/ for GitHub Pages.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "site");
const SITE_URL = "https://peterxing.github.io/openscout/";

const VENDOR = {
  "marked.js": "marked/lib/marked.umd.js",
  "purify.js": "dompurify/dist/purify.min.js",
  "highlight.js": "@highlightjs/cdn-assets/highlight.min.js",
  "hljs-light.css": "@highlightjs/cdn-assets/styles/github.min.css",
  "hljs-dark.css": "@highlightjs/cdn-assets/styles/github-dark.min.css",
  "mermaid.js": "mermaid/dist/mermaid.min.js",
};

const schedule = path.join(root, "dist", "server", "schedule.js");
if (!fs.existsSync(schedule)) throw new Error("dist/server/schedule.js is missing — run `npm run build` first.");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "vendor"), { recursive: true });
fs.mkdirSync(path.join(out, "assets"), { recursive: true });

for (const f of ["app.js", "chat.js", "core.js", "views.js", "styles.css"]) fs.copyFileSync(path.join(root, "web", f), path.join(out, f));
for (const [name, rel] of Object.entries(VENDOR)) fs.copyFileSync(path.join(root, "node_modules", rel), path.join(out, "vendor", name));
for (const f of ["icon.png", "icon-64.png"]) fs.copyFileSync(path.join(root, "assets", f), path.join(out, "assets", f));
fs.copyFileSync(path.join(root, "demo", "demo-backend.js"), path.join(out, "demo-backend.js"));
// The demo reuses the app's natural-language schedule parser (pure ESM, no Node APIs).
fs.writeFileSync(path.join(out, "schedule.js"), fs.readFileSync(schedule, "utf8").replace(/^\/\/# sourceMappingURL=.*$/m, ""));
fs.writeFileSync(path.join(out, "demo-config.js"), "window.OPENSCOUT_DEMO = true;\n");
fs.writeFileSync(path.join(out, ".nojekyll"), "");

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
const description =
  "Try OpenScout for students in your browser: a study assistant that runs on GitHub Copilot and your school Microsoft 365 account — classes, assignments, lecture notes, study plans and quizzes. No Microsoft 365 Copilot licence needed.";
const head = [
  '<meta charset="utf-8" />',
  `    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
  `    <meta name="description" content="${description}" />`,
  '    <meta property="og:title" content="OpenScout for students — browser demo" />',
  `    <meta property="og:description" content="${description}" />`,
  `    <meta property="og:image" content="${SITE_URL}assets/icon.png" />`,
  `    <meta property="og:url" content="${SITE_URL}" />`,
].join("\n");

let html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const replacements = [
  ["<title>OpenScout</title>", "<title>OpenScout for students — browser demo</title>"],
  ['<meta charset="utf-8" />', head],
  ['<script type="module" src="app.js"></script>', '<script src="demo-config.js"></script>\n    <script type="module" src="app.js"></script>'],
];
for (const [from, to] of replacements) {
  if (!html.includes(from)) throw new Error(`index.html no longer contains ${from}; update scripts/build-site.mjs.`);
  html = html.replace(from, to);
}
fs.writeFileSync(path.join(out, "index.html"), html);

const files = fs.readdirSync(out, { recursive: true }).filter((f) => fs.statSync(path.join(out, f)).isFile());
console.log(`Built browser demo: ${files.length} files in ${path.relative(root, out)}/`);
