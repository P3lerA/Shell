/**
 * scripts/sync.ts
 *
 * Notion (zh + en wiki dbs) → local manifest + per-page markdown.
 *
 * Algorithm:
 *   1. Fetch all pages from both data sources with full properties.
 *   2. Detect orphans (zh entries no en page's `zh` relation points at) and
 *      create empty en stubs with the `zh` relation set, recursively up the parent
 *      chain so position mirrors the zh tree. Skipped only in --dry.
 *   3. Build manifest from en tree (en = structural authority); resolve zhEntry
 *      via the en page's `zh` relation property.
 *   4. For pages where last_edited_time > sync-state.lastSyncTime (or --full),
 *      fetch blocks → markdown → write .md, queue + download images.
 *   5. Write manifest.json. Output is deterministic given Notion state — re-running
 *      with no Notion changes produces a byte-identical file (no spurious git diff).
 *      Incremental filtering compares each page's last_edited_time against the
 *      previous manifest's per-entry lastModified; git history is the sync state.
 *
 * Output layout (folders mirror the en tree for readability; filenames stay UUIDs
 * so `find wiki -name "<id>.md"` works without consulting the manifest):
 *   wiki/
 *     manifest.json
 *     content/{zh,en}/<en-slug-path>/{notionID}.md
 *     images/{pageID}/{blockID}{ext}
 *
 * Run:  npm run sync                   incremental, write
 *       npm run sync -- --dry          no writes anywhere
 *       npm run sync -- --full         re-render every .md, ignore lastSyncTime
 *       npm run sync -- --root-page <id>  limit scope to descendants of an en page (testing)
 */

import 'dotenv/config';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  createWriteStream,
} from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client, isFullPage, APIErrorCode } from '@notionhq/client';
import type {
  PageObjectResponse,
  BlockObjectResponse,
  RichTextItemResponse,
} from '@notionhq/client';
import pLimit from 'p-limit';
import type { Manifest, Node as TreeNode, Entry, Status, BlogEntry, BlogStat } from '../types/manifest.js';

// === env / args ===
const NOTION_TOKEN = required('NOTION_TOKEN');
const ZH_DS_ID = required('ZH_DS_ID');
const EN_DS_ID = required('EN_DS_ID');
const BLOG_DS_ID = required('BLOG_DS_ID');
const EN_RELATION_PROPERTY = process.env.EN_RELATION_PROPERTY ?? 'zh';

const DRY_RUN = process.argv.includes('--dry');
const FULL = process.argv.includes('--full');
const ROOT_PAGE = argValue('--root-page');

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// === const ===
const PROP_TITLE = '页面';
const PROP_ETYMOLOGY = 'Etymology';
const PROP_STAT = 'Stat';

const WIKI_DIR = 'wiki';
const MANIFEST_PATH = join(WIKI_DIR, 'manifest.json');
const CONTENT_DIR = join(WIKI_DIR, 'content');
const IMAGES_DIR = join(WIKI_DIR, 'images');

const notion = new Client({ auth: NOTION_TOKEN });

// === types ===
interface PageData {
  id: string;
  parentId: string | null;
  title: string;
  etymology?: string;
  stat?: Status;
  lastModified: string;
  zhRelationId?: string;
}

interface BlogPageData {
  id: string;
  title: string;
  created: string;
  date?: string;
  lastModified: string;
  stat: BlogStat;
}

interface BlockNode {
  block: BlockObjectResponse;
  children: BlockNode[];
}

interface MdContext {
  pageID: string;
  imagesToFetch: Array<{ url: string; blockId: string; ext: string }>;
}

