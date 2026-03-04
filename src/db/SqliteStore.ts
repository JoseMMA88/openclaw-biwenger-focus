import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

import { INIT_SQL } from './schema.js';

export class SqliteStore {
  private readonly dbPath: string;
  private sql: SqlJsStatic | null = null;
  private db: Database | null = null;
  private inTransaction = false;

  constructor(dbPath: string) {
    this.dbPath = resolve(dbPath);
  }

  async init(): Promise<void> {
    if (this.db) return;

    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
    this.sql = await initSqlJs({
      locateFile: (file: string) => join(packageRoot, 'node_modules', 'sql.js', 'dist', file)
    });

    mkdirSync(dirname(this.dbPath), { recursive: true });

    try {
      const bytes = readFileSync(this.dbPath);
      this.db = new this.sql.Database(bytes);
    } catch {
      this.db = new this.sql.Database();
    }

    this.db.run('PRAGMA foreign_keys = ON;');
    this.db.run(INIT_SQL);
    this.persist();
  }

  close(): void {
    if (!this.db) return;
    this.persist();
    this.db.close();
    this.db = null;
    this.sql = null;
  }

  run(sql: string, params: Array<string | number | null | Uint8Array> = []): void {
    const db = this.requireDb();
    db.run(sql, params);
    if (!this.inTransaction) {
      this.persist();
    }
  }

  get<T extends Record<string, unknown>>(
    sql: string,
    params: Array<string | number | null | Uint8Array> = []
  ): T | null {
    const db = this.requireDb();
    const stmt = db.prepare(sql, params);

    try {
      if (!stmt.step()) return null;
      return stmt.getAsObject() as T;
    } finally {
      stmt.free();
    }
  }

  all<T extends Record<string, unknown>>(
    sql: string,
    params: Array<string | number | null | Uint8Array> = []
  ): T[] {
    const db = this.requireDb();
    const stmt = db.prepare(sql, params);
    const rows: T[] = [];

    try {
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  transaction<T>(fn: () => T): T {
    const db = this.requireDb();
    this.inTransaction = true;
    db.exec('BEGIN IMMEDIATE;');

    try {
      const result = fn();
      db.exec('COMMIT;');
      this.persist();
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // If SQLite already auto-rolled back, keep the original error.
      }
      this.persist();
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error('SQLite store not initialized. Call init() first.');
    }
    return this.db;
  }

  private persist(): void {
    if (!this.db) return;
    const data = this.db.export();
    const tmpPath = `${this.dbPath}.tmp`;
    writeFileSync(tmpPath, Buffer.from(data));
    renameSync(tmpPath, this.dbPath);
    rmSync(tmpPath, { force: true });
  }
}
