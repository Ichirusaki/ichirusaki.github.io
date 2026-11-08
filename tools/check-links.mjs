// Usage (from the project root): node tools/check-links.mjs
// Checks that every root-relative href, src and srcset in the HTML files points to an existing file.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();
const IGNORED_DIRS = new Set([".git", "node_modules", "tools"]);

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...walk(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function extractReferences(html) {
  const references = [];
  for (const match of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    references.push(match[1]);
  }
  for (const match of html.matchAll(/\ssrcset="([^"]+)"/g)) {
    for (const candidate of match[1].split(",")) {
      references.push(candidate.trim().split(/\s+/)[0]);
    }
  }
  return references;
}

// Returns the file a root-relative reference should point to, or null if it is not checked
function resolveTarget(reference) {
  if (reference.startsWith("//")) return null;
  const clean = reference.split("#")[0].split("?")[0];
  if (!clean.startsWith("/")) return null;
  const target = join(ROOT, clean);
  return clean.endsWith("/") ? join(target, "index.html") : target;
}

const htmlFiles = walk(ROOT).filter((file) => extname(file) === ".html");
let brokenCount = 0;

for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  for (const reference of extractReferences(html)) {
    const target = resolveTarget(reference);
    if (target && !existsSync(target)) {
      console.log(`BROKEN  ${file.replace(ROOT, "")}  ->  ${reference}`);
      brokenCount++;
    }
  }
}

console.log(brokenCount === 0 ? "No broken links found." : `${brokenCount} broken link(s).`);
process.exitCode = brokenCount === 0 ? 0 : 1;