/**
 * scripts/render.ts
 *
 * Walk the Obsidian vault and produce the static site:
 *   ragriff/<folder-path>/index.html   (per wiki entry)
 *   ragriff/index.html                 (wiki landing)
 *   post/<slug>/index.html             (per blog post)
 *   post/index.html                    (blog list)
 *   index.html                         (home)
 *
 * There is no manifest: the folder layout *is* the tree. `Foo/Foo.md` is the
 * note for folder `Foo` and the rest of that folder are its children; a note
 * carries both languages in `:::lang en` / `:::lang zh` blocks; `[[wikilinks]]`
 * resolve through a filename + alias index.
 *
 * VAULT points at the vault root (default `SoD`, the copy committed to this
 * repo). Point it at the live vault to preview unpublished edits:
 *   VAULT=~/Documents/SoD npm run dev
 *
 * Run:  npm run render
 */

import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { marked } from 'marked';
import { parse as parseYaml } from 'yaml';
import type { Entry, Post, Stat } from '../types/vault.js';

// === paths ===
/** The committed copy when there is one (that is what Vercel builds), else the
 *  live vault, so `npm run dev` previews what Obsidian has right now. */
const VAULT = process.env.VAULT
  ?? ['SoD', join(homedir(), 'Documents', 'SoD')].find(existsSync)
  ?? 'SoD';
/** The wiki half: `Archive/` (named `Ragriff/` before 2026-10-25). */
const WIKI_SRC = ['Archive', 'Ragriff'].map(d => join(VAULT, d)).find(existsSync) ?? join(VAULT, 'Archive');
const POST_SRC = join(VAULT, 'BlogPosts');

/** Images the published notes embed, gathered from anywhere in the vault by
 *  publish.sh (they may live in unpublished folders like `_image/`). */
const ATTACH_SRC = join(VAULT, 'Attachments');

/** The novel. A published top-level folder like the other two. */
const STORY_SRC = join(VAULT, 'Story');

const RAGRIFF_OUT = 'ragriff';
const ARCHIVE = 'archive';       // the wiki half of /ragriff
const STORY = 'story';           // the novel half
const POST_OUT = 'post';
const IMG_OUT = 'images';

const ENTRY_TEMPLATE = readFileSync('templates/entry.html', 'utf8');
const INDEX_TEMPLATE = readFileSync('templates/index.html', 'utf8');
const RAGRIFF_TEMPLATE = readFileSync('templates/ragriff.html', 'utf8');

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

/** `_foo` is unpublished, `.obsidian` is Obsidian's own. */
const isHidden = (name: string): boolean => name.startsWith('_') || name.startsWith('.');

