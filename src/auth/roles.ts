import type { AppConfig } from '../config.js';
import type { UserRole } from '../domain/types.js';

/**
 * Resolve the platform role for a signing-in user.
 *
 * Truemoi is the source of truth for *identity*, and its `role` claim plus a
 * configured email allow-list grant platform privileges. A role already stored
 * in the platform database is preserved unless the identity provider explicitly
 * grants admin — so an operator can promote a user manually without that being
 * silently reverted at the next login, while a revoked Truemoi admin is still
 * demoted to `user`.
 */
export function resolveRole(params: {
  truemoiRole: string | undefined | null;
  email: string;
  existingRole: UserRole | null;
  config: Pick<AppConfig, 'TRUEMOI_ADMIN_ROLES' | 'ADMIN_EMAILS'>;
}): UserRole {
  const { truemoiRole, email, existingRole, config } = params;
  const role = (truemoiRole ?? '').trim().toLowerCase();
  const adminRoles = config.TRUEMOI_ADMIN_ROLES.map((r) => r.toLowerCase());
  const adminEmails = config.ADMIN_EMAILS.map((e) => e.toLowerCase());

  if (role && adminRoles.includes(role)) return 'admin';
  if (adminEmails.includes(email.trim().toLowerCase())) return 'admin';
  return existingRole === 'admin' ? 'admin' : 'user';
}

export function isAdmin(role: UserRole): boolean {
  return role === 'admin';
}
