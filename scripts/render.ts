/**
 * scripts/render.ts
 *
 * Read wiki/manifest.json + content/*.md, produce static HTML at:
 *   ragriff/<en-slug-path>/index.html   (per wiki entry)
 *   post/<slug>/index.html              (per blog post)
 *   ragriff/index.html                   (wiki landing — top-level entries list)
 *   post/index.html                      (blog list — cards)
 *
 * Inline link tokens `{{link:notionID|text}}` (used for page mentions and
 * child_page blocks) get resolved to real anchor URLs via a notionID → URL map
 * built from the manifest. Image refs `/images/...` get rewritten to
 * `/wiki/images/...` so the served files are reachable.
 *
 * Run:  npm run render
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';
import type { Manifest, Node, BlogEntry } from '../types/manifest.js';

// === paths ===
const WIKI_DIR = 'wiki';
const MANIFEST_PATH = join(WIKI_DIR, 'manifest.json');
const CONTENT_DIR = join(WIKI_DIR, 'content');

const RAGRIFF_OUT = 'ragriff';
const POST_OUT = 'post';

const ENTRY_TEMPLATE = readFileSync('templates/entry.html', 'utf8');
const INDEX_TEMPLATE = readFileSync('templates/index.html', 'utf8');

// === helpers ===
function slugify(title: string): string {
  const out = title
    .toLowerCase()
    .replace(/[\s/\\:*?"<>|.]+/g, '-')
    .replace(/[[\]()]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'untitled';
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, val] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, val);
  }
  return out;
}

// === maps ===
interface UrlInfo {
  url: string;
  title: string;
}

interface PathInfo {
  segs: string[];     // en-slug path under /ragriff/
  ancestors: Node[];  // ancestor nodes (for breadcrumb)
}

function buildUrlMap(m: Manifest): Map<string, UrlInfo> {
  const out = new Map<string, UrlInfo>();
  function walk(nodes: Node[], ancestors: string[]): void {
    const seen = new Set<string>();
    for (const node of nodes) {
      let slug = slugify(node.enEntry.title);
      if (seen.has(slug)) slug = `${slug}-${node.enEntry.notionID.slice(0, 4)}`;
      seen.add(slug);
      const segs = [...ancestors, slug];
      const url = `/${RAGRIFF_OUT}/${segs.join('/')}/`;
      out.set(node.enEntry.notionID, { url, title: node.enEntry.title });
      if (node.zhEntry) out.set(node.zhEntry.notionID, { url, title: node.zhEntry.title });
      walk(node.children, segs);
    }
  }
  walk(m.tree, []);
  for (const post of m.posts) {
    const slug = slugify(post.title);
    out.set(post.notionID, { url: `/${POST_OUT}/${slug}/`, title: post.title });
  }
  return out;
}

function buildPathMap(m: Manifest): Map<string, PathInfo> {
  const out = new Map<string, PathInfo>();
  function walk(nodes: Node[], ancestors: Node[], segPath: string[]): void {
    const seen = new Set<string>();
    for (const node of nodes) {
      let slug = slugify(node.enEntry.title);
      if (seen.has(slug)) slug = `${slug}-${node.enEntry.notionID.slice(0, 4)}`;
      seen.add(slug);
      const segs = [...segPath, slug];
      out.set(node.enEntry.notionID, { segs, ancestors });
      if (node.zhEntry) out.set(node.zhEntry.notionID, { segs, ancestors });
      walk(node.children, [...ancestors, node], segs);
    }
  }
  walk(m.tree, [], []);
  return out;
}

// === content transforms ===
/**
 * sync.ts emits child_page blocks as bare `{{link:...}}` lines (same syntax
 * as inline mentions). Without blank lines between, marked joins them into
 * one paragraph. We separate them: any line that is *only* a link token gets
 * a blank line inserted after, so each becomes its own paragraph.
 * Inline mentions (link tokens embedded in sentences) are unaffected.
 */
function splitChildLinks(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  const isLinkOnly = (s: string) => /^\{\{link:[^|]+\|[^}]+\}\}$/.test(s.trim());
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]!);
    const next = lines[i + 1];
    if (isLinkOnly(lines[i]!) && next !== undefined && next.trim() !== '') {
      out.push('');
    }
  }
  return out.join('\n');
}

