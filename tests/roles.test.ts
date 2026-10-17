import { describe, expect, it } from 'vitest';
import { resolveRole } from '../src/auth/roles.js';
import { testConfig } from '../src/config.js';

const config = testConfig();

describe('resolveRole', () => {
  it('grants admin for a mapped Truemoi role', () => {
    expect(
      resolveRole({ truemoiRole: 'platform-admin', email: 'x@test', existingRole: null, config }),
    ).toBe('admin');
  });

  it('grants admin for an allow-listed email', () => {
    expect(
      resolveRole({ truemoiRole: undefined, email: 'root@example.test', existingRole: null, config }),
    ).toBe('admin');
  });

  it('defaults new users to user', () => {
    expect(
      resolveRole({ truemoiRole: 'member', email: 'x@test', existingRole: null, config }),
    ).toBe('user');
  });

  it('preserves a manually granted platform admin role', () => {
    expect(
      resolveRole({ truemoiRole: 'member', email: 'x@test', existingRole: 'admin', config }),
    ).toBe('admin');
  });

  it('is case-insensitive for role and email', () => {
    expect(
      resolveRole({ truemoiRole: 'PLATFORM-ADMIN', email: 'x@test', existingRole: null, config }),
    ).toBe('admin');
    expect(
      resolveRole({ truemoiRole: undefined, email: 'ROOT@example.test', existingRole: null, config }),
    ).toBe('admin');
  });
});
