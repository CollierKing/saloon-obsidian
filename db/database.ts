import { drizzle } from 'drizzle-orm/sql-js';
import initSqlJs, { Database } from 'sql.js';
import { approvalActions, terms } from './schema';
import { ALL_MIGRATIONS } from './migrations';
import type { Vault } from 'obsidian';

// MARK: - DrizzleDatabase Class

export class DrizzleDatabase {
  private sqliteDb: Database | null = null;
  public db: ReturnType<typeof drizzle> | null = null;

  // MARK: - Initialization

  /**
   * Initialize the database with Drizzle ORM
   * @param wasmBinary - The sql-wasm.wasm binary buffer
   * @param dbPath - Path to the database file
   * @param vault - Obsidian vault for file operations
   */
  async initialize(wasmBinary: ArrayBuffer, dbPath: string, vault: Vault): Promise<void> {
    // Initialize sql.js with WASM binary
    const SQL = await initSqlJs({
      wasmBinary: new Uint8Array(wasmBinary)
    });

    const adapter = vault.adapter;
    const fileExists = await adapter.exists(dbPath);

    if (fileExists) {
      // Load existing database
      const buffer = await adapter.readBinary(dbPath);
      this.sqliteDb = new SQL.Database(new Uint8Array(buffer));
      console.log('Loaded existing database from:', dbPath);
    } else {
      // Create new database
      this.sqliteDb = new SQL.Database();
      console.log('Created new database at:', dbPath);
    }

    // Run pending migrations (for both new and existing databases)
    const migrationsRun = await this.runMigrations();

    // Save if any migrations were applied
    if (migrationsRun > 0 || !fileExists) {
      await this.saveDatabase(dbPath, vault);
    }

    // Wrap with Drizzle ORM for type-safe queries
    this.db = drizzle(this.sqliteDb);
  }

  // MARK: - Migrations

  /**
   * Run pending database migrations
   * Tracks applied migrations in _migrations table
   * @returns Number of migrations applied
   */
  private async runMigrations(): Promise<number> {
    if (!this.sqliteDb) {
      throw new Error('Database not initialized');
    }

    // Create migrations tracking table if it doesn't exist
    this.sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    // Get list of applied migrations
    const result = this.sqliteDb.exec('SELECT id FROM _migrations ORDER BY id');
    const appliedIds = new Set<number>();
    if (result.length > 0) {
      result[0].values.forEach(row => appliedIds.add(row[0] as number));
    }

    // Run any unapplied migrations
    let migrationsRun = 0;
    for (let i = 0; i < ALL_MIGRATIONS.length; i++) {
      if (!appliedIds.has(i)) {
        console.log(`Running migration ${i}...`);
        this.sqliteDb.run(ALL_MIGRATIONS[i]);
        this.sqliteDb.run(
          'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
          [i, new Date().toISOString()]
        );
        migrationsRun++;
      }
    }

    if (migrationsRun > 0) {
      console.log(`Applied ${migrationsRun} new migration(s)`);
    } else {
      console.log('Database schema up to date');
    }

    return migrationsRun;
  }

  // MARK: - Database Operations

  /**
   * Save database to disk
   */
  async saveDatabase(dbPath: string, vault: Vault): Promise<void> {
    if (!this.sqliteDb) {
      throw new Error('Database not initialized');
    }

    const data = this.sqliteDb.export();
    await vault.adapter.writeBinary(dbPath, data.buffer);
    console.log('Database saved to:', dbPath);
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.sqliteDb) {
      this.sqliteDb.close();
      this.sqliteDb = null;
      this.db = null;
    }
  }
}

// MARK: - Exports

// Export schema tables for use with Drizzle queries
export { approvalActions, terms };
