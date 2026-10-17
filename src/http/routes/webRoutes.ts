import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { InstanceService } from '../../instances/instanceService.js';
import type { AdminService } from '../../admin/adminService.js';
import type { BackupService } from '../../admin/backupService.js';
import type { Store } from '../../domain/store.js';
import type { Instance, User } from '../../domain/types.js';
import { getAuth, requireAdmin, requireAuth } from '../../auth/middleware.js';
import { statusBadge } from '../view.js';

const createFormBody = z.object({ name: z.string().optional() });

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
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
    header { padding: 1rem 1.5rem; border-bottom: 1px solid #1e293b; display: flex; align-items: center; gap: 1.5rem; }
    header h1 { font-size: 1.1rem; margin: 0; }
    nav { display: flex; gap: 1rem; align-items: center; margin-left: auto; }
    nav a, .link { color: #93c5fd; text-decoration: none; background: none; border: none; cursor: pointer; font: inherit; padding: 0; }
    .who { color: #94a3b8; font-size: .85rem; }
    .inline { display: inline; }
    main { max-width: 900px; margin: 0 auto; padding: 2rem 1.5rem; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 1.25rem; margin-bottom: 1rem; }
    form.row { display: flex; gap: .75rem; flex-wrap: wrap; align-items: end; }
    label { display: block; font-size: .8rem; color: #94a3b8; margin-bottom: .35rem; }
    input[type=text] { padding: .6rem .75rem; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: inherit; min-width: 260px; }
    button[type=submit], button.action { background: #2563eb; color: white; border: none; border-radius: 8px; padding: .6rem 1rem; cursor: pointer; font: inherit; }
    button.danger { background: #b91c1c; }
    button.secondary { background: #334155; }
    table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    th, td { text-align: left; padding: .55rem .5rem; border-bottom: 1px solid #334155; }
    .badge { padding: .15rem .5rem; border-radius: 999px; font-size: .75rem; font-weight: 600; }
    .badge.ready { background: #065f46; color: #a7f3d0; }
    .badge.failed { background: #7f1d1d; color: #fecaca; }
    .badge.pending { background: #78350f; color: #fde68a; }
    .error { background: #7f1d1d; border-color: #b91c1c; color: #fecaca; }
    .muted { color: #94a3b8; font-size: .85rem; }
    .err-text { color: #fca5a5; font-size: .85rem; }
    a.primary { display: inline-block; background: #2563eb; color: white; border-radius: 8px; padding: .5rem .9rem; text-decoration: none; }
    @media (prefers-color-scheme: light) {
      body { background: #f8fafc; color: #0f172a; }
      header { border-color: #e2e8f0; }
      .card { background: #fff; border-color: #e2e8f0; }
      input[type=text] { background: #fff; border-color: #cbd5e1; }
      .muted, .who { color: #64748b; }
      th, td { border-color: #e2e8f0; }
    }
  </style>
</head>
<body>
  <header>
    <h1>ERPNext Hosting</h1>
    ${nav}
  </header>
  <main>${body}</main>
</body>
</html>`;
}

function instanceRow(instance: Instance): string {
  return `<tr>
    <td>${escapeHtml(instance.hostname)}</td>
    <td>${statusBadge(instance.status)}</td>
    <td class="muted">${instance.createdAt.toISOString()}</td>
    <td><a href="/dashboard/instances/${encodeURIComponent(instance.id)}">View</a></td>
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
  },
): void {
  const { config, store, instanceService, adminService, backupService } = deps;

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
    const rows =
      instances.length > 0
        ? instances.map(instanceRow).join('')
        : '<tr><td colspan="4" class="muted">No instances yet.</td></tr>';
    const body = `
      <div class="card">
        <h2>Create a site</h2>
        <form class="row" method="post" action="/dashboard/instances">
          <div>
            <label for="name">Company / site name</label>
            <input id="name" type="text" name="name" placeholder="Acme Manufacturing" required maxlength="100">
          </div>
          <button type="submit">Create instance</button>
        </form>
        <p class="muted">Your site is provisioned automatically on the shared ERPNext server.</p>
      </div>
      <div class="card">
        <h2>Your instances</h2>
        <table>
          <thead><tr><th>Hostname</th><th>Status</th><th>Created</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    reply.type('text/html').send(layout('Dashboard', body, user));
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
    } catch {
      reply.code(404).type('text/html').send(layout('Not found', '<div class="card">Instance not found.</div>', user));
      return;
    }
    const latestJob = await store.findLatestJobForInstance(instance.id);
    const ready = instance.status === 'ready';
    const failed = instance.status === 'failed';
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
    const body = `
      <div class="card">
        <h2>${escapeHtml(instance.hostname)}</h2>
        <p>Status: ${statusBadge(instance.status)}</p>
        ${urlLine}
        ${errorLine}
        <p class="muted">Attempts: ${latestJob?.attempts ?? 0} / ${latestJob?.maxAttempts ?? 0}</p>
        <p><a href="/dashboard">Back to dashboard</a></p>
        ${poll}
      </div>`;
    reply.type('text/html').send(layout(instance.hostname, body, user));
  });

  app.get('/admin', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const { user } = getAuth(request);
    const users = await adminService.listUsers(user);
    const instances = await adminService.listInstances(user);
    const audit = await adminService.listAudit(user, 50);
    const backups = await backupService.listBackups(user);

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

    const instanceRows = instances
      .map(
        (i) => `<tr>
        <td>${escapeHtml(i.hostname)}</td>
        <td>${statusBadge(i.status)}</td>
        <td class="muted">${i.ownerUserId}</td>
        <td>
          <form method="post" action="/admin/instances/${encodeURIComponent(i.id)}/retry" class="inline">
            <button class="action secondary" type="submit">Retry</button>
          </form>
        </td>
      </tr>`,
      )
      .join('');

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

    const body = `
      <div class="card">
        <h2>Backup &amp; restore</h2>
        <p class="muted">Snapshots contain platform state (accounts, ownership, instances, jobs) — never sessions or tokens.</p>
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
        <table><thead><tr><th>Hostname</th><th>Status</th><th>Owner</th><th></th></tr></thead><tbody>${instanceRows}</tbody></table>
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
    } catch {
      // Surface nothing here; the admin page reflects the resulting state.
    }
    await reply.redirect('/admin', 302);
  });

  app.post('/admin/users/:id/role', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const body = request.body as { role?: string } | undefined;
    if (body?.role === 'admin' || body?.role === 'user') {
      try {
        await adminService.setUserRole(user, id, body.role);
      } catch {
        /* ignore, page reflects state */
      }
    }
    await reply.redirect('/admin', 302);
  });

  app.post('/admin/users/:id/disabled', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const body = request.body as { disabled?: string } | undefined;
    const disabled = body?.disabled === 'true';
    try {
      await adminService.setUserDisabled(user, id, disabled);
    } catch {
      /* ignore */
    }
    await reply.redirect('/admin', 302);
  });

  app.post('/admin/backup', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const { user } = getAuth(request);
    const body = request.body as { label?: string } | undefined;
    try {
      await backupService.createBackup(user, body?.label ?? null);
    } catch {
      /* ignore */
    }
    await reply.redirect('/admin', 302);
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
      } catch {
        /* ignore; page reflects state */
      }
      await reply.redirect('/admin', 302);
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
      } catch {
        /* ignore */
      }
      await reply.redirect('/admin', 302);
    },
  );
}