// === note parsing ===
interface Note {
  fm: Record<string, unknown>;
  en: string;
  zh: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*\r?\n?/;

/** Split the body into its `:::lang` blocks. A note with no block at all (blog
 *  shape, or a stray hand-written note) counts as single-language content. */
function splitLangs(body: string): { en: string; zh: string } {
  const buf = { en: [] as string[], zh: [] as string[] };
  let cur: 'en' | 'zh' | null = null;
  let tagged = false;
  for (const line of body.split('\n')) {
    const open = /^:::lang\s+(en|zh)\s*$/.exec(line.trim());
    if (open) {
      cur = open[1] as 'en' | 'zh';
      tagged = true;
      continue;
    }
    if (line.trim() === ':::') {
      cur = null;
      continue;
    }
    if (cur) buf[cur].push(line);
  }
  if (!tagged) return { en: body.trim(), zh: '' };
  return { en: buf.en.join('\n').trim(), zh: buf.zh.join('\n').trim() };
}

function parseNote(path: string): Note {
  const raw = readFileSync(path, 'utf8');
  const m = FRONTMATTER.exec(raw);
  let fm: Record<string, unknown> = {};
  if (m) {
    try {
      fm = (parseYaml(m[1]!) ?? {}) as Record<string, unknown>;
    } catch (e) {
      console.warn(`  ! bad frontmatter in ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { fm, ...splitLangs(m ? raw.slice(m[0].length) : raw) };
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

function firstAlias(v: unknown): string | undefined {
  if (typeof v === 'string') return str(v);
  return Array.isArray(v) ? str(v[0]) : undefined;
}

// === vault walk ===
function toEntry(path: string, title: string, slug: string[]): Entry {
  const { fm, en, zh } = parseNote(path);
  const stat = str(fm['stat.en']);
  return {
    slug,
    title,
    zhTitle: firstAlias(fm['aliases']),
    stat: stat === 'Auto Translated' || stat === 'Reviewed' ? (stat as Stat) : undefined,
    etymology: { en: str(fm['etymology.en']), zh: str(fm['etymology.zh']) },
    tentative: { en: fm['name_tentative.en'] === true, zh: fm['name_tentative.zh'] === true },
    body: { en, zh },
    children: [],
  };
}

/** `selfNote` is the folder note of `dir` — it is this level's own page, not a child. */
function readTree(dir: string, segs: string[], selfNote: string | null): Entry[] {
  const out: Entry[] = [];
  const items = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const item of items) {
    if (isHidden(item.name) || item.name === selfNote) continue;
    const path = join(dir, item.name);

    if (item.isDirectory()) {
      const note = `${item.name}.md`;
      const slug = [...segs, slugify(item.name)];
      const entry = existsSync(join(path, note))
        ? toEntry(join(path, note), item.name, slug)
        : blankEntry(item.name, slug);
      entry.children = readTree(path, slug, note);
      out.push(entry);
    } else if (item.name.endsWith('.md')) {
      const title = item.name.slice(0, -3);
      out.push(toEntry(path, title, [...segs, slugify(title)]));
    }
  }
  return out;
}

/** A folder with no folder note still needs a page so its children have a parent. */
function blankEntry(title: string, slug: string[]): Entry {
  console.warn(`  ! no folder note for ${slug.join('/')} — rendering an empty page`);
  return {
    slug, title, etymology: {}, tentative: {}, body: { en: '', zh: '' }, children: [],
  };
}

function readPosts(): Post[] {
  if (!existsSync(POST_SRC)) return [];
  const posts: Post[] = [];
  for (const item of readdirSync(POST_SRC, { withFileTypes: true })) {
    if (isHidden(item.name) || !item.name.endsWith('.md')) continue;
    const path = join(POST_SRC, item.name);
    const { fm, en } = parseNote(path);
    const title = item.name.slice(0, -3);
    posts.push({
      slug: slugify(title),
      title,
      date: str(fm['date']) ?? statSync(path).mtime.toISOString().slice(0, 10),
      body: en,
    });
  }
  return posts.sort((a, b) => b.date.localeCompare(a.date));
}

/** Every top-level note in Story/ is a chapter, read exactly like a wiki
 *  entry: two `:::lang` blocks, the same notes, the same stub notice when a
 *  side is empty. Order is filename order, which is what Obsidian shows. */
function readChapters(): Entry[] {
  if (!existsSync(STORY_SRC)) return [];
  return readdirSync(STORY_SRC, { withFileTypes: true })
    .filter(i => i.isFile() && i.name.endsWith('.md') && !isHidden(i.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(i => {
      const title = i.name.slice(0, -3);
      return toEntry(join(STORY_SRC, i.name), title, [STORY, slugify(title)]);
    });
}

/** Attachments live beside the notes; flatten them into /images/. */
function copyAttachments(dir: string, into: Set<string>): void {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (isHidden(item.name)) continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) copyAttachments(path, into);
    else if (!item.name.endsWith('.md')) {
      if (into.has(item.name)) {
        console.warn(`  ! two attachments named ${item.name} — the later one wins`);
      }
      ensureDir(IMG_OUT);
      copyFileSync(path, join(IMG_OUT, item.name));
      into.add(item.name);
    }
  }
}

// === links ===
/** filename and alias both address a note, the way Obsidian resolves them. */
function buildIndex(tree: Entry[], chapters: Entry[], posts: Post[]): Map<string, string> {
  const out = new Map<string, string>();
  const add = (key: string | undefined, url: string): void => {
    if (!key) return;
    if (out.has(key) && out.get(key) !== url) {
      console.warn(`  ! "${key}" addresses two notes — keeping ${out.get(key)}`);
      return;
    }
    out.set(key, url);
  };
  const walk = (entries: Entry[]): void => {
    for (const e of entries) {
      const url = `/${RAGRIFF_OUT}/${e.slug.join('/')}/`;
      add(e.title, url);
      add(e.zhTitle, url);
      walk(e.children);
    }
  };
  walk(tree);
  walk(chapters);
  for (const p of posts) add(p.title, `/${POST_OUT}/${p.slug}/`);
  return out;
}

const WIKILINK = /(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function resolveLinks(md: string, index: Map<string, string>, dangling: Set<string>): string {
  return md.replace(WIKILINK, (_, bang: string, target: string, alias?: string) => {
    const name = target.trim();
    const text = alias?.trim() ?? name;
    if (bang) return `![${text}](${encodeURI(`/${IMG_OUT}/${basename(name)}`)})`;
    const url = index.get(name);
    if (!url) {
      dangling.add(name);
      return text;                    // outside the wiki — plain text, as the old site did
    }
    return `[${text}](${url})`;
  });
}

/** `![alt](some/dir/pic.png)` with a vault-relative path → `/images/pic.png`;
 *  web URLs are left alone. */
const MD_IMAGE = /!\[([^\]]*)\]\((?!https?:|data:|\/)(<[^>]+>|[^)\s]+)\)/g;

function resolveImages(md: string): string {
  return md.replace(MD_IMAGE, (_, alt: string, src: string) =>
    `![${alt}](${encodeURI(`/${IMG_OUT}/${basename(decodeURI(src.replace(/^<|>$/g, '')))}`)})`);
}

async function renderMd(md: string, index: Map<string, string>, dangling: Set<string>): Promise<string> {
  if (!md.trim()) return '';
  return marked.parse(resolveImages(resolveLinks(md, index, dangling)), { breaks: true });
}

const THEME_BTN = `<button class="theme-toggle" aria-label="Toggle theme"></button>`;
const LANG_BTN =
  `<button class="lang-toggle" aria-label="Switch language">` +
  `<span data-show-lang="en">ZH</span><span data-show-lang="zh">EN</span></button>`;

// === breadcrumb builders ===
function wikiBreadcrumb(ancestors: Entry[], leaf: Entry, hasZh: boolean): string {
  const parts: string[] = [
    `<a href="/">~</a>`,
    `<a href="/${RAGRIFF_OUT}/">Ragriff</a>`,
    `<a href="/${RAGRIFF_OUT}/${ARCHIVE}/">Archive</a>`,
  ];
  for (const a of ancestors) {
    const url = `/${RAGRIFF_OUT}/${a.slug.join('/')}/`;
    const enT = escapeHtml(a.title);
    const zhT = a.zhTitle ? escapeHtml(a.zhTitle) : enT;
    if (hasZh) {
      parts.push(
        `<a href="${url}"><span data-show-lang="en">${enT}</span><span data-show-lang="zh">${zhT}</span></a>`,
      );
    } else {
      parts.push(`<a href="${url}">${enT}</a>`);
    }
  }
  if (hasZh) parts.push(LANG_BTN);
  const enLeaf = escapeHtml(leaf.title);
  const leafInner = hasZh && leaf.zhTitle
    ? `<span data-show-lang="en">${enLeaf}</span><span data-show-lang="zh">${escapeHtml(leaf.zhTitle)}</span>`
    : enLeaf;
  parts.push(`<span class="leaf">${leafInner}${THEME_BTN}</span>`);
  return parts.join('\n                ');
}

function postBreadcrumb(title: string): string {
  return [
    `<a href="/">~</a>`,
    `<a href="/${POST_OUT}/">Posts</a>`,
    `<span class="leaf">${escapeHtml(title)}${THEME_BTN}</span>`,
  ].join('\n                ');
}

// === entry content (notes above body + dual-lang body) ===
/** zh is the original, en is the translation, so every warning about the state
 *  of a text belongs to the side that reads it. */
function buildEntryContent(e: Entry, enHtml: string, zhHtml: string): string {
  const hasEn = enHtml !== '';
  const hasZh = zhHtml !== '';
  const enNotes: string[] = [];
  const zhNotes: string[] = [];
  const line = (s: string): string => `<p>${escapeHtml(s).replace(/\n/g, '<br>')}</p>`;

  if (e.etymology.en) enNotes.push(line(`Etymology: ${e.etymology.en}`));
  if (e.etymology.zh) zhNotes.push(line(`词源: ${e.etymology.zh}`));
  if (e.tentative.en) enNotes.push(line('The name of this entry is tentative.'));
  if (e.tentative.zh) zhNotes.push(line('此条目的名称尚为暂定。'));
  if (hasZh && e.stat === 'Auto Translated') {
    enNotes.push(line('This Entry is Machine-translated from the Chinese original and requires review.'));
  }
  if (hasZh && !hasEn) {
    enNotes.push(line('This entry is written in Chinese and is waiting for translation.'));
  }
  if (!hasZh && !hasEn) {
    enNotes.push(line('This entry is a stub — nothing has been written here yet.'));
  }

  const parts: string[] = [];
  if (hasZh) {
    if (enNotes.length > 0) parts.push(`<blockquote class="notes" data-show-lang="en">${enNotes.join('')}</blockquote>`);
    if (zhNotes.length > 0) parts.push(`<blockquote class="notes" data-show-lang="zh">${zhNotes.join('')}</blockquote>`);
    parts.push(`<article data-show-lang="en">${enHtml}</article>`);
    parts.push(`<article data-show-lang="zh">${zhHtml}</article>`);
  } else {
    if (enNotes.length > 0) parts.push(`<blockquote class="notes">${enNotes.join('')}</blockquote>`);
    parts.push(enHtml);
  }
  return parts.join('\n');
}

// === per-entry render ===
async function renderEntry(
  e: Entry,
  trail: (hasZh: boolean) => string,
  index: Map<string, string>,
  dangling: Set<string>,
): Promise<void> {
  const enHtml = await renderMd(e.body.en, index, dangling);
  const zhHtml = await renderMd(e.body.zh, index, dangling);

  const filled = fillTemplate(ENTRY_TEMPLATE, {
    title: escapeHtml(e.title),
    breadcrumb: trail(zhHtml !== ''),
    content: buildEntryContent(e, enHtml, zhHtml),
  });

  const outDir = join(RAGRIFF_OUT, ...e.slug);
  ensureDir(outDir);
  writeFileSync(join(outDir, 'index.html'), filled);
}

async function renderPost(p: Post, index: Map<string, string>, dangling: Set<string>): Promise<void> {
  const filled = fillTemplate(ENTRY_TEMPLATE, {
    title: escapeHtml(p.title),
    breadcrumb: postBreadcrumb(p.title),
    content: await renderMd(p.body, index, dangling),
  });
  const outDir = join(POST_OUT, p.slug);
  ensureDir(outDir);
  writeFileSync(join(outDir, 'index.html'), filled);
}

// === listing pages (reuse entry.html template) ===
function landingBreadcrumb(leafTitle: string, withLangToggle: boolean): string {
  const parts = [`<a href="/">~</a>`];
  if (withLangToggle) parts.push(LANG_BTN);
  parts.push(`<span class="leaf">${escapeHtml(leafTitle)}${THEME_BTN}</span>`);
  return parts.join('\n                ');
}

const dual = (en: string, zh: string): string =>
  `<span data-show-lang="en">${escapeHtml(en)}</span><span data-show-lang="zh">${escapeHtml(zh)}</span>`;

/** What the gate's text field is made of: the wiki's own names and openings.
 *  ASCII only — a CJK glyph is two cells wide in a monospace grid and would
 *  shear every row it landed in. */
function buildCorpus(tree: Entry[], limit = 200): string[] {
  const out = new Set<string>();
  const clean = (s: string): string => s
    .replace(WIKILINK, (_, bang: string, target: string, alias?: string) => (bang ? '' : alias ?? target))
    .replace(/[#>*`\[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const walk = (es: Entry[]): void => {
    for (const e of es) {
      if (!e.title.endsWith('_deprecated')) out.add(e.title);
      const opening = clean(e.body.en).slice(0, 96).trim();   // about one row wide
      if (opening) out.add(opening);
      walk(e.children);
    }
  };
  walk(tree);

  return [...out]
    .filter(s => s.length > 3 && !s.includes('_deprecated') && /^[\x20-\x7E]+$/.test(s))
    .slice(0, limit);
}

/** /ragriff/ — its own page, not an entry: the animation and the doors, nothing else. */
function renderRagriffLanding(entries: number, chapters: number, corpus: string[]): void {
  const door = (href: string, en: string, zh: string, noteEn: string, noteZh: string): string =>
    `            <li><h2 class="door-name"><a href="${href}">${dual(en, zh)}</a></h2>
                <span class="door-note">${dual(noteEn, noteZh)}</span></li>`;

  const doors = [
    door(`/${RAGRIFF_OUT}/${ARCHIVE}/`, 'the Archive', '档案室',
      `${entries} entries`, `${entries} 条`),
    door(`/${RAGRIFF_OUT}/${STORY}/`, 'the Story', '本传',
      `${chapters} chapter${chapters === 1 ? '' : 's'}`, `${chapters} 章`),
  ].join('\n').trimStart();                  // the template already indents the first line

  // `<` escaped so the array can never close the script tag that carries it
  const corpusJson = JSON.stringify(corpus).replaceAll('<', '\\u003c');

  ensureDir(RAGRIFF_OUT);
  writeFileSync(join(RAGRIFF_OUT, 'index.html'),
    fillTemplate(RAGRIFF_TEMPLATE, { doors, corpus: corpusJson }));
}

/** /ragriff/archive/ — the section index. Entries keep their URLs one level
 *  up (/ragriff/being/...), so nothing that is already linked breaks. */
function renderArchiveIndex(tree: Entry[]): void {
  const items = tree
    .map(e => `    <li><a href="/${RAGRIFF_OUT}/${e.slug.join('/')}/">${dual(e.title, e.zhTitle ?? e.title)}</a></li>`)
    .join('\n');

  const filled = fillTemplate(ENTRY_TEMPLATE, {
    title: 'Archive',
    breadcrumb: [
      `<a href="/">~</a>`,
      `<a href="/${RAGRIFF_OUT}/">Ragriff</a>`,
      LANG_BTN,
      `<span class="leaf">${dual('Archive', '档案室')}${THEME_BTN}</span>`,
    ].join('\n                '),
    content: `<ul class="entry-list">\n${items}\n</ul>`,
  });

  ensureDir(join(RAGRIFF_OUT, ARCHIVE));
  writeFileSync(join(RAGRIFF_OUT, ARCHIVE, 'index.html'), filled);
}

function storyBreadcrumb(leaf: Entry, hasZh: boolean): string {
  const parts = [
    `<a href="/">~</a>`,
    `<a href="/${RAGRIFF_OUT}/">Ragriff</a>`,
    `<a href="/${RAGRIFF_OUT}/${STORY}/">Story</a>`,
  ];
  if (hasZh) parts.push(LANG_BTN);
  parts.push(`<span class="leaf">${
    hasZh && leaf.zhTitle ? dual(leaf.title, leaf.zhTitle) : escapeHtml(leaf.title)
  }${THEME_BTN}</span>`);
  return parts.join('\n                ');
}

function renderStoryIndex(chapters: Entry[]): void {
  const items = chapters
    .map(c => `    <li><a href="/${RAGRIFF_OUT}/${c.slug.join('/')}/">${dual(c.title, c.zhTitle ?? c.title)}</a></li>`)
    .join('\n');

  const filled = fillTemplate(ENTRY_TEMPLATE, {
    title: 'Story',
    breadcrumb: [
      `<a href="/">~</a>`,
      `<a href="/${RAGRIFF_OUT}/">Ragriff</a>`,
      LANG_BTN,
      `<span class="leaf">${dual('Story', '本传')}${THEME_BTN}</span>`,
    ].join('\n                '),
    content: `<ul class="entry-list">\n${items}\n</ul>`,
  });

  ensureDir(join(RAGRIFF_OUT, STORY));
  writeFileSync(join(RAGRIFF_OUT, STORY, 'index.html'), filled);
}

function extractExcerpt(md: string, maxLen = 200): string {
  const cleaned = md.replace(WIKILINK, (_, bang: string, target: string, alias?: string) =>
    bang ? '' : (alias ?? target));
  const para = cleaned.split(/\n{2,}/).find(s => s.trim().length > 0) ?? '';
  const plain = para
    .replace(/^[#>\-*]+\s*/gm, '')
    .replace(/[*_`]/g, '')
    .trim();
  return plain.length > maxLen ? plain.slice(0, maxLen).trimEnd() + '…' : plain;
}

function renderPostListing(posts: Post[]): void {
  const cards = posts
    .map(p => `    <li class="post-card">
        <h2><a href="/${POST_OUT}/${p.slug}/">${escapeHtml(p.title)}</a></h2>
        <p class="excerpt">${escapeHtml(extractExcerpt(p.body))}</p>
        <div class="meta"><time datetime="${p.date}">${p.date}</time></div>
    </li>`)
    .join('\n');

  const filled = fillTemplate(ENTRY_TEMPLATE, {
    title: 'Posts',
    breadcrumb: landingBreadcrumb('Posts', false),
    content: `<ul class="post-list">\n${cards}\n</ul>`,
  });

  ensureDir(POST_OUT);
  writeFileSync(join(POST_OUT, 'index.html'), filled);
}

function renderIndex(posts: Post[]): void {
  const latest = posts[0];
  const recentHtml = latest
    ? `<article class="recent-post">
        <h3><a href="/${POST_OUT}/${latest.slug}/">${escapeHtml(latest.title)}</a></h3>
        <time datetime="${latest.date}">${latest.date}</time>
      </article>`
    : '<p class="muted">No posts yet.</p>';
  writeFileSync('index.html', fillTemplate(INDEX_TEMPLATE, { recent_post: recentHtml }));
}

// === main ===
async function main(): Promise<void> {
  if (!existsSync(WIKI_SRC)) {
    throw new Error(`No vault at ${WIKI_SRC}. Set VAULT to the vault root.`);
  }

  // renaming a note moves its page, so old output has to go or it lingers
  for (const dir of [RAGRIFF_OUT, POST_OUT, IMG_OUT]) rmSync(dir, { recursive: true, force: true });

  const tree = readTree(WIKI_SRC, [], null);
  const posts = readPosts();
  const chapters = readChapters();
  const index = buildIndex(tree, chapters, posts);
  const dangling = new Set<string>();

  const attachments = new Set<string>();
  copyAttachments(WIKI_SRC, attachments);
  if (existsSync(POST_SRC)) copyAttachments(POST_SRC, attachments);
  if (existsSync(ATTACH_SRC)) copyAttachments(ATTACH_SRC, attachments);

  let count = 0;
  async function walk(entries: Entry[], ancestors: Entry[]): Promise<void> {
    for (const e of entries) {
      await renderEntry(e, hasZh => wikiBreadcrumb(ancestors, e, hasZh), index, dangling);
      count++;
      await walk(e.children, [...ancestors, e]);
    }
  }
  await walk(tree, []);
  console.log(`Archive: ${count} entries from ${tree.length} root(s).`);

  for (const p of posts) await renderPost(p, index, dangling);
  console.log(`Posts: ${posts.length} rendered.`);

  for (const c of chapters) {
    await renderEntry(c, hasZh => storyBreadcrumb(c, hasZh), index, dangling);
  }
  console.log(`Story: ${chapters.length} chapters.`);

  renderRagriffLanding(count, chapters.length, buildCorpus(tree));
  renderArchiveIndex(tree);
  renderStoryIndex(chapters);
  renderPostListing(posts);
  renderIndex(posts);
  console.log(`Listings: index.html + ragriff/index.html + post/index.html written.`);
  if (attachments.size > 0) console.log(`Attachments: ${attachments.size} copied to ${IMG_OUT}/.`);

  if (dangling.size > 0) {
    console.log(`\n${dangling.size} dangling link(s), rendered as plain text:`);
    for (const name of [...dangling].sort()) console.log(`   [[${name}]]`);
  }
}

main().catch(e => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
