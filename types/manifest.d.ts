export type Status = 'Empty' | 'Auto Translated' | 'Reviewed';

export interface Entry {
  notionID: string;
  title: string;
  etymology?: string;
  stat?: Status;
  lastModified: string;
}

export interface Node {
  enEntry: Entry;
  zhEntry?: Entry;
  children: Node[];
}

export type BlogStat = 'Draft' | 'Publish' | 'Archive';

export interface BlogEntry {
  notionID: string;
  title: string;
  created: string;          /* ISO 8601 — Notion's `Created time` (auto, fallback) */
  date?: string;            /* user-set `Date` text property; convention: ISO 8601 'YYYY-MM-DD'. Used for display + sort when present. */
  lastModified: string;
  stat: BlogStat;
}

export interface Manifest {
  tree: Node[];
  posts: BlogEntry[];        /* flat, no hierarchy; sort by `created` desc */
}