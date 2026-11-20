import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const TOKEN = 'x'.repeat(32);

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  it('refuses to start without ADMIN_TOKEN', () => {
    const err = errorOf(() => loadConfig({}));
    expect(err.issues).toEqual([expect.stringMatching(/^ADMIN_TOKEN: is required/)]);
    expect(err.message).toContain('Invalid configuration');
  });

  it('treats a blank ADMIN_TOKEN as missing', () => {
    expect(errorOf(() => loadConfig({ ADMIN_TOKEN: '   ' })).issues[0]).toMatch(/ADMIN_TOKEN: is required/);
  });

  it('rejects a short ADMIN_TOKEN without echoing it', () => {
    const err = errorOf(() => loadConfig({ ADMIN_TOKEN: 'short-secret-value' }));
    expect(err.issues[0]).toMatch(/ADMIN_TOKEN: must be at least 32 characters/);
    expect(err.message).not.toContain('short-secret-value');
  });

  it('rejects an ADMIN_TOKEN containing whitespace', () => {
    expect(errorOf(() => loadConfig({ ADMIN_TOKEN: `${TOKEN} ${TOKEN}` })).issues[0]).toMatch(/whitespace/);
  });

  it('applies the documented defaults', () => {
    const cwd = path.resolve('/srv/surgeonpulse');
    const config = loadConfig({ ADMIN_TOKEN: TOKEN }, cwd);
    expect(config).toEqual({
      port: 8787,
      host: '127.0.0.1',
      dataDir: path.resolve(cwd, 'data'),
      adminToken: TOKEN,
      corsOrigins: [],
      maxUploadMb: 25,
      bodyLimit: 25 * 1024 * 1024,
      trustProxy: false,
      logLevel: 'info',
    });
  });

  it('parses every variable', () => {
    const cwd = path.resolve('/srv');
    const config = loadConfig(
      {
        ADMIN_TOKEN: TOKEN,
        PORT: '9000',
        HOST: '0.0.0.0',
        DATA_DIR: 'var/sp',
        CORS_ORIGINS: ' https://dash.example.org/ , http://localhost:5173,https://dash.example.org ',
        MAX_UPLOAD_MB: '2.5',
        TRUST_PROXY: 'TRUE',
        LOG_LEVEL: 'Warn',
      },
      cwd,
    );
    expect(config.port).toBe(9000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.dataDir).toBe(path.resolve(cwd, 'var/sp'));
    expect(config.corsOrigins).toEqual(['https://dash.example.org', 'http://localhost:5173']);
    expect(config.bodyLimit).toBe(Math.floor(2.5 * 1024 * 1024));
    expect(config.trustProxy).toBe(true);
    expect(config.logLevel).toBe('warn');
  });

  it('keeps an absolute DATA_DIR as is', () => {
    const abs = path.resolve('/data');
    expect(loadConfig({ ADMIN_TOKEN: TOKEN, DATA_DIR: abs }).dataDir).toBe(abs);
  });

  it('reports every invalid variable at once', () => {
    const err = errorOf(() =>
      loadConfig({
        ADMIN_TOKEN: TOKEN,
        PORT: 'eighty',
        CORS_ORIGINS: '*,ftp://files.example.org,https://ok.example.org/path',
        MAX_UPLOAD_MB: '0',
        TRUST_PROXY: 'maybe',
        LOG_LEVEL: 'loud',
      }),
    );
    const names = err.issues.map((i) => i.split(':')[0]);
    expect(names).toEqual(expect.arrayContaining(['PORT', 'CORS_ORIGINS', 'MAX_UPLOAD_MB', 'TRUST_PROXY', 'LOG_LEVEL']));
    expect(err.issues.filter((i) => i.startsWith('CORS_ORIGINS'))).toHaveLength(3);
  });

  it('rejects out-of-range ports', () => {
    expect(errorOf(() => loadConfig({ ADMIN_TOKEN: TOKEN, PORT: '70000' })).issues[0]).toMatch(/^PORT:/);
  });
});