// === helpers ===
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function slugify(title: string): string {
  const out = title
    .toLowerCase()
    .replace(/[\s/\\:*?"<>|.]+/g, '-')
    .replace(/[[\]()]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'untitled';
}

/** id → slug path from root to that entry. en+zh share the same path (en is structural). */
function buildPathMap(tree: TreeNode[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  function walk(nodes: TreeNode[], ancestors: string[]): void {
    const seenSlugs = new Set<string>();
    for (const node of nodes) {
      let slug = slugify(node.enEntry.title);
      if (seenSlugs.has(slug)) slug = `${slug}-${node.enEntry.notionID.slice(0, 4)}`;
      seenSlugs.add(slug);
      const path = [...ancestors, slug];
      out.set(node.enEntry.notionID, path);
      if (node.zhEntry) out.set(node.zhEntry.notionID, path);
      walk(node.children, path);
    }
  }
  walk(tree, []);
  return out;
}

function loadPreviousLastModified(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(MANIFEST_PATH)) return map;
  try {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        map.set(n.enEntry.notionID, n.enEntry.lastModified);
        if (n.zhEntry) map.set(n.zhEntry.notionID, n.zhEntry.lastModified);
        walk(n.children);
      }
    };
    walk(m.tree);
    for (const p of m.posts ?? []) map.set(p.notionID, p.lastModified);
  } catch {
    // corrupt or missing — return empty so all pages re-fetch
  }
  return map;
}

// Global Notion API throttle: ensures any two consecutive calls are ≥ MIN_INTERVAL apart,
// even under concurrent callers. Notion's documented limit is ~3 req/s, we leave headroom.
const NOTION_MIN_INTERVAL_MS = 500;
let nextNotionCallAt = 0;
async function gateNotion(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextNotionCallAt - now);
  nextNotionCallAt = (wait > 0 ? nextNotionCallAt : now) + NOTION_MIN_INTERVAL_MS;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await gateNotion();
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === APIErrorCode.RateLimited && attempt < 5) {
        const wait = 1000 * 2 ** attempt;
        console.warn(`  rate-limited (${label}), retrying in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

// === fetch pages ===
async function fetchAllPages(dataSourceId: string, isEn: boolean): Promise<PageData[]> {
  const out: PageData[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRetry(
      () =>
        notion.dataSources.query({
          data_source_id: dataSourceId,
          start_cursor: cursor,
          page_size: 100,
        }),
      `query ${isEn ? 'en' : 'zh'}`,
    );
    for (const page of res.results) {
      if (!isFullPage(page)) continue;
      out.push(extractPageData(page, isEn));
    }
    cursor = res.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

function extractPageData(page: PageObjectResponse, isEn: boolean): PageData {
  const titleEntry = Object.entries(page.properties).find(([, p]) => p.type === 'title');
  const title =
    titleEntry && titleEntry[1].type === 'title'
      ? titleEntry[1].title.map(t => t.plain_text).join('')
      : '(untitled)';

  const etymProp = page.properties[PROP_ETYMOLOGY];
  const etymology =
    etymProp?.type === 'rich_text'
      ? etymProp.rich_text.map(t => t.plain_text).join('').trim() || undefined
      : undefined;

  let stat: Status | undefined;
  if (isEn) {
    const sp = page.properties[PROP_STAT];
    if (sp?.type === 'select' && sp.select) stat = sp.select.name as Status;
  }

  const parent = page.parent;
  const parentId = parent.type === 'page_id' ? parent.page_id : null;

  let zhRelationId: string | undefined;
  if (isEn) {
    const rp = page.properties[EN_RELATION_PROPERTY];
    if (rp?.type === 'relation' && rp.relation.length > 0) {
      zhRelationId = rp.relation[0]!.id;
    }
  }

  return {
    id: page.id,
    parentId,
    title,
    etymology,
    stat,
    lastModified: page.last_edited_time,
    zhRelationId,
  };
}

async function fetchBlogPages(dataSourceId: string): Promise<BlogPageData[]> {
  const out: BlogPageData[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRetry(
      () =>
        notion.dataSources.query({
          data_source_id: dataSourceId,
          start_cursor: cursor,
          page_size: 100,
        }),
      'query blog',
    );
    for (const page of res.results) {
      if (!isFullPage(page)) continue;
      out.push(extractBlogPageData(page));
    }
    cursor = res.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

function extractBlogPageData(page: PageObjectResponse): BlogPageData {
  const titleEntry = Object.entries(page.properties).find(([, p]) => p.type === 'title');
  const title =
    titleEntry && titleEntry[1].type === 'title'
      ? titleEntry[1].title.map(t => t.plain_text).join('')
      : '(untitled)';

  const statProp = page.properties[PROP_STAT];
  const stat: BlogStat =
    statProp?.type === 'select' && statProp.select
      ? (statProp.select.name as BlogStat)
      : 'Draft';

  const createdProp = page.properties['Created time'];
  const created =
    createdProp?.type === 'created_time' ? createdProp.created_time : page.created_time;

  const dateProp = page.properties['Date'];
  const date =
    dateProp?.type === 'rich_text'
      ? dateProp.rich_text.map(t => t.plain_text).join('').trim() || undefined
      : undefined;

  return {
    id: page.id,
    title,
    created,
    date,
    lastModified: page.last_edited_time,
    stat,
  };
}

// === fetch blocks ===
async function fetchBlocksDeep(blockId: string): Promise<BlockNode[]> {
  const direct = await fetchBlocksFlat(blockId);
  const out: BlockNode[] = [];
  for (const b of direct) {
    const children = b.has_children ? await fetchBlocksDeep(b.id) : [];
    out.push({ block: b, children });
  }
  return out;
}

async function fetchBlocksFlat(blockId: string): Promise<BlockObjectResponse[]> {
  const out: BlockObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRetry(
      () =>
        notion.blocks.children.list({
          block_id: blockId,
          start_cursor: cursor,
          page_size: 100,
        }),
      `blocks ${blockId.slice(0, 8)}`,
    );
    for (const b of res.results) {
      if ('type' in b) out.push(b as BlockObjectResponse);
    }
    cursor = res.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

// === orphan handling ===
function findOrphans(zh: PageData[], en: PageData[]): PageData[] {
  const referenced = new Set(
    en.map(e => e.zhRelationId).filter((id): id is string => !!id),
  );
  return zh.filter(z => !referenced.has(z.id));
}

async function createOrphanStub(
  zh: PageData,
  zhById: Map<string, PageData>,
  enByZhId: Map<string, string>,
  pending: Map<string, Promise<string>>,
): Promise<string> {
  const existing = enByZhId.get(zh.id);
  if (existing) return existing;

  // Cache the in-flight promise BEFORE awaiting anything, so concurrent callers
  // sharing an ancestor reuse the same creation instead of racing duplicate stubs.
  const inFlight = pending.get(zh.id);
  if (inFlight) return inFlight;

  const work = (async (): Promise<string> => {
    let parent:
      | { type: 'page_id'; page_id: string }
      | { type: 'data_source_id'; data_source_id: string };
    if (zh.parentId) {
      const zhParent = zhById.get(zh.parentId);
      if (zhParent) {
        const enParentId = await createOrphanStub(zhParent, zhById, enByZhId, pending);
        parent = { type: 'page_id', page_id: enParentId };
      } else {
        parent = { type: 'data_source_id', data_source_id: EN_DS_ID };
      }
    } else {
      parent = { type: 'data_source_id', data_source_id: EN_DS_ID };
    }

    const created = await withRetry(
      () =>
        notion.pages.create({
          parent,
          properties: {
            [PROP_TITLE]: { title: [{ type: 'text', text: { content: zh.title } }] },
            [EN_RELATION_PROPERTY]: { relation: [{ id: zh.id }] },
            [PROP_STAT]: { select: { name: 'Empty' satisfies Status } },
          },
        }),
      `create stub ${zh.title}`,
    );
    return created.id;
  })();

  pending.set(zh.id, work);
  return work;
}

// === manifest ===
function buildManifest(en: PageData[], zh: PageData[], blog: BlogPageData[]): Manifest {
  const byParent = new Map<string | null, PageData[]>();
  for (const p of en) {
    const arr = byParent.get(p.parentId) ?? [];
    arr.push(p);
    byParent.set(p.parentId, arr);
  }
  const zhById = new Map(zh.map(z => [z.id, z]));

  function makeEntry(p: PageData): Entry {
    const e: Entry = {
      notionID: p.id,
      title: p.title,
      lastModified: p.lastModified,
    };
    if (p.etymology !== undefined) e.etymology = p.etymology;
    if (p.stat !== undefined) e.stat = p.stat;
    return e;
  }

  function makeNode(enPage: PageData): TreeNode {
    const node: TreeNode = {
      enEntry: makeEntry(enPage),
      children: (byParent.get(enPage.id) ?? []).map(makeNode),
    };
    if (enPage.zhRelationId) {
      const zhPage = zhById.get(enPage.zhRelationId);
      if (zhPage) node.zhEntry = makeEntry(zhPage);
    }
    return node;
  }

  const posts: BlogEntry[] = blog
    .map(b => {
      const e: BlogEntry = {
        notionID: b.id,
        title: b.title,
        created: b.created,
        lastModified: b.lastModified,
        stat: b.stat,
      };
      if (b.date !== undefined) e.date = b.date;
      return e;
    })
    .sort((a, b) => (b.date ?? b.created).localeCompare(a.date ?? a.created));

  const roots = byParent.get(null) ?? [];
  return {
    tree: roots.map(makeNode),
    posts,
  };
}

// === markdown conversion ===
function richTextToMd(items: RichTextItemResponse[]): string {
  return items
    .map(item => {
      if (item.type === 'mention') {
        if (item.mention.type === 'page') {
          return `{{link:${item.mention.page.id}|${item.plain_text}}}`;
        }
        return item.plain_text;
      }
      if (item.type === 'equation') {
        return `$${item.equation.expression}$`;
      }
      let text = item.plain_text;
      const a = item.annotations;
      if (a.code) text = '`' + text + '`';
      if (a.bold) text = '**' + text + '**';
      if (a.italic) text = '*' + text + '*';
      if (a.strikethrough) text = '~~' + text + '~~';
      if (item.href) text = `[${text}](${item.href})`;
      return text;
    })
    .join('');
}

function plainText(items: RichTextItemResponse[]): string {
  return items.map(t => t.plain_text).join('');
}

function blocksToMd(nodes: BlockNode[], ctx: MdContext, indent = 0): string {
  const lines: string[] = [];
  let numCounter = 0;
  let inThink = false;

  for (const node of nodes) {
    const b = node.block;
    if (b.type !== 'numbered_list_item') numCounter = 0;
    const pad = '  '.repeat(indent);

    // <think> tag handling: skip paragraphs from <think> through </think>
    if (b.type === 'paragraph') {
      const txt = plainText(b.paragraph.rich_text);
      if (!inThink && txt.includes('<think>')) inThink = true;
      if (inThink) {
        if (txt.includes('</think>')) inThink = false;
        continue;
      }
    }

    switch (b.type) {
      case 'paragraph': {
        // Notion's "press Enter twice" creates an empty paragraph block
        // (rich_text=[]). Emit it as a visible &nbsp; paragraph so the extra
        // spacing the user intended is preserved instead of collapsing into
        // the default paragraph-break.
        const rt = b.paragraph.rich_text;
        const text = rt.length === 0 ? '&nbsp;' : richTextToMd(rt);
        lines.push(pad + text);
        if (node.children.length > 0) {
          lines.push(blocksToMd(node.children, ctx, indent + 1));
        }
        break;
      }
      case 'heading_1':
        lines.push(pad + '# ' + richTextToMd(b.heading_1.rich_text));
        break;
      case 'heading_2':
        lines.push(pad + '## ' + richTextToMd(b.heading_2.rich_text));
        break;
      case 'heading_3':
        lines.push(pad + '### ' + richTextToMd(b.heading_3.rich_text));
        break;
      case 'bulleted_list_item':
        lines.push(pad + '- ' + richTextToMd(b.bulleted_list_item.rich_text));
        if (node.children.length > 0) {
          lines.push(blocksToMd(node.children, ctx, indent + 1));
        }
        break;
      case 'numbered_list_item':
        numCounter++;
        lines.push(pad + numCounter + '. ' + richTextToMd(b.numbered_list_item.rich_text));
        if (node.children.length > 0) {
          lines.push(blocksToMd(node.children, ctx, indent + 1));
        }
        break;
      case 'to_do': {
        const done = b.to_do.checked ? 'x' : ' ';
        lines.push(pad + `- [${done}] ` + richTextToMd(b.to_do.rich_text));
        break;
      }
      case 'code': {
        const code = plainText(b.code.rich_text);
        lines.push(pad + '```' + b.code.language);
        lines.push(code);
        lines.push(pad + '```');
        break;
      }
      case 'quote':
        lines.push(pad + '> ' + richTextToMd(b.quote.rich_text));
        if (node.children.length > 0) {
          lines.push(blocksToMd(node.children, ctx, indent + 1));
        }
        break;
      case 'callout': {
        const emoji = b.callout.icon?.type === 'emoji' ? b.callout.icon.emoji + ' ' : '';
        lines.push(pad + `> ${emoji}` + richTextToMd(b.callout.rich_text));
        if (node.children.length > 0) {
          lines.push(blocksToMd(node.children, ctx, indent + 1));
        }
        break;
      }
      case 'divider':
        lines.push(pad + '---');
        break;
      case 'image': {
        const url =
          b.image.type === 'external' ? b.image.external.url : b.image.file.url;
        let ext = '';
        try {
          ext = extname(new URL(url).pathname);
        } catch {
          // ignore
        }
        if (!ext) ext = '.png';
        const filename = b.id + ext;
        ctx.imagesToFetch.push({ url, blockId: b.id, ext });
        const caption = richTextToMd(b.image.caption);
        lines.push(pad + `![${caption || ''}](/images/${ctx.pageID}/${filename})`);
        break;
      }
      case 'toggle': {
        const summary = richTextToMd(b.toggle.rich_text);
        lines.push(pad + `<details><summary>${summary}</summary>`);
        if (node.children.length > 0) {
          lines.push(blocksToMd(node.children, ctx, indent + 1));
        }
        lines.push(pad + `</details>`);
        break;
      }
      case 'equation':
        lines.push(pad + `$$\n${b.equation.expression}\n$$`);
        break;
      case 'bookmark':
        lines.push(pad + `[${b.bookmark.url}](${b.bookmark.url})`);
        break;
      case 'column_list':
      case 'column':
      case 'synced_block':
        if (node.children.length > 0) {
          lines.push(blocksToMd(node.children, ctx, indent));
        }
        break;
      case 'child_page':
        // Block id = page id. Render as a link so the in-page categorization
        // (siblings grouped under heading blocks) is preserved in the body.
        lines.push(pad + `{{link:${b.id}|${b.child_page.title}}}`);
        break;
      case 'child_database':
        break;
      default:
        lines.push(pad + `<!-- unsupported block type: ${b.type} -->`);
    }

    // Always end a block with a blank line so adjacent blocks become separate
    // paragraphs in markdown (Notion shows visual gaps between blocks via CSS,
    // not via empty paragraph blocks; without this, two consecutive paragraphs
    // get joined into one by marked).
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('');
    }
  }

  return lines.join('\n');
}

