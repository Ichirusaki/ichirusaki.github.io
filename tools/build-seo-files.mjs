// Usage (from the project root):
//   node tools/build-seo-files.mjs https://ichirusaki.github.io
//   node tools/build-seo-files.mjs https://example.com --production
// Generates sitemap.xml, robots.txt and llms.txt, and checks the indexable pages.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const SITE_NAME = "Tabinotas";
const TITLE_SUFFIX = ` | ${SITE_NAME}`;
const MAX_TITLE_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 160;

// Training crawlers are blocked in production. Search and answer crawlers
// (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User)
// get no rule on purpose: they follow the "*" group and are therefore allowed.
const TRAINING_BOTS = [
  "GPTBot",
  "ClaudeBot",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "Meta-ExternalAgent",
  "Bytespider",
  "cohere-ai",
];

const ROOT = process.cwd();
const SKIPPED_DIRS = new Set([".git", "node_modules", "tools", "templates", "fonts", "css", "js", "img"]);
const STAGING_BLOCK = /<!--\s*staging:start[\s\S]*?staging:end\s*-->/;
const PERMANENT_NOINDEX = /<meta\s+name="robots"\s+content="[^"]*noindex/i;

const args = process.argv.slice(2);
const isProduction = args.includes("--production");
const siteUrlArgument = args.find((argument) => !argument.startsWith("--"));

if (!siteUrlArgument) {
  console.error("Usage: node tools/build-seo-files.mjs <site-url> [--production]");
  process.exit(1);
}

const SITE_URL = new URL(siteUrlArgument).origin;

function findHtmlFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...findHtmlFiles(fullPath));
    } else if (extname(entry) === ".html") {
      files.push(fullPath);
    }
  }
  return files;
}

