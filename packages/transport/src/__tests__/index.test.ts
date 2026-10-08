import { describe, it, expect } from 'vitest';
import { TRANSPORT_PACKAGE_VERSION } from '../index';

describe('@kindora/transport', () => {
  it('exposes a version constant', () => {
    expect(TRANSPORT_PACKAGE_VERSION).toBe('0.1.0');
  });
});
