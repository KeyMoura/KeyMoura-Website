import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const src = require.resolve("pdfjs-dist/build/pdf.worker.min.mjs");
const dest = path.join(process.cwd(), "public", "pdf.worker.mjs");

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);

console.log(`[copy-pdf-worker] Copied worker to ${dest}`);