function resolveLinks(md: string, urlMap: Map<string, UrlInfo>): string {
  return md.replace(/\{\{link:([0-9a-f-]+)\|([^}]+)\}\}/g, (_, id, text) => {
    const info = urlMap.get(id);
    if (!info) return text;
    return `[${text}](${info.url})`;
  });
}

function rewriteImagePaths(html: string): string {
  return html.replace(/src="\/images\//g, 'src="/wiki/images/');
}

// === breadcrumb builders ===
function wikiBreadcrumb(ancestors: Node[], leafTitle: string, urlMap: Map<string, UrlInfo>): string {
  const parts: string[] = [
    `<a href="/">~</a>`,
    `<a href="/${RAGRIFF_OUT}/">Ragriff</a>`,
  ];
  for (const a of ancestors) {
    const info = urlMap.get(a.enEntry.notionID);
    parts.push(`<a href="${info?.url ?? '#'}">${escapeHtml(a.enEntry.title)}</a>`);
  }
  parts.push(
    `<span class="leaf">${escapeHtml(leafTitle)}<button class="theme-toggle" aria-label="Toggle theme"></button></span>`,
  );
  return parts.join('\n                ');
}

function postBreadcrumb(title: string): string {
  const parts: string[] = [
    `<a href="/">~</a>`,
    `<a href="/${POST_OUT}/">Posts</a>`,
    `<span class="leaf">${escapeHtml(title)}<button class="theme-toggle" aria-label="Toggle theme"></button></span>`,
  ];
  return parts.join('\n                ');
}

// === per-entry render ===
async function renderWikiEntry(
  node: Node,
  urlMap: Map<string, UrlInfo>,
  pathMap: Map<string, PathInfo>,
): Promise<boolean> {
  const id = node.enEntry.notionID;
  const info = pathMap.get(id);
  if (!info) return false;

  const mdPath = join(CONTENT_DIR, 'en', ...info.segs, `${id}.md`);
  if (!existsSync(mdPath)) return false;

  const md = readFileSync(mdPath, 'utf8');
  const resolved = resolveLinks(splitChildLinks(md), urlMap);
  const html = await marked.parse(resolved);
  const fixed = rewriteImagePaths(html);

  const filled = fillTemplate(ENTRY_TEMPLATE, {
    title: escapeHtml(node.enEntry.title),
    breadcrumb: wikiBreadcrumb(info.ancestors, node.enEntry.title, urlMap),
    content: fixed,
  });

  const outDir = join(RAGRIFF_OUT, ...info.segs);
  ensureDir(outDir);
  writeFileSync(join(outDir, 'index.html'), filled);
  return true;
}

async function renderPost(post: BlogEntry, urlMap: Map<string, UrlInfo>): Promise<boolean> {
  const mdPath = join(CONTENT_DIR, 'posts', `${post.notionID}.md`);
  if (!existsSync(mdPath)) return false;

  const md = readFileSync(mdPath, 'utf8');
  const resolved = resolveLinks(splitChildLinks(md), urlMap);
  const html = await marked.parse(resolved);
  const fixed = rewriteImagePaths(html);

  const filled = fillTemplate(ENTRY_TEMPLATE, {
    title: escapeHtml(post.title),
    breadcrumb: postBreadcrumb(post.title),
    content: fixed,
  });

  const slug = slugify(post.title);
  const outDir = join(POST_OUT, slug);
  ensureDir(outDir);
  writeFileSync(join(outDir, 'index.html'), filled);
  return true;
}

// === listing pages (reuse entry.html template) ===
function landingBreadcrumb(leafTitle: string): string {
  return [
    `<a href="/">~</a>`,
    `<span class="leaf">${escapeHtml(leafTitle)}<button class="theme-toggle" aria-label="Toggle theme"></button></span>`,
  ].join('\n                ');
}

function renderRagriffLanding(tree: Node[]): void {
  const items = tree
    .map(n => {
      const slug = slugify(n.enEntry.title);
      return `    <li><a href="/${RAGRIFF_OUT}/${slug}/">${escapeHtml(n.enEntry.title)}</a></li>`;
    })
    .join('\n');

  const content = `<ul class="entry-list">\n${items}\n</ul>`;

  const filled = fillTemplate(ENTRY_TEMPLATE, {
    title: 'Ragriff',
    breadcrumb: landingBreadcrumb('Ragriff'),
    content,
  });

  ensureDir(RAGRIFF_OUT);
  writeFileSync(join(RAGRIFF_OUT, 'index.html'), filled);
}

function extractExcerpt(md: string, maxLen = 200): string {
  // Strip the {{link:...}} markup, keep the visible text
  const cleaned = md.replace(/\{\{link:[^|]+\|([^}]+)\}\}/g, '$1');
  // First non-empty paragraph
  const para = cleaned.split(/\n{2,}/).find(s => s.trim().length > 0) ?? '';
  // Strip markdown headings/bullets/etc.
  const plain = para
    .replace(/^[#>\-*]+\s*/gm, '')
    .replace(/[*_`]/g, '')
    .trim();
  return plain.length > maxLen ? plain.slice(0, maxLen).trimEnd() + '…' : plain;
}

function renderIndex(posts: BlogEntry[]): void {
  const latest = posts[0];
  let recentHtml: string;
  if (!latest) {
    recentHtml = '<p class="muted">No posts yet.</p>';
  } else {
    const slug = slugify(latest.title);
    const date = latest.date ?? new Date(latest.created).toISOString().slice(0, 10);
    const dt = latest.date ?? latest.created;
    recentHtml = `<article class="recent-post">
        <h3><a href="/${POST_OUT}/${slug}/">${escapeHtml(latest.title)}</a></h3>
        <time datetime="${dt}">${escapeHtml(date)}</time>
      </article>`;
  }
  const filled = fillTemplate(INDEX_TEMPLATE, { recent_post: recentHtml });
  writeFileSync('index.html', filled);
}

function renderPostListing(posts: BlogEntry[]): void {
  const cards = posts
    .map(p => {
      const slug = slugify(p.title);
      const dateStr = p.date ?? new Date(p.created).toISOString().slice(0, 10);
      const mdPath = join(CONTENT_DIR, 'posts', `${p.notionID}.md`);
      const excerpt = existsSync(mdPath) ? extractExcerpt(readFileSync(mdPath, 'utf8')) : '';
      return `    <li class="post-card">
        <h2><a href="/${POST_OUT}/${slug}/">${escapeHtml(p.title)}</a></h2>
        <p class="excerpt">${escapeHtml(excerpt)}</p>
        <div class="meta"><time datetime="${p.created}">${dateStr}</time></div>
    </li>`;
    })
    .join('\n');

  const content = `<ul class="post-list">\n${cards}\n</ul>`;

  const filled = fillTemplate(ENTRY_TEMPLATE, {
    title: 'Posts',
    breadcrumb: landingBreadcrumb('Posts'),
    content,
  });

  ensureDir(POST_OUT);
  writeFileSync(join(POST_OUT, 'index.html'), filled);
}

// === main ===
async function main(): Promise<void> {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`No manifest at ${MANIFEST_PATH}. Run \`npm run sync\` first.`);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  console.log(
    `Manifest: ${manifest.tree.length} root(s), ${manifest.posts.length} post(s).`,
  );

  const urlMap = buildUrlMap(manifest);
  const pathMap = buildPathMap(manifest);

  let entriesOk = 0;
  let entriesSkip = 0;
  async function renderTree(nodes: Node[]): Promise<void> {
    for (const node of nodes) {
      const ok = await renderWikiEntry(node, urlMap, pathMap);
      if (ok) entriesOk++;
      else entriesSkip++;
      await renderTree(node.children);
    }
  }
  await renderTree(manifest.tree);
  console.log(`Wiki entries: ${entriesOk} rendered, ${entriesSkip} skipped (no .md).`);

  let postsOk = 0;
  for (const post of manifest.posts) {
    if (await renderPost(post, urlMap)) postsOk++;
  }
  console.log(`Posts: ${postsOk}/${manifest.posts.length} rendered.`);

  renderRagriffLanding(manifest.tree);
  renderPostListing(manifest.posts);
  renderIndex(manifest.posts);
  console.log(`Listings: index.html + ragriff/index.html + post/index.html written.`);
}

main().catch(e => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
