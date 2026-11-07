import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathMatch, textMatches } from '../../domain/search';
import type { SearchHit } from '../../contracts/project';
export class MetadataStore {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'metadata.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version > 3) {
      this.db.close();
      throw new Error('This metadata database needs a newer Loom version.');
    }
    if (version === 0)
      this.db.exec(
        'BEGIN; CREATE TABLE projects (path TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1; COMMIT;',
      );
    if (version < 2)
      this.db.exec(
        'BEGIN; CREATE TABLE file_index (project TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(project,id)); CREATE INDEX file_index_project ON file_index(project); PRAGMA user_version=2; COMMIT;',
      );
    if (version < 3)
      this.db.exec(`
      BEGIN;
      CREATE TABLE project_library (path TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL, last_opened REAL NOT NULL);
      INSERT INTO project_library SELECT path, json_extract(value,'$.id'), json_extract(value,'$.name'), 0
      FROM projects WHERE json_valid(value) AND json_type(value,'$.id')='text' AND json_type(value,'$.name')='text';
      PRAGMA user_version=3; COMMIT;
    `);
  }
  rememberProject(path: string, id: string, name: string): void {
    this.db
      .prepare(
        'INSERT INTO project_library VALUES (?,?,?,?) ON CONFLICT(path) DO UPDATE SET id=excluded.id,name=excluded.name,last_opened=excluded.last_opened',
      )
      .run(path, id, name, Date.now());
  }
  recentProjects(): Array<{ path: string; id: string; name: string; lastOpened: number }> {
    return this.db
      .prepare(
        'SELECT path,id,name,last_opened AS lastOpened FROM project_library ORDER BY last_opened DESC,path',
      )
      .all() as Array<{ path: string; id: string; name: string; lastOpened: number }>;
  }
  forgetProject(path: string): void {
    this.db.prepare('DELETE FROM project_library WHERE path=?').run(path);
    if (this.get('lastProject') === path)
      this.db.prepare('DELETE FROM preferences WHERE key=?').run('lastProject');
  }
  index(project: string, files: Array<{ id: string; path: string; content: string }>): void {
    const rows = this.db
      .prepare('SELECT id,path,content FROM file_index WHERE project=?')
      .all(project) as Array<{ id: string; path: string; content: string }>;
    const desired = new Map(files.map((file) => [file.id, file]));
    if (
      rows.length === files.length &&
      rows.every((row) => {
        const file = desired.get(row.id);
        return file?.path === row.path && file.content === row.content;
      })
    )
      return;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM file_index WHERE project=?').run(project);
      const insert = this.db.prepare('INSERT INTO file_index VALUES (?,?,?,?)');
      for (const f of files) insert.run(project, f.id, f.path, f.content);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  /** Includes direct same-connection writes, so a cleared derived index is repaired. */
  changeCount(): number {
    return (this.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  }
  search(project: string, query: string): string[] {
    return [...new Set(this.hits(project, query).map((hit) => hit.fileId))];
  }
  hits(project: string, query: string): SearchHit[] {
    if (!query.trim() || query.length > 500) return [];
    let result: Array<SearchHit & { score: number }> = [];
    const rows = this.db
      .prepare('SELECT id,path,content FROM file_index WHERE project=? ORDER BY path LIMIT 2000')
      .iterate(project);
    for (const entry of rows) {
      const row = entry as { id: string; path: string; content: string };
      const filename = pathMatch(row.path, query);
      if (filename)
        result.push({
          fileId: row.id,
          path: row.path,
          kind: 'path',
          line: 1,
          offset: 0,
          length: 0,
          snippet: 'Filename match',
          ranges: [],
          pathRanges: filename.ranges,
          approximate: filename.approximate,
          score: filename.score,
        });
      for (const match of textMatches(row.content, query)) {
        const lineStart = row.content.lastIndexOf('\n', match.from - 1) + 1;
        const from = Math.max(lineStart, match.from - 60);
        const newline = row.content.indexOf('\n', match.from);
        const to = Math.min(from + 200, newline < 0 ? row.content.length : newline);
        const prefix = from > lineStart ? '…' : '';
        const suffix = to < (newline < 0 ? row.content.length : newline) ? '…' : '';
        result.push({
          fileId: row.id,
          path: row.path,
          kind: 'content',
          line: row.content.slice(0, match.from).split('\n').length,
          offset: match.from,
          length: match.to - match.from,
          snippet: prefix + row.content.slice(from, to) + suffix,
          ranges: match.ranges
            .filter((range) => range.from < to && range.to > from)
            .map((range) => ({
              from: Math.max(range.from, from) - from + prefix.length,
              to: Math.min(range.to, to) - from + prefix.length,
            })),
          pathRanges: [],
          approximate: match.approximate,
          score: match.score,
        });
      }
      // Retain globally best results, so a late exact match beats early approximate matches.
      result.sort(
        (a, b) => a.score - b.score || a.path.localeCompare(b.path) || a.offset - b.offset,
      );
      if (result.length > 200) result.length = 200;
    }
    return result.map(({ score: _score, ...hit }) => hit);
  }
  get(key: string): string | null {
    return (
      (
        this.db.prepare('SELECT value FROM preferences WHERE key=?').get(key) as
          { value: string } | undefined
      )?.value ?? null
    );
  }
  set(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO preferences VALUES (?,?)').run(key, value);
  }
  load(path: string): string | null {
    return (
      (
        this.db.prepare('SELECT value FROM projects WHERE path=?').get(path) as
          { value: string } | undefined
      )?.value ?? null
    );
  }
  save(path: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO projects VALUES (?,?) ON CONFLICT(path) DO UPDATE SET value=excluded.value WHERE projects.value<>excluded.value',
      )
      .run(path, value);
  }
  close(): void {
    this.db.close();
  }
}
