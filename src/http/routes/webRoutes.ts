import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { InstanceService } from '../../instances/instanceService.js';
import type { AdminService } from '../../admin/adminService.js';
import type { BackupService } from '../../admin/backupService.js';
import type { SiteBackupService } from '../../admin/siteBackupService.js';
import type { Store } from '../../domain/store.js';
import type { Instance, User } from '../../domain/types.js';
import { NotFoundError } from '../../domain/errors.js';
import { getAuth, requireAdmin, requireAuth } from '../../auth/middleware.js';
import { statusBadge } from '../view.js';

const createFormBody = z.object({ name: z.string().optional() });
const updateFormBody = z.object({ name: z.string().trim().min(1).max(100) });
const deleteFormBody = z.object({ confirmSiteName: z.string().min(1) });
const siteBackupSettingsForm = z.object({
  automaticEnabled: z.enum(['on']).optional(),
  intervalHours: z.enum(['24', '168']),
  s3Endpoint: z.string().optional(),
  s3Bucket: z.string().optional(),
  s3Region: z.string().optional(),
  s3AccessKeyId: z.string().optional(),
  s3SecretAccessKey: z.string().optional(),
  clearS3Credentials: z.enum(['on']).optional(),
});
const roleFormBody = z.object({ role: z.enum(['admin', 'user']) });
const disabledFormBody = z.object({ disabled: z.enum(['true', 'false']) });

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, body: string, user?: User | null): string {
  const nav = user
    ? `<nav>
        <a href="/dashboard">Dashboard</a>
        ${user.role === 'admin' ? '<a href="/admin">Admin</a>' : ''}
      <button type="button" class="theme-toggle" data-theme-toggle aria-label="Toggle color theme" title="Toggle color theme">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42m0-12.72-1.42 1.42m-9.88 9.88-1.42 1.42M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/></svg>
        <span>Theme</span>
      </button>
      <form method="post" action="/auth/logout" class="inline">
          <button type="submit" class="link">Sign out</button>
        </form>
        <span class="who">${escapeHtml(user.email)}</span>
      </nav>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · ERPNext Hosting</title>
  <style>
  :root { color-scheme: dark; --bg: #0b1220; --surface: #121e30; --surface-raised: #19283d; --line: #26364d; --text: #e6edf7; --muted: #97a8bf; --accent: #65a6ff; }
  :root[data-theme="light"] { color-scheme: light; --bg: #f2f6fb; --surface: #fff; --surface-raised: #eef3f9; --line: #dce4ef; --text: #172438; --muted: #5d6d82; --accent: #1d4ed8; }
    * { box-sizing: border-box; }
  body { font: 15px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--text); }
  header { min-height: 68px; padding: .8rem clamp(1rem, 4vw, 3rem); border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 1.5rem; background: var(--surface); }
  header h1 { font-size: 1.05rem; letter-spacing: -.02em; margin: 0; white-space: nowrap; }
  nav { display: flex; gap: 1.25rem; align-items: center; margin-left: auto; }
  nav a, .link { color: var(--accent); text-decoration: none; background: none; border: none; cursor: pointer; font: inherit; padding: 0; }
  nav a:hover, a:hover { text-decoration: underline; }
  .theme-toggle { display: inline-flex; align-items: center; gap: .4rem; background: var(--surface-raised); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: .4rem .65rem; cursor: pointer; font: inherit; font-size: .85rem; }
  .theme-toggle svg, .external-link-icon { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .who { color: var(--muted); font-size: .85rem; }
  .inline { display: inline; }
  main { max-width: 1180px; margin: 0 auto; padding: clamp(1.25rem, 4vw, 3rem); }
  .page-heading { display: flex; justify-content: space-between; gap: 1rem; align-items: end; margin: 0 0 1.5rem; }
  .page-heading h2 { font-size: clamp(1.5rem, 3vw, 2rem); margin: 0; letter-spacing: -.035em; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: clamp(1rem, 3vw, 1.5rem); margin-bottom: 1.25rem; box-shadow: 0 10px 30px #0002; }
  .card h2, .card h3 { margin-top: 0; letter-spacing: -.02em; }
  form.row { display: flex; gap: .75rem; flex-wrap: wrap; align-items: end; }
  label { display: block; font-size: .82rem; color: var(--muted); margin-bottom: .35rem; }
  input[type=text], input[type=password], input[type=file] { padding: .68rem .8rem; border-radius: 8px; border: 1px solid #40516a; background: var(--bg); color: inherit; min-width: min(260px, 100%); font: inherit; }
  button[type=submit], button.action { background: #2563eb; color: white; border: 1px solid #3b82f6; border-radius: 8px; padding: .65rem 1rem; cursor: pointer; font: inherit; font-weight: 600; }
  button.danger { background: #991b1b; border-color: #dc2626; }
  button.secondary { background: var(--surface-raised); border-color: #40516a; }
  button:focus-visible, a:focus-visible, input:focus-visible { outline: 3px solid #60a5fa; outline-offset: 2px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .75rem .6rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; }
    .badge { padding: .15rem .5rem; border-radius: 999px; font-size: .75rem; font-weight: 600; }
    .badge.ready { background: #065f46; color: #a7f3d0; }
    .badge.failed { background: #7f1d1d; color: #fecaca; }
    .badge.pending { background: #78350f; color: #fde68a; }
    .error { background: #7f1d1d; border-color: #b91c1c; color: #fecaca; }
    .muted { color: var(--muted); font-size: .85rem; }
    .err-text { color: #fca5a5; font-size: .85rem; }
    a.primary { display: inline-block; background: #2563eb; color: white; border-radius: 8px; padding: .6rem .95rem; text-decoration: none; font-weight: 600; }
    .warning { border-color: #b45309; background: #451a03; }
    .danger-zone { border-color: #7f1d1d; }
    .actions { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
    .hostname-link { display: inline-flex; align-items: center; gap: .35rem; color: var(--accent); text-decoration: none; white-space: nowrap; }
    .hostname-link:hover { text-decoration: underline; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    a.manage-link { display: inline-flex; align-items: center; justify-content: center; min-height: 2.15rem; padding: .35rem .7rem; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-raised); color: var(--text); text-decoration: none; font-weight: 600; transition: border-color .15s, background .15s; }
    a.manage-link:hover { border-color: var(--accent); background: var(--surface); text-decoration: none; }
    button:disabled { cursor: not-allowed; opacity: .55; }
    .metric { display: inline-flex; gap: .35rem; align-items: baseline; padding: .4rem .7rem; border: 1px solid var(--line); border-radius: 9px; color: var(--muted); }
  :root[data-theme="light"] .warning { background: #fffbeb; color: #78350f; }
  :root[data-theme="light"] input[type=text], :root[data-theme="light"] input[type=password], :root[data-theme="light"] input[type=file] { border-color: #cbd5e1; }
  :root[data-theme="light"] .secondary { color: #172438 !important; }
    @media (max-width: 640px) { header { align-items: flex-start; flex-wrap: wrap; } nav { margin-left: 0; width: 100%; flex-wrap: wrap; } .page-heading { align-items: flex-start; flex-direction: column; } main { padding: 1rem; } }
  </style>
  <script>
    (function () {
      var stored;
      try { stored = localStorage.getItem('erpnext-hosting-theme'); } catch (_) {}
      var theme = stored === 'light' || stored === 'dark'
        ? stored
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      document.documentElement.setAttribute('data-theme', theme);
    })();
  </script>
</head>
<body>
  <header>
    <h1>ERPNext Hosting</h1>
    ${nav}
  </header>
  <main>${body}</main>
  <script>
    (function () {
      var button = document.querySelector('[data-theme-toggle]');
      var root = document.documentElement;
      var initial = root.getAttribute('data-theme') || 'dark';
      if (!button) return;
      button.setAttribute('aria-label', 'Switch to ' + (initial === 'dark' ? 'light' : 'dark') + ' theme');
      button.setAttribute('title', 'Switch to ' + (initial === 'dark' ? 'light' : 'dark') + ' theme');
      button.setAttribute('aria-pressed', String(initial === 'light'));
      button.addEventListener('click', function () {
        var theme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', theme);
        try { localStorage.setItem('erpnext-hosting-theme', theme); } catch (_) {}
        button.setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme');
        button.setAttribute('title', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme');
        button.setAttribute('aria-pressed', String(theme === 'light'));
      });
    })();
  </script>
</body>
</html>`;
}

