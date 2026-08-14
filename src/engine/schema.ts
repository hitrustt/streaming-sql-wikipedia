/**
 * The `edits` table: the shape every Wikimedia event is normalized into.
 *
 * The engine is deliberately built around one wide, flat, strongly-typed table.
 * A streaming engine that has to reason about joins is a much larger project,
 * and the interesting problems here (windowing, incremental aggregation, high
 * cardinality) all live on a single stream. Keeping the schema flat also means
 * the column store can be a plain array-per-column with no nesting.
 */

export type ColType = 'int' | 'float' | 'string' | 'bool' | 'timestamp';

export interface Column {
  name: string;
  type: ColType;
  doc: string;
  /** Surfaced in the UI's field list; high-cardinality columns are excluded. */
  facetable: boolean;
}

export const COLUMNS: readonly Column[] = [
  { name: 'ts', type: 'timestamp', doc: 'When the edit was saved (UTC).', facetable: false },
  { name: 'wiki', type: 'string', doc: 'Wiki domain, e.g. en.wikipedia.org.', facetable: true },
  { name: 'lang', type: 'string', doc: 'Language code parsed from the domain.', facetable: true },
  { name: 'project', type: 'string', doc: 'wikipedia, wiktionary, commons, wikidata, ...', facetable: true },
  { name: 'type', type: 'string', doc: 'edit, new, or log.', facetable: true },
  { name: 'title', type: 'string', doc: 'Page title.', facetable: false },
  { name: 'user', type: 'string', doc: 'Editor username, or IP for anonymous edits.', facetable: false },
  { name: 'is_bot', type: 'bool', doc: 'True if the edit was flagged as a bot edit.', facetable: true },
  { name: 'is_anon', type: 'bool', doc: 'True if the editor was not logged in.', facetable: true },
  { name: 'is_minor', type: 'bool', doc: 'True if flagged as a minor edit.', facetable: true },
  { name: 'namespace', type: 'int', doc: 'MediaWiki namespace id (0 = article).', facetable: true },
  { name: 'delta', type: 'int', doc: 'Bytes added, negative for removals.', facetable: false },
  { name: 'new_len', type: 'int', doc: 'Page size in bytes after the edit.', facetable: false },
  { name: 'comment', type: 'string', doc: 'Edit summary written by the editor.', facetable: false },
  { name: 'uri', type: 'string', doc: 'Canonical URL of the edited page.', facetable: false },
] as const;

export const COLUMN_NAMES: readonly string[] = COLUMNS.map((c) => c.name);

export const COLUMNS_BY_NAME: ReadonlyMap<string, Column> = new Map(
  COLUMNS.map((c) => [c.name, c]),
);

/** Values used when a field is missing from an event. */
export function zeroFor(type: ColType): string | number | boolean {
  switch (type) {
    case 'string':
      return '';
    case 'bool':
      return false;
    case 'float':
      return 0;
    default:
      return 0;
  }
}

export type CellValue = string | number | boolean;

/** One normalized event. Keys are always the full column set. */
export type EditRow = Record<string, CellValue>;