// === image download ===
async function downloadImage(url: string, target: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed ${res.status}: ${url}`);
  if (!res.body) throw new Error(`Empty body: ${url}`);
  ensureDir(dirname(target));
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(target));
}

// === main ===
async function main() {
  const startTime = new Date();
  console.log(
    `Mode: ${DRY_RUN ? 'DRY' : 'LIVE'}` +
      `${FULL ? ' --full' : ''}`,
  );

  const prevLastMod = loadPreviousLastModified();
  console.log(`Previous manifest: ${prevLastMod.size} entries${prevLastMod.size === 0 ? ' (first run)' : ''}`);

  console.log('Fetching pages from all data sources...');
  let [zhPages, enPages, blogPages] = await Promise.all([
    fetchAllPages(ZH_DS_ID, false),
    fetchAllPages(EN_DS_ID, true),
    fetchBlogPages(BLOG_DS_ID),
  ]);
  const publishedBlog = blogPages.filter(p => p.stat === 'Publish');
  console.log(
    `zh: ${zhPages.length} pages, en: ${enPages.length} pages, ` +
      `blog: ${blogPages.length} total / ${publishedBlog.length} published`,
  );

  if (ROOT_PAGE) {
    const enById = new Map(enPages.map(p => [p.id, p]));
    const isDesc = (p: PageData): boolean =>
      p.id === ROOT_PAGE ||
      (!!p.parentId && (() => {
        const parent = enById.get(p.parentId);
        return parent ? isDesc(parent) : false;
      })());
    enPages = enPages.filter(isDesc);
    const refZh = new Set(enPages.map(e => e.zhRelationId).filter((x): x is string => !!x));
    zhPages = zhPages.filter(z => refZh.has(z.id));
    // Make the filter root appear as a top-level node in the manifest.
    enPages = enPages.map(p => p.id === ROOT_PAGE ? { ...p, parentId: null } : p);
    console.log(`--root-page filter: ${enPages.length} en, ${zhPages.length} zh under ${ROOT_PAGE.slice(0, 8)}`);
  }

  // orphans — auto-create en stubs (with zh relation) so cron stays self-healing.
  const orphans = findOrphans(zhPages, enPages);
  if (orphans.length > 0) {
    console.log(`\nOrphan zh pages (no en counterpart): ${orphans.length}`);
    for (const o of orphans.slice(0, 20)) console.log(`  ${o.title}  (${o.id.slice(0, 8)})`);
    if (orphans.length > 20) console.log(`  ...and ${orphans.length - 20} more`);

    if (!DRY_RUN) {
      console.log(`\nCreating en stubs for ${orphans.length} orphan(s)...`);
      const zhById = new Map(zhPages.map(z => [z.id, z]));
      const enByZhId = new Map<string, string>();
      for (const e of enPages) {
        if (e.zhRelationId) enByZhId.set(e.zhRelationId, e.id);
      }
      const pending = new Map<string, Promise<string>>();
      const limit = pLimit(2);
      await Promise.all(
        orphans.map(o => limit(() => createOrphanStub(o, zhById, enByZhId, pending))),
      );
      console.log(`Created ${pending.size} stub(s). Re-fetching en pages...`);
      enPages = await fetchAllPages(EN_DS_ID, true);
    }
  }

  // build manifest + path map
  const manifest = buildManifest(enPages, zhPages, publishedBlog);
  console.log(
    `\nManifest: ${manifest.tree.length} root(s), ${manifest.posts.length} post(s).`,
  );
  const pathMap = buildPathMap(manifest.tree);

  // Write manifest NOW (before potentially-long content fetch). If sync gets
  // interrupted later, manifest is still on disk so next run can incremental.
  if (!DRY_RUN) {
    ensureDir(WIKI_DIR);
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  }

  // determine items needing content sync. Wiki pages not in tree (orphan zh)
  // skipped — unreachable from frontend.
  interface SyncTask {
    id: string;
    title: string;
    label: string;
    mdPath: string;
    lastModified: string;
  }
  const tasks: SyncTask[] = [
    ...zhPages
      .filter(p => pathMap.has(p.id))
      .map(p => {
        const segs = pathMap.get(p.id)!;
        return {
          id: p.id,
          title: p.title,
          label: 'zh',
          mdPath: join(CONTENT_DIR, 'zh', ...segs, `${p.id}.md`),
          lastModified: p.lastModified,
        };
      }),
    ...enPages
      .filter(p => pathMap.has(p.id))
      .map(p => {
        const segs = pathMap.get(p.id)!;
        return {
          id: p.id,
          title: p.title,
          label: 'en',
          mdPath: join(CONTENT_DIR, 'en', ...segs, `${p.id}.md`),
          lastModified: p.lastModified,
        };
      }),
    ...publishedBlog.map(p => ({
      id: p.id,
      title: p.title,
      label: 'post',
      mdPath: join(CONTENT_DIR, 'posts', `${p.id}.md`),
      lastModified: p.lastModified,
    })),
  ];

  const changed = FULL
    ? tasks
    : tasks.filter(t => {
        const prev = prevLastMod.get(t.id);
        if (!prev) return true;
        if (t.lastModified > prev) return true;
        return !existsSync(t.mdPath);
      });
  console.log(
    `${changed.length} item(s) need content sync${FULL ? ' (--full)' : ''}.`,
  );

  // fetch + convert + write
  const limit = pLimit(2);
  let done = 0;
  await Promise.all(
    changed.map(t =>
      limit(async () => {
        const i = ++done;
        console.log(`  [${i}/${changed.length}] ${t.label} ${t.title}`);
        const blocks = await fetchBlocksDeep(t.id);
        const ctx: MdContext = { pageID: t.id, imagesToFetch: [] };
        const md = blocksToMd(blocks, ctx);

        if (DRY_RUN) return;

        ensureDir(dirname(t.mdPath));
        writeFileSync(t.mdPath, md);

        for (const img of ctx.imagesToFetch) {
          const target = join(IMAGES_DIR, t.id, `${img.blockId}${img.ext}`);
          if (existsSync(target)) continue;
          try {
            await downloadImage(img.url, target);
          } catch {
            console.warn(`    image fetch failed: ${img.url}`);
          }
        }
      }),
    ),
  );

  const elapsed = ((Date.now() - startTime.getTime()) / 1000).toFixed(1);
  console.log(
    `\n${DRY_RUN ? 'Would have written' : 'Wrote'} manifest + ${changed.length} content file(s). ${elapsed}s.`,
  );
}

main().catch(e => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