function hostnameLink(hostname: string): string {
  const safeHostname = escapeHtml(hostname);
  return `<a class="hostname-link" href="https://${safeHostname}" target="_blank" rel="noopener noreferrer">
    ${safeHostname}
    <svg class="external-link-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6m-11 3L20 4"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>
    <span class="sr-only">opens in a new tab</span>
  </a>`;
}

function instanceRow(instance: Instance): string {
  return `<tr>
    <td>${escapeHtml(instance.companyName)}</td>
    <td>${hostnameLink(instance.hostname)}</td>
    <td>${statusBadge(instance.status)}</td>
    <td class="muted">${instance.createdAt.toISOString()}</td>
    <td><a class="manage-link" href="/dashboard/instances/${encodeURIComponent(instance.id)}">Manage</a></td>
  </tr>`;
}

export function registerWebRoutes(
  app: FastifyInstance,
  deps: {
    config: AppConfig;
    store: Store;
    instanceService: InstanceService;
    adminService: AdminService;
    backupService: BackupService;
    siteBackupService: SiteBackupService;
  },
): void {
  const { config, store, instanceService, adminService, backupService, siteBackupService } = deps;

  app.get('/', async (request, reply) => {
    await reply.redirect(request.auth ? '/dashboard' : '/login', 302);
  });

  app.get('/login', async (request, reply) => {
    const query = request.query as { error?: string };
    const errorBox = query.error
      ? `<div class="card error">Sign-in failed: ${escapeHtml(query.error)}</div>`
      : '';
    const body = `
      ${errorBox}
      <div class="card">
        <h2>Sign in</h2>
        <p class="muted">Use your Truemoi account to manage your ERPNext sites.</p>
        <a class="primary" href="/auth/login">Continue with Truemoi</a>
      </div>`;
    reply.type('text/html').send(layout('Sign in', body));
  });

  app.get('/dashboard', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const instances = await instanceService.listFor(user);
    const userBackups = await siteBackupService.listVisible(user);
    const rows =
      instances.length > 0
        ? instances.map(instanceRow).join('')
        : '<tr><td colspan="5" class="muted">No instances yet.</td></tr>';
    const query = request.query as { error?: string };
    const errorBox = query.error
      ? `<div class="card error" role="alert">${escapeHtml(query.error)}</div>`
      : '';
    const recentBackupRows = userBackups.length
      ? userBackups.slice(0, 20).map((backup) => {
          const links = backup.parts
            .map((part) => `<a href="/api/site-backups/${encodeURIComponent(backup.id)}/files/${part.kind}">${escapeHtml(part.kind)}</a>`)
            .join(' · ');
          const details = [
            links,
            backup.errorMessage ? `<span class="err-text">${escapeHtml(backup.errorMessage)}</span>` : '',
            !links && !backup.errorMessage ? 'Waiting for worker' : '',
          ].filter(Boolean).join('<br>');
          return `<tr><td>${escapeHtml(backup.hostname)}</td><td>${backup.createdAt.toISOString()}</td><td>${escapeHtml(backup.status)}</td><td>${details}</td></tr>`;
        }).join('')
      : '<tr><td colspan="4" class="muted">No tenant backups are available.</td></tr>';
    const body = `
      ${errorBox}
      <div class="page-heading">
        <div><p class="muted">ERPNext Hosting Console</p><h2>Workspace</h2></div>
        <span class="metric">${instances.length} ${instances.length === 1 ? 'instance' : 'instances'}</span>
      </div>
      <div class="card">
        <h2>Provision a workspace</h2>
        <form class="row" method="post" action="/dashboard/instances">
          <div>
            <label for="name">Company / site name</label>
            <input id="name" type="text" name="name" placeholder="Acme Manufacturing" required maxlength="100">
          </div>
          <button type="submit">Create instance</button>
        </form>
        <p class="muted">A dedicated ERPNext site and database will be provisioned for your organization.</p>
      </div>
      <div class="card">
        <h2>Your instances</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Workspace</th><th>Hostname</th><th>Status</th><th>Created</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
    const backupCard = `
      <div class="card">
        <h2>Recent tenant backups</h2>
        <p class="muted">These archives remain available after an instance is removed.</p>
        <div class="table-wrap"><table><thead><tr><th>Site</th><th>Created</th><th>Status</th><th>Files</th></tr></thead><tbody>${recentBackupRows}</tbody></table></div>
      </div>`;
    reply.type('text/html').send(layout('Dashboard', `${body}${backupCard}`, user));
  });

  app.post('/dashboard/instances', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const body = createFormBody.parse(request.body ?? {});
    try {
      const instance = await instanceService.create(user, {
        companyName: body.name ?? '',
        idempotencyKey: null,
      });
      await reply.redirect(`/dashboard/instances/${encodeURIComponent(instance.id)}`, 302);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create instance';
      await reply.redirect(`/dashboard?error=${encodeURIComponent(message)}`, 302);
    }
  });

  app.get('/dashboard/instances/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    let instance: Instance;
    try {
      instance = await instanceService.getFor(user, id);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      reply.code(404).type('text/html').send(layout('Not found', '<div class="card">Instance not found.</div>', user));
      return;
    }
    const latestJob = await store.findLatestJobForInstance(instance.id);
    const siteBackups = await siteBackupService.listFor(user, instance.id);
    const ready = instance.status === 'ready';
    const failed = instance.status === 'failed';
    const retryAvailable =
      failed && latestJob?.type === 'provision' && latestJob.status === 'failed';
    const canStopProvisioning =
      ['queued', 'provisioning', 'installing', 'configuring'].includes(instance.status) &&
      latestJob?.type === 'provision' &&
      ['queued', 'running'].includes(latestJob.status);
    const canDelete = ready || failed;
    const pageQuery = request.query as { error?: string };
    const errorBox = pageQuery.error
      ? `<div class="card error" role="alert">${escapeHtml(pageQuery.error)}</div>`
      : '';
    const urlLine = ready
      ? `<p><a class="primary" href="https://${escapeHtml(instance.hostname)}" target="_blank" rel="noopener">Open ERPNext</a></p>`
      : '';
    const errorLine = instance.errorMessage
      ? `<p class="err-text">Last error: ${escapeHtml(instance.errorMessage)}</p>`
      : '';
    const poll = !ready && !failed
      ? `<script>
      (function poll(){
        fetch('/api/instances/${encodeURIComponent(instance.id)}', { headers: { 'Accept': 'application/json' } })
          .then(r => r.ok ? r.json() : null)
          .then(d => { if (d && (d.instance.status === 'ready' || d.instance.status === 'failed')) { location.reload(); } else { setTimeout(poll, 3000); } })
          .catch(() => setTimeout(poll, 3000));
      })();
      </script>`
      : '';
    const backupRows = siteBackups.length
      ? siteBackups.map((backup) => {
          const fileLinks = backup.parts
            .map((part) => `<a href="/api/site-backups/${encodeURIComponent(backup.id)}/files/${part.kind}">${escapeHtml(part.kind)} (${Math.ceil(part.sizeBytes / 1024)} KB)</a>`)
            .join(' · ');
          const details = [
            fileLinks,
            backup.errorMessage ? `<span class="err-text">${escapeHtml(backup.errorMessage)}</span>` : '',
            !fileLinks && !backup.errorMessage ? 'Waiting for worker' : '',
          ].filter(Boolean).join('<br>');
          return `<tr><td>${backup.createdAt.toISOString()}</td><td>${statusBadge(backup.status === 'completed' ? 'ready' : backup.status === 'failed' ? 'failed' : 'provisioning')}</td><td>${details}</td></tr>`;
        }).join('')
      : '<tr><td colspan="3" class="muted">No full-site backups yet.</td></tr>';
    const backupPending = siteBackups.some((backup) => backup.status === 'queued' || backup.status === 'running');
    const backupPoll = backupPending ? '<script>setTimeout(function(){ location.reload(); }, 5000);</script>' : '';
    const body = `
      ${errorBox}
      <div class="page-heading">
        <div><p class="muted">Workspace details</p><h2>${escapeHtml(instance.companyName)}</h2></div>
        ${urlLine}
      </div>
      <div class="card">
        <p class="muted">${hostnameLink(instance.hostname)} · ${escapeHtml(instance.siteName)}</p>
        <p>Status: ${statusBadge(instance.status)}</p>
        ${errorLine}
        <p class="muted">Provisioning attempts: ${latestJob?.attempts ?? 0} / ${latestJob?.maxAttempts ?? 0}</p>
        <p><a href="/dashboard">Back to dashboard</a></p>
        ${poll}
      </div>`;
    const editableBody = `
      <div class="card">
        <h3>Workspace settings</h3>
        <form class="row" method="post" action="/dashboard/instances/${encodeURIComponent(instance.id)}/update">
          <div>
            <label for="companyName">Display name</label>
            <input id="companyName" type="text" name="name" value="${escapeHtml(instance.companyName)}" maxlength="100" required ${instance.status === 'deleting' ? 'disabled' : ''}>
          </div>
          <button class="action secondary" type="submit" ${instance.status === 'deleting' ? 'disabled' : ''}>Save changes</button>
        </form>
        <p class="muted">Changing this label does not rename your ERPNext site or change its URL.</p>
      </div>
      ${
        instance.status !== 'ready' && instance.status !== 'deleting'
          ? `<div class="card ${retryAvailable ? 'warning' : ''}">
        <h3>Provisioning needs attention</h3>
        <p>${retryAvailable
          ? 'The last provisioning attempt failed. Retry keeps your site URL but removes any partial, not-ready setup before provisioning again.'
          : failed
            ? 'This failed operation cannot be retried as a provisioning attempt.'
            : 'Retry becomes available if provisioning fails. It is disabled while your workspace is being built.'}</p>
        <form method="post" action="/dashboard/instances/${encodeURIComponent(instance.id)}/retry">
          <button class="action" type="submit" ${retryAvailable ? '' : 'disabled'}>Retry provisioning</button>
        </form>
      </div>`
          : ''
      }
      ${
        canStopProvisioning
          ? `<div class="card warning">
        <h3>Provisioning is taking too long?</h3>
        <p>Stop this provisioning job if it appears stuck. The incomplete setup remains in place until you retry; retrying removes that partial setup before provisioning again.</p>
        <form method="post" action="/dashboard/instances/${encodeURIComponent(instance.id)}/stop" onsubmit="return confirm('Stop provisioning for ${escapeHtml(instance.hostname)}?')">
          <button class="action danger" type="submit">Stop provisioning</button>
        </form>
      </div>`
          : ''
      }
      <div class="card">
        <div class="page-heading"><div><h3>Full-site backups</h3><p class="muted">Includes the MariaDB database and public/private files. Completed backups are stored on the persistent backup volume.</p></div>
          <form method="post" action="/dashboard/instances/${encodeURIComponent(instance.id)}/backups">
            <button class="action secondary" type="submit" ${instance.status !== 'ready' ? 'disabled' : ''}>Create backup</button>
          </form>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Created</th><th>Status</th><th>Files / details</th></tr></thead><tbody>${backupRows}</tbody></table></div>
        ${backupPoll}
      </div>
      ${
        canDelete
          ? `<div class="card danger-zone">
        <h3>Danger zone</h3>
        <p class="err-text">Permanent deletion removes the ERPNext site, its MariaDB database, and its uploaded files. This cannot be undone. Download a full site backup first.</p>
        <form class="row" method="post" action="/dashboard/instances/${encodeURIComponent(instance.id)}/delete" onsubmit="return confirm('This permanently deletes all ERPNext data for ${escapeHtml(instance.hostname)}. Continue?')">
          <div>
            <label for="confirmSiteName">Type ${escapeHtml(instance.hostname)} to confirm</label>
            <input id="confirmSiteName" type="text" name="confirmSiteName" autocomplete="off" required>
          </div>
          <button class="action danger" type="submit">Permanently delete site</button>
        </form>
      </div>`
          : ''
      }`;
    reply.type('text/html').send(layout(instance.hostname, `${body}${editableBody}`, user));
  });

  app.post('/dashboard/instances/:id/update', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const body = updateFormBody.parse(request.body ?? {});
    try {
      await instanceService.updateFor(user, id, body.name);
      await reply.redirect(`/dashboard/instances/${encodeURIComponent(id)}`, 303);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not update instance';
      await reply.redirect(`/dashboard/instances/${encodeURIComponent(id)}?error=${encodeURIComponent(message)}`, 303);
    }
  });

  app.post('/dashboard/instances/:id/delete', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const body = deleteFormBody.parse(request.body ?? {});
    try {
      await instanceService.deleteFor(user, id, body.confirmSiteName);
      await reply.redirect('/dashboard', 303);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not delete instance';
      await reply.redirect(`/dashboard/instances/${encodeURIComponent(id)}?error=${encodeURIComponent(message)}`, 303);
    }
  });

  app.post('/dashboard/instances/:id/backups', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    try {
      await siteBackupService.request(user, id);
      await reply.redirect(`/dashboard/instances/${encodeURIComponent(id)}`, 303);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start site backup';
      await reply.redirect(`/dashboard/instances/${encodeURIComponent(id)}?error=${encodeURIComponent(message)}`, 303);
    }
  });

  app.post('/dashboard/instances/:id/retry', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    try {
      await instanceService.retry(user, id);
      await reply.redirect(`/dashboard/instances/${encodeURIComponent(id)}`, 303);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not retry provisioning';
      await reply.redirect(`/dashboard/instances/${encodeURIComponent(id)}?error=${encodeURIComponent(message)}`, 303);
    }
  });

  app.post('/dashboard/instances/:id/stop', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    try {
      await instanceService.stopProvisioning(user, id);
      await reply.redirect(`/dashboard/instances/${encodeURIComponent(id)}`, 303);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not stop provisioning';
      await reply.redirect(`/dashboard/instances/${encodeURIComponent(id)}?error=${encodeURIComponent(message)}`, 303);
    }
  });

  app.get('/admin', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const { user } = getAuth(request);
    const users = await adminService.listUsers(user);
    const instances = await adminService.listInstances(user);
    const audit = await adminService.listAudit(user, 50);
    const backups = await backupService.listBackups(user);
    const siteBackups = await siteBackupService.listAllForAdmin(user);
    const siteBackupSettings = await siteBackupService.getSettings(user);
    const adminQuery = request.query as { error?: string };
    const adminError = adminQuery.error
      ? `<div class="card error" role="alert">${escapeHtml(adminQuery.error)}</div>`
      : '';

    const userRows = users
      .map(
        (u) => `<tr>
        <td>${escapeHtml(u.email)}</td>
        <td>${escapeHtml(u.role)}</td>
        <td>${u.disabled ? 'disabled' : 'active'}</td>
        <td>
          <form method="post" action="/admin/users/${encodeURIComponent(u.id)}/role" class="inline">
            <input type="hidden" name="role" value="${u.role === 'admin' ? 'user' : 'admin'}">
            <button class="action secondary" type="submit">${u.role === 'admin' ? 'Demote' : 'Promote'}</button>
          </form>
          <form method="post" action="/admin/users/${encodeURIComponent(u.id)}/disabled" class="inline">
            <input type="hidden" name="disabled" value="${u.disabled ? 'false' : 'true'}">
            <button class="action ${u.disabled ? '' : 'danger'}" type="submit">${u.disabled ? 'Enable' : 'Disable'}</button>
          </form>
        </td>
      </tr>`,
      )
      .join('');

    const instanceRows = (await Promise.all(instances.map(async (i) => {
      const latestJob = await store.findLatestJobForInstance(i.id);
      const retryAvailable =
        i.status === 'failed' && latestJob?.type === 'provision' && latestJob.status === 'failed';
      const stopAvailable =
        ['queued', 'provisioning', 'installing', 'configuring'].includes(i.status) &&
        latestJob?.type === 'provision' &&
        ['queued', 'running'].includes(latestJob.status);
      return `<tr>
        <td>${escapeHtml(i.companyName)}</td>
        <td>${hostnameLink(i.hostname)}</td>
        <td>${statusBadge(i.status)}</td>
        <td class="muted">${i.ownerUserId}</td>
        <td>
          <a class="manage-link" href="/dashboard/instances/${encodeURIComponent(i.id)}">Manage</a>
          <form method="post" action="/admin/instances/${encodeURIComponent(i.id)}/retry" class="inline">
            <button class="action secondary" type="submit" ${retryAvailable ? '' : 'disabled'}>Retry</button>
          </form>
          ${stopAvailable ? `<form method="post" action="/admin/instances/${encodeURIComponent(i.id)}/stop" class="inline" onsubmit="return confirm('Stop provisioning for ${escapeHtml(i.hostname)}?')">
            <button class="action danger" type="submit">Stop</button>
          </form>` : ''}
        </td>
      </tr>`;
    }))).join('');

    const auditRows = audit
      .map(
        (a) => `<tr>
        <td class="muted">${a.createdAt.toISOString()}</td>
        <td>${escapeHtml(a.action)}</td>
        <td class="muted">${escapeHtml(a.targetType ?? '')} ${escapeHtml(a.targetId ?? '')}</td>
      </tr>`,
      )
      .join('');

    const backupRows = backups
      .map(
        (b) => `<tr>
        <td>${escapeHtml(b.label ?? '(unlabeled)')}</td>
        <td class="muted">${escapeHtml(JSON.stringify(b.counts))}</td>
        <td class="muted">${b.createdAt.toISOString()}</td>
        <td>
          <a href="/api/admin/backup/${encodeURIComponent(b.id)}/download">Download</a>
          <form method="post" action="/admin/backup/${encodeURIComponent(b.id)}/restore" class="inline">
            <button class="action secondary" type="submit">Restore</button>
          </form>
          <form method="post" action="/admin/backup/${encodeURIComponent(b.id)}/delete" class="inline">
            <button class="action danger" type="submit">Delete</button>
          </form>
        </td>
      </tr>`,
      )
      .join('');

    const backupTable =
      backups.length > 0
        ? `<table><thead><tr><th>Label</th><th>Counts</th><th>Created</th><th></th></tr></thead><tbody>${backupRows}</tbody></table>`
        : '<p class="muted">No stored backups yet.</p>';
    const siteBackupRows = siteBackups.length
      ? siteBackups.map((backup) => {
          const files = backup.parts
            .map((part) => `<a href="/api/site-backups/${encodeURIComponent(backup.id)}/files/${part.kind}">${escapeHtml(part.kind)}</a>`)
            .join(' · ');
        const details = [
          files,
          backup.errorMessage ? `<span class="err-text">${escapeHtml(backup.errorMessage)}</span>` : '',
          !files && !backup.errorMessage ? 'Queued' : '',
        ].filter(Boolean).join('<br>');
        return `<tr><td>${escapeHtml(backup.hostname)}</td><td>${backup.createdAt.toISOString()}</td><td>${escapeHtml(backup.status)}</td><td>${details}</td></tr>`;
        }).join('')
      : '<tr><td colspan="4" class="muted">No tenant backups yet.</td></tr>';

    const body = `
      ${adminError}
      <div class="page-heading"><div><p class="muted">Operations &amp; governance</p><h2>Administration</h2></div></div>
      <div class="card">
        <h2>Tenant data backups</h2>
        <p class="muted">Full Bench archives include tenant database and files. Backups are retained on persistent storage; no automatic retention deletion is configured.</p>
        <div class="table-wrap"><table><thead><tr><th>Site</th><th>Created</th><th>Status</th><th>Download</th></tr></thead><tbody>${siteBackupRows}</tbody></table></div>
      </div>
      <div class="card">
        <h2>Tenant backup policy</h2>
        <form method="post" action="/admin/site-backup-settings" class="row">
          <div>
            <label><input type="checkbox" name="automaticEnabled" value="on" ${siteBackupSettings.automaticEnabled ? 'checked' : ''}> Enable automatic full-site backups</label>
            <label for="backupInterval">Schedule</label>
            <select id="backupInterval" name="intervalHours">
              <option value="24" ${siteBackupSettings.intervalHours === 24 ? 'selected' : ''}>Daily</option>
              <option value="168" ${siteBackupSettings.intervalHours === 168 ? 'selected' : ''}>Weekly</option>
            </select>
          </div>
          <div><label for="s3Endpoint">S3-compatible endpoint (optional)</label><input id="s3Endpoint" type="text" name="s3Endpoint" value="${escapeHtml(siteBackupSettings.s3Endpoint ?? '')}" placeholder="https://s3.example.com"></div>
          <div><label for="s3Bucket">Bucket</label><input id="s3Bucket" type="text" name="s3Bucket" value="${escapeHtml(siteBackupSettings.s3Bucket ?? '')}" placeholder="erpnext-backups"></div>
          <div><label for="s3Region">Region</label><input id="s3Region" type="text" name="s3Region" value="${escapeHtml(siteBackupSettings.s3Region ?? '')}" placeholder="us-east-1"></div>
          <div><label for="s3AccessKeyId">S3 access key ID</label><input id="s3AccessKeyId" type="password" name="s3AccessKeyId" autocomplete="new-password" placeholder="${siteBackupSettings.s3CredentialsConfigured ? 'Saved; leave blank to keep' : 'Enter access key ID'}"></div>
          <div><label for="s3SecretAccessKey">S3 secret access key</label><input id="s3SecretAccessKey" type="password" name="s3SecretAccessKey" autocomplete="new-password" placeholder="${siteBackupSettings.s3CredentialsConfigured ? 'Saved; leave blank to keep' : 'Enter secret access key'}"></div>
          ${
            siteBackupSettings.s3CredentialsConfigured
              ? '<label><input type="checkbox" name="clearS3Credentials" value="on"> Clear saved S3 credentials</label>'
              : ''
          }
          <button class="action" type="submit">Save backup policy</button>
        </form>
        <p class="muted">S3 credentials are encrypted before they are stored in the platform database and are never returned by the settings API. Configure BACKUP_CREDENTIALS_ENCRYPTION_KEY as the same persistent secret in the API and worker deployments. Local full backups remain available if remote upload fails. Next run: ${siteBackupSettings.nextRunAt?.toISOString() ?? 'not scheduled'}.</p>
      </div>
      <div class="card">
        <h2>Backup &amp; restore</h2>
        <p class="muted">Platform snapshots contain accounts, ownership, instances and jobs — never sessions, tokens, or ERPNext business data.</p>
        <p class="row" style="align-items:center">
          <a class="primary" href="/api/admin/backup/export">Download current state</a>
          <form method="post" action="/admin/backup" class="inline row" style="align-items:center">
            <input type="text" name="label" placeholder="Label (optional)" maxlength="200">
            <button class="action" type="submit">Save backup</button>
          </form>
        </p>
        ${backupTable}
        <h3>Restore from file</h3>
        <p class="row" style="align-items:center">
          <input type="file" id="backupFile" accept="application/json,.json">
          <label class="inline"><input type="checkbox" id="dryRun" checked> Dry run</label>
          <input type="text" id="baseDomain" placeholder="Base domain override (optional)">
          <button class="action" id="importBtn" type="button">Import</button>
        </p>
        <pre id="importResult" class="muted"></pre>
      </div>
      <div class="card">
        <h2>Users</h2>
        <table><thead><tr><th>Email</th><th>Role</th><th>State</th><th>Actions</th></tr></thead><tbody>${userRows}</tbody></table>
      </div>
      <div class="card">
        <h2>All instances</h2>
        <div class="table-wrap"><table><thead><tr><th>Workspace</th><th>Hostname</th><th>Status</th><th>Owner</th><th>Actions</th></tr></thead><tbody>${instanceRows}</tbody></table></div>
      </div>
      <div class="card">
        <h2>Recent activity</h2>
        <table><thead><tr><th>Time</th><th>Action</th><th>Target</th></tr></thead><tbody>${auditRows}</tbody></table>
      </div>
      <script>
      (function () {
        var btn = document.getElementById('importBtn');
        if (!btn) return;
        btn.addEventListener('click', function () {
          var fileInput = document.getElementById('backupFile');
          var out = document.getElementById('importResult');
          if (!fileInput.files || !fileInput.files[0]) { out.textContent = 'Choose a backup file first.'; return; }
          fileInput.files[0].text().then(function (text) {
            var snapshot;
            try { snapshot = JSON.parse(text); } catch (e) { out.textContent = 'Invalid JSON: ' + e.message; return; }
            var dryRun = document.getElementById('dryRun').checked;
            var override = document.getElementById('baseDomain').value;
            var body = { snapshot: snapshot, dryRun: dryRun };
            if (override) body.baseDomainOverride = override;
            out.textContent = 'Importing…';
            return fetch('/api/admin/backup/import', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body)
            }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
              .then(function (res) {
                out.textContent = JSON.stringify(res.data, null, 2);
                if (res.ok && !dryRun) setTimeout(function () { location.reload(); }, 1500);
              });
          }).catch(function (e) { out.textContent = 'Import failed: ' + e.message; });
        });
      })();
      </script>`;
    reply.type('text/html').send(layout('Admin', body, user));
  });

  // HTML form handlers for admin actions.
  app.post('/admin/instances/:id/retry', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    try {
      await adminService.retryInstance(user, id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not retry instance';
      await reply.redirect(`/admin?error=${encodeURIComponent(message)}`, 303);
      return;
    }
    await reply.redirect('/admin', 303);
  });

  app.post('/admin/instances/:id/stop', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    try {
      await instanceService.stopProvisioning(user, id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not stop provisioning';
      await reply.redirect(`/admin?error=${encodeURIComponent(message)}`, 303);
      return;
    }
    await reply.redirect('/admin', 303);
  });

  app.post('/admin/users/:id/role', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    try {
      const body = roleFormBody.parse(request.body ?? {});
      await adminService.setUserRole(user, id, body.role);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not update user role';
      await reply.redirect(`/admin?error=${encodeURIComponent(message)}`, 303);
      return;
    }
    await reply.redirect('/admin', 303);
  });

  app.post('/admin/users/:id/disabled', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    try {
      const body = disabledFormBody.parse(request.body ?? {});
      const disabled = body.disabled === 'true';
      await adminService.setUserDisabled(user, id, disabled);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not update user status';
      await reply.redirect(`/admin?error=${encodeURIComponent(message)}`, 303);
      return;
    }
    await reply.redirect('/admin', 303);
  });

  app.post('/admin/backup', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const { user } = getAuth(request);
    const body = request.body as { label?: string } | undefined;
    try {
      await backupService.createBackup(user, body?.label ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create platform snapshot';
      await reply.redirect(`/admin?error=${encodeURIComponent(message)}`, 303);
      return;
    }
    await reply.redirect('/admin', 303);
  });

  app.post('/admin/site-backup-settings', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const { user } = getAuth(request);
    const body = siteBackupSettingsForm.parse(request.body ?? {});
    try {
      await siteBackupService.updateSettings(user, {
        automaticEnabled: body.automaticEnabled === 'on',
        intervalHours: Number(body.intervalHours),
        s3Endpoint: body.s3Endpoint?.trim() || null,
        s3Bucket: body.s3Bucket?.trim() || null,
        s3Region: body.s3Region?.trim() || null,
        s3AccessKeyId: body.s3AccessKeyId,
        s3SecretAccessKey: body.s3SecretAccessKey,
        clearS3Credentials: body.clearS3Credentials === 'on',
      });
      await reply.redirect('/admin', 303);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not update backup policy';
      await reply.redirect(`/admin?error=${encodeURIComponent(message)}`, 303);
    }
  });

  app.post(
    '/admin/backup/:id/restore',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const { id } = request.params as { id: string };
      try {
        const backup = await backupService.getBackup(user, id);
        await backupService.importState(user, backup.payload, { dryRun: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not restore platform snapshot';
        await reply.redirect(`/admin?error=${encodeURIComponent(message)}`, 303);
        return;
      }
      await reply.redirect('/admin', 303);
    },
  );

  app.post(
    '/admin/backup/:id/delete',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const { id } = request.params as { id: string };
      try {
        await backupService.deleteBackup(user, id);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not delete platform snapshot';
        await reply.redirect(`/admin?error=${encodeURIComponent(message)}`, 303);
        return;
      }
      await reply.redirect('/admin', 303);
    },
  );
}
