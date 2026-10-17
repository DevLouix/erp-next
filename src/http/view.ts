import type { InstanceStatus } from '../domain/types.js';

const PENDING: InstanceStatus[] = ['queued', 'provisioning', 'installing', 'configuring'];

export function statusClass(status: InstanceStatus): 'ready' | 'failed' | 'pending' {
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  return PENDING.includes(status) ? 'pending' : 'pending';
}

export function statusBadge(status: InstanceStatus): string {
  return `<span class="badge ${statusClass(status)}">${status}</span>`;
}
