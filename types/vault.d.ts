/** Shapes read out of the Obsidian vault. The vault *is* the manifest:
 *  folder layout is the wiki tree, so nothing here is persisted to disk. */

export type Stat = 'Auto Translated' | 'Reviewed';

/** One wiki note. `Foo/Foo.md` is the note for folder `Foo`; the rest of
 *  that folder are its children. */
export interface Entry {
  slug: string[];                          /* URL segments under /ragriff/ */
  title: string;                           /* en title — the note's filename */
  zhTitle?: string;                        /* aliases[0] */
  stat?: Stat;                             /* frontmatter `stat.en` */
  etymology: { en?: string; zh?: string };
  tentative: { en?: boolean; zh?: boolean }; /* frontmatter `name_tentative.*` */
  body: { en: string; zh: string };        /* raw markdown of each :::lang block */
  children: Entry[];
}

export interface Post {
  slug: string;
  title: string;
  date: string;                            /* ISO 'YYYY-MM-DD'; frontmatter `date`, else file mtime */
  body: string;                            /* single-language, no :::lang blocks */
}
