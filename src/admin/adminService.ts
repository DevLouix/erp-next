import type { Store } from '../domain/store.js';
import type { AuditLogEntry, Instance, User } from '../domain/types.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.js';
import { InstanceService } from '../instances/instanceService.js';
import { SessionService } from '../auth/session.js';
import type { AppConfig } from '../config.js';

/**
 * Administrative operations. Every method re-checks the acting user's role —
 * route-level guards are not the only line of defence.
 */
export class AdminService {
  private readonly sessions: SessionService;

  constructor(
    private readonly store: Store,
    private readonly instances: InstanceService,
    private readonly config: AppConfig,
  ) {
    this.sessions = new SessionService(store, config);
  }

  private assertAdmin(actor: User): void {
    if (actor.role !== 'admin') throw new ForbiddenError('Administrator role required');
  }

  async listUsers(actor: User): Promise<User[]> {
    this.assertAdmin(actor);
    return this.store.listUsers();
  }

  async listInstances(actor: User): Promise<Instance[]> {
    this.assertAdmin(actor);
    return this.store.listAllInstances();
  }

  async listAudit(actor: User, limit = 100): Promise<AuditLogEntry[]> {
    this.assertAdmin(actor);
    return this.store.listAudit(Math.min(Math.max(limit, 1), 500));
  }

  async retryInstance(actor: User, instanceId: string): Promise<Instance> {
    this.assertAdmin(actor);
    return this.instances.retry(actor, instanceId);
  }

  async setUserDisabled(actor: User, userId: string, disabled: boolean): Promise<User> {
    this.assertAdmin(actor);
    if (actor.id === userId && disabled) {
      throw new ValidationError('You cannot disable your own account');
    }
    const target = await this.store.findUserById(userId);
    if (!target) throw new NotFoundError('User not found');
    const updated = await this.store.updateUser(userId, { disabled });
    if (disabled) {
      // Revoke every active session immediately.
      await this.sessions.destroyAllForUser(userId);
    }
    await this.store.recordAudit({
      actorUserId: actor.id,
      action: disabled ? 'user.disable' : 'user.enable',
      targetType: 'user',
      targetId: userId,
      metadata: { email: target.email },
    });
    return updated;
  }

  async setUserRole(actor: User, userId: string, role: 'user' | 'admin'): Promise<User> {
    this.assertAdmin(actor);
    if (actor.id === userId && role !== 'admin') {
      throw new ValidationError('You cannot remove your own administrator role');
    }
    const target = await this.store.findUserById(userId);
    if (!target) throw new NotFoundError('User not found');
    const updated = await this.store.updateUser(userId, { role });
    await this.store.recordAudit({
      actorUserId: actor.id,
      action: 'user.role_change',
      targetType: 'user',
      targetId: userId,
      metadata: { from: target.role, to: role },
    });
    return updated;
  }
}
