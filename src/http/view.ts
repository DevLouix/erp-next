import type { InstanceStatus } from '../domain/types.js';

const PENDING: InstanceStatus[] = ['queued', 'provisioning', 'installing', 'configuring'];

export function statusClass(status: InstanceStatus): 'ready' | 'failed' | 'pending' {
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  return PENDING.includes(status) ? 'pending' : 'pending';
}

export function statusBadge(status: InstanceStatus): string {
  const labels: Record<InstanceStatus, string> = {
    queued: 'Queued',
    provisioning: 'Provisioning',
    installing: 'Installing',
    configuring: 'Configuring',
    ready: 'Ready',
    failed: 'Needs attention',
    deleting: 'Deleting',
  };
  return `<span class="badge ${statusClass(status)}">${labels[status]}</span>`;
}