function decodeEntities(text) {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function escapeXml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getMetaContent(html, key) {
  const match = html.match(new RegExp(`<meta\\s+(?:name|property)="${key}"\\s+content="([^"]*)"`, "i"));
  return match ? decodeEntities(match[1]) : null;
}

function toUrlPath(posixPath) {
  if (posixPath === "index.html") return "/";
  if (posixPath.endsWith("/index.html")) return `/${posixPath.slice(0, -"index.html".length)}`;
  return `/${posixPath}`;
}

function getLastModified(file, html) {
  const declared = getMetaContent(html, "article:modified_time");
  if (declared) return declared.slice(0, 10);
  try {
    const gitDate = execFileSync("git", ["log", "-1", "--format=%cs", "--", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (gitDate) return gitDate;
  } catch {
    // Not a git repository, or git is not installed: fall back to the file date
  }
  return statSync(file).mtime.toISOString().slice(0, 10);
}

function readPage(file) {
  const rawHtml = readFileSync(file, "utf8");
  const html = rawHtml.replace(STAGING_BLOCK, "").replace(/<!--[\s\S]*?-->/g, "");
  const filePath = relative(ROOT, file).split(sep).join("/");
  const urlPath = toUrlPath(filePath);

  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const canonicalMatch = html.match(/<link\s+rel="canonical"\s+href="([^"]*)"/i);
  const imageTags = html.replace(/src="data:[^"]*"/g, 'src="data:"').match(/<img\b[^>]*>/g) ?? [];

  const title = titleMatch ? decodeEntities(titleMatch[1]) : null;
  const displayTitle = title && title.endsWith(TITLE_SUFFIX) ? title.slice(0, -TITLE_SUFFIX.length) : title;

  return {
    file: filePath,
    urlPath,
    url: SITE_URL + urlPath,
    isNoindex: PERMANENT_NOINDEX.test(html),
    hasStagingBlock: STAGING_BLOCK.test(rawHtml),
    title,
    label: urlPath === "/" ? "Inicio" : displayTitle,
    description: getMetaContent(html, "description"),
    author: getMetaContent(html, "author"),
    canonical: canonicalMatch ? canonicalMatch[1] : null,
    h1Count: (html.match(/<h1[\s>]/g) ?? []).length,
    imagesWithoutAlt: imageTags.filter((tag) => !/\salt="/.test(tag)).length,
    lastModified: null,
    rawHtml,
  };
}

function lintPage(page) {
  const problems = [];
  const warn = (message) => problems.push({ level: "WARN", page: page.file, message });
  const fail = (message) => problems.push({ level: "ERROR", page: page.file, message });

  if (!page.title) {
    warn("missing <title>");
  } else if (page.title.length > MAX_TITLE_LENGTH) {
    warn(`title has ${page.title.length} characters (max ${MAX_TITLE_LENGTH})`);
  }

  if (!page.description) {
    warn("missing meta description");
  } else if (page.description.length > MAX_DESCRIPTION_LENGTH) {
    warn(`description has ${page.description.length} characters (max ${MAX_DESCRIPTION_LENGTH})`);
  }

  if (page.h1Count !== 1) warn(`expected exactly one <h1>, found ${page.h1Count}`);
  if (page.imagesWithoutAlt > 0) warn(`${page.imagesWithoutAlt} <img> without alt attribute`);
  if (page.canonical !== page.url) fail(`canonical is "${page.canonical}", expected "${page.url}"`);
  if (isProduction && page.hasStagingBlock) fail("staging block is still present");

  return problems;
}

function buildSitemap(pages) {
  const entries = pages
    .map(
      (page) =>
        `  <url>\n    <loc>${escapeXml(page.url)}</loc>\n    <lastmod>${page.lastModified}</lastmod>\n  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function buildRobots(excludedPages) {
  if (!isProduction) {
    return "# Staging environment: block all crawlers until launch\nUser-agent: *\nDisallow: /\n";
  }

  const disallowedPaths = [
    "/templates/",
    "/tools/",
    ...excludedPages.filter((page) => page.file !== "404.html").map((page) => page.urlPath),
  ];

  const trainingRules = TRAINING_BOTS.map((bot) => `User-agent: ${bot}`).join("\n");

  return [
    `# robots.txt for ${SITE_NAME}`,
    "# Search engines and AI search/answer crawlers follow the \"*\" group.",
    "User-agent: *",
    ...disallowedPaths.map((path) => `Disallow: ${path}`),
    "",
    "# AI training crawlers: blocked",
    trainingRules,
    "Disallow: /",
    "",
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    "",
  ].join("\n");
}

function buildLlmsTxt(pages, home) {
  const cityPages = pages.filter((page) => page.urlPath.startsWith("/cities/") && page.urlPath !== "/cities/");
  const guidePages = pages.filter((page) => page.urlPath.startsWith("/guides/") && page.urlPath !== "/guides/");
  const mainPages = pages.filter((page) => !cityPages.includes(page) && !guidePages.includes(page));

  const toLine = (page) =>
    page.description ? `- [${page.label}](${page.url}): ${page.description}` : `- [${page.label}](${page.url})`;

  const sections = [
    ["Páginas principales", mainPages],
    ["Ciudades", cityPages],
    ["Guías prácticas", guidePages],
  ]
    .filter(([, list]) => list.length > 0)
    .map(([heading, list]) => `## ${heading}\n\n${list.map(toLine).join("\n")}`);

  const authorLine = home.author ? `\nAutor: ${home.author}.\n` : "";
  return `# ${SITE_NAME}\n\n> ${home.description}\n${authorLine}\n${sections.join("\n\n")}\n`;
}

const allPages = findHtmlFiles(ROOT).map(readPage);
const indexablePages = allPages
  .filter((page) => !page.isNoindex)
  .sort((a, b) => a.urlPath.localeCompare(b.urlPath));
const excludedPages = allPages.filter((page) => page.isNoindex);

const home = indexablePages.find((page) => page.urlPath === "/");
if (!home) {
  console.error("ERROR: index.html not found or marked as noindex.");
  process.exit(1);
}

for (const page of indexablePages) {
  page.lastModified = getLastModified(page.file, page.rawHtml);
}

writeFileSync(join(ROOT, "sitemap.xml"), buildSitemap(indexablePages));
writeFileSync(join(ROOT, "robots.txt"), buildRobots(excludedPages));
writeFileSync(join(ROOT, "llms.txt"), buildLlmsTxt(indexablePages, home));

const problems = indexablePages.flatMap(lintPage);

console.log(`Mode: ${isProduction ? "production" : "staging"} | Site URL: ${SITE_URL}`);
console.log(`Indexable pages: ${indexablePages.length} | Excluded (noindex): ${excludedPages.length}`);
for (const page of excludedPages) console.log(`  excluded: ${page.file}`);
for (const problem of problems) console.log(`${problem.level}  ${problem.page}: ${problem.message}`);

const errorCount = problems.filter((problem) => problem.level === "ERROR").length;
console.log(errorCount === 0 ? "Done. Generated sitemap.xml, robots.txt and llms.txt." : `${errorCount} error(s) found.`);
process.exitCode = errorCount === 0 ? 0 : 1;