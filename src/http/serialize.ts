import type { AppConfig } from '../config.js';
import type { Instance, User } from '../domain/types.js';

export function serializeInstance(instance: Instance, config: AppConfig) {
  return {
    id: instance.id,
    companyName: instance.companyName,
    siteName: instance.siteName,
    hostname: instance.hostname,
    status: instance.status,
    url: instance.status === 'ready' ? `https://${instance.hostname}` : null,
    errorMessage: instance.errorMessage,
    createdAt: instance.createdAt.toISOString(),
    updatedAt: instance.updatedAt.toISOString(),
    ownerUserId: instance.ownerUserId,
  };
}

export function serializeUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt.toISOString(),
  };
}
