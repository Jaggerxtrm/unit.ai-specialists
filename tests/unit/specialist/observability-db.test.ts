import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObservabilityDbLocation } from '../../../src/specialist/observability-db.js';

describe('observability-db', () => {
  let tempDir: string;
  let tempDbLocation: ObservabilityDbLocation;
  const ORIGINAL_XDG = process.env.XDG_DATA_HOME;

  beforeEach(() => {
    tempDir = join(tmpdir(), `test-obs-db-${crypto.randomUUID()}`);
    tempDbLocation = {
      gitRoot: tempDir,
      dbDirectory: join(tempDir, '.specialists', 'db'),
      dbPath: join(tempDir, '.specialists', 'db', 'observability.db'),
      dbWalPath: join(tempDir, '.specialists', 'db', 'observability.db-wal'),
      dbShmPath: join(tempDir, '.specialists', 'db', 'observability.db-shm'),
      source: 'git-root',
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (ORIGINAL_XDG === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = ORIGINAL_XDG;
  });

  describe('OBSERVABILITY_SCHEMA_VERSION', () => {
    it('exports schema version constant', async () => {
      const { OBSERVABILITY_SCHEMA_VERSION } = await import('../../../src/specialist/observability-db.js');
      
      expect(OBSERVABILITY_SCHEMA_VERSION).toBe(15);
      expect(typeof OBSERVABILITY_SCHEMA_VERSION).toBe('number');
    });
  });

  describe('isObservabilityDbInitialized', () => {
    it('returns false when db file does not exist', async () => {
      const { isObservabilityDbInitialized } = await import('../../../src/specialist/observability-db.js');
      
      expect(isObservabilityDbInitialized(tempDbLocation)).toBe(false);
    });

    it('returns false when db file exists but is not initialized', async () => {
      const { ensureObservabilityDbFile, isObservabilityDbInitialized } = await import('../../../src/specialist/observability-db.js');
      
      // Create empty db file
      ensureObservabilityDbFile(tempDbLocation);
      
      expect(isObservabilityDbInitialized(tempDbLocation)).toBe(false);
    });

    it('returns true when db is fully initialized with schema_version', async () => {
      const { ensureObservabilityDbFile, isObservabilityDbInitialized } = await import('../../../src/specialist/observability-db.js');
      const { initSchema } = await import('../../../src/specialist/observability-sqlite.js');
      
      // Create and initialize db
      ensureObservabilityDbFile(tempDbLocation);
      const db = new Database(tempDbLocation.dbPath);
      initSchema(db);
      db.close();
      
      expect(isObservabilityDbInitialized(tempDbLocation)).toBe(true);
    });

    it('returns false when schema_version table exists but version row is missing', async () => {
      const { ensureObservabilityDbFile, isObservabilityDbInitialized } = await import('../../../src/specialist/observability-db.js');
      
      // Create db and add table but no version row
      ensureObservabilityDbFile(tempDbLocation);
      const db = new Database(tempDbLocation.dbPath);
      db.run('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)');
      db.close();
      
      expect(isObservabilityDbInitialized(tempDbLocation)).toBe(false);
    });

    it('returns false when schema_version has wrong version number', async () => {
      const { ensureObservabilityDbFile, isObservabilityDbInitialized, OBSERVABILITY_SCHEMA_VERSION } = await import('../../../src/specialist/observability-db.js');
      
      // Create db with wrong version
      ensureObservabilityDbFile(tempDbLocation);
      const db = new Database(tempDbLocation.dbPath);
      db.run('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)');
      db.run('INSERT INTO schema_version (version, applied_at_ms) VALUES (999, strftime(\'%s\', \'now\') * 1000)');
      db.close();
      
      expect(isObservabilityDbInitialized(tempDbLocation)).toBe(false);
    });
  });

  describe('resolveObservabilityDbLocation', () => {
    it('resolves to git-root location when XDG_DATA_HOME is not set', async () => {
      const { resolveObservabilityDbLocation } = await import('../../../src/specialist/observability-db.js');
      
      delete process.env.XDG_DATA_HOME;
      const location = resolveObservabilityDbLocation(tempDir);
      
      expect(location.source).toBe('git-root');
      expect(location.dbPath).toContain('.specialists/db/observability.db');
    });

    it('resolves to XDG_DATA_HOME when set', async () => {
      const { resolveObservabilityDbLocation } = await import('../../../src/specialist/observability-db.js');
      
      const xdgHome = join(tempDir, 'custom-xdg');
      process.env.XDG_DATA_HOME = xdgHome;
      
      const location = resolveObservabilityDbLocation(tempDir);
      
      expect(location.source).toBe('xdg-data-home');
      expect(location.dbPath).toBe(join(xdgHome, 'specialists', 'observability.db'));
    });
  });

  describe('ensureObservabilityDbFile', () => {
    it('creates db directory without creating empty db file', async () => {
      const { ensureObservabilityDbFile } = await import('../../../src/specialist/observability-db.js');
      
      const result = ensureObservabilityDbFile(tempDbLocation);
      
      expect(result.created).toBe(true);
      expect(existsSync(tempDbLocation.dbPath)).toBe(false);
      expect(existsSync(tempDbLocation.dbDirectory)).toBe(true);
    });

    it('returns created=false when file already exists', async () => {
      const { ensureObservabilityDbFile } = await import('../../../src/specialist/observability-db.js');
      
      mkdirSync(tempDbLocation.dbDirectory, { recursive: true });
      writeFileSync(tempDbLocation.dbPath, 'sqlite data');
      
      const result = ensureObservabilityDbFile(tempDbLocation);
      
      expect(result.created).toBe(false);
    });

    it('sets file permissions to 0o644', async () => {
      const { ensureObservabilityDbFile } = await import('../../../src/specialist/observability-db.js');
      const { statSync } = await import('node:fs');
      
      mkdirSync(tempDbLocation.dbDirectory, { recursive: true });
      writeFileSync(tempDbLocation.dbPath, 'sqlite data');
      ensureObservabilityDbFile(tempDbLocation);
      
      const mode = statSync(tempDbLocation.dbPath).mode & 0o777;
      expect(mode).toBe(0o644);
    });
  });
});
