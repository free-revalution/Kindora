import { describe, it, expect } from 'vitest';
import { STORAGE_PACKAGE_VERSION, STORAGE_TABLES } from '../index';

describe('@kindora/storage', () => {
  it('exposes a version constant', () => {
    expect(STORAGE_PACKAGE_VERSION).toBe('0.1.0');
  });

  it('declares every V0.1 table from 开发手册.md § 37', () => {
    expect(STORAGE_TABLES).toContain('profiles');
    expect(STORAGE_TABLES).toContain('agents');
    expect(STORAGE_TABLES).toContain('llm_configs');
    expect(STORAGE_TABLES).toContain('connections');
    expect(STORAGE_TABLES).toContain('matches');
    expect(STORAGE_TABLES).toContain('conversations');
    expect(STORAGE_TABLES).toContain('messages');
    expect(STORAGE_TABLES).toContain('permissions');
  });
});
