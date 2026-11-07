import { describe, expect, it } from 'vitest';
import { testDatabaseUrl, testRedisUrl } from './setup/test-db.js';

describe('Testdatenbank-Schutz', () => {
  it('haengt _test an den Namen der normalen Datenbank', () => {
    expect(testDatabaseUrl({ DATABASE_URL: 'postgres://panel:pw@127.0.0.1:5432/panel' }))
      .toBe('postgres://panel:pw@127.0.0.1:5432/panel_test');
  });
  it('nimmt TEST_DATABASE_URL, wenn gesetzt', () => {
    expect(testDatabaseUrl({ DATABASE_URL: 'postgres://a@h/panel', TEST_DATABASE_URL: 'postgres://a@h/ci_test' }))
      .toBe('postgres://a@h/ci_test');
  });
  it('verweigert eine TEST_DATABASE_URL ohne "test" im Namen', () => {
    expect(() => testDatabaseUrl({ TEST_DATABASE_URL: 'postgres://a@h/panel' })).toThrow(/Abbruch/);
  });
  it('laesst einen Namen mit "test" unveraendert', () => {
    expect(testDatabaseUrl({ DATABASE_URL: 'postgres://a@h/panel_test' })).toBe('postgres://a@h/panel_test');
  });
  it('Redis immer auf Datenbank 15', () => {
    expect(testRedisUrl({ REDIS_URL: 'redis://127.0.0.1:6379/0' })).toBe('redis://127.0.0.1:6379/15');
  });
  it('die Tests laufen gerade wirklich gegen die Testdatenbank', () => {
    expect(new URL(process.env.DATABASE_URL!).pathname).toMatch(/test/);
  });
});
