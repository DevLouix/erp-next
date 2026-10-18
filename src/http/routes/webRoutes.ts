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

const createFormBody = z.object({
  name: z.string().optional(),
  adminPassword: z.string().min(12).max(128),
  confirmAdminPassword: z.string(),
}).refine((body) => body.adminPassword === body.confirmAdminPassword, {
  message: 'Administrator passwords do not match',
  path: ['confirmAdminPassword'],
});
const credentialsFormBody = z.object({
  adminPassword: z.string().min(12).max(128),
  confirmAdminPassword: z.string(),
}).refine((body) => body.adminPassword === body.confirmAdminPassword, {
  message: 'Administrator passwords do not match',
  path: ['confirmAdminPassword'],
});
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

function passwordFields(
  passwordId: string,
  confirmId: string,
  passwordLabel: string,
  confirmLabel: string,
  disabled = false,
): string {
  const disabledAttribute = disabled ? 'disabled' : '';
  return `
    <div class="password-group">
      <label for="${passwordId}">${passwordLabel}</label>
      <div class="password-control">
        <input id="${passwordId}" class="password-input" type="password" name="adminPassword" autocomplete="new-password" minlength="12" maxlength="128" required data-password-value ${disabledAttribute}>
        <button class="action secondary password-control-button" type="button" data-password-toggle aria-controls="${passwordId}" aria-label="Show password" ${disabledAttribute}>Show</button>
      </div>
      <div class="password-feedback">
        <progress class="password-meter" max="5" value="0" aria-label="Password strength" data-password-meter></progress>
        <span class="muted" aria-live="polite" data-password-strength>Use at least 12 characters.</span>
      </div>
      <button class="action secondary password-generate" type="button" data-password-generate ${disabledAttribute}>Generate a strong password</button>
    </div>
    <div class="password-group">
      <label for="${confirmId}">${confirmLabel}</label>
      <div class="password-control">
        <input id="${confirmId}" class="password-input" type="password" name="confirmAdminPassword" autocomplete="new-password" minlength="12" maxlength="128" required data-password-confirm ${disabledAttribute}>
        <button class="action secondary password-control-button" type="button" data-password-toggle aria-controls="${confirmId}" aria-label="Show confirmation password" ${disabledAttribute}>Show</button>
      </div>
      <span class="muted" aria-live="polite" data-password-match></span>
    </div>`;
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
    :root {
      color-scheme: light;
      --bg: #f7f6f2;
      --surface: #fffefa;
      --surface-raised: #f0eee8;
      --line: #e8e5dd;
      --text: #292a26;
      --muted: #828178;
      --accent: #526b56;
      --accent-strong: #3d5843;
      --accent-soft: #e9efe8;
      --danger: #a9443c;
      --shadow: 0 12px 34px rgb(51 48 38 / 5%), 0 2px 6px rgb(51 48 38 / 3%);
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #191a18;
      --surface: #222320;
      --surface-raised: #2b2c28;
      --line: #393a34;
      --text: #e8e7df;
      --muted: #a09f94;
      --accent: #a3b69c;
      --accent-strong: #c1d0b9;
      --accent-soft: #30392f;
      --danger: #f08e83;
      --shadow: 0 12px 34px rgb(0 0 0 / 16%);
    }
    * { box-sizing: border-box; }
    html { min-width: 320px; background: var(--bg); }
    body {
      min-height: 100vh;
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(ellipse at 50% -20%, rgb(213 208 188 / 19%), transparent 52%),
        var(--bg);
      font: 15px/1.65 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: -.006em;
      -webkit-font-smoothing: antialiased;
    }
    header {
      position: sticky;
      z-index: 5;
      top: 0;
      display: flex;
      min-height: 68px;
      align-items: center;
      gap: 2rem;
      padding: .75rem clamp(1.25rem, 5vw, 4.5rem);
      border-bottom: 1px solid color-mix(in srgb, var(--line), transparent 18%);
      background: color-mix(in srgb, var(--bg), transparent 7%);
      backdrop-filter: blur(16px);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: .7rem;
      color: var(--text);
      text-decoration: none;
      white-space: nowrap;
    }
    .brand-mark {
      display: grid;
      width: 2rem;
      height: 2rem;
      place-items: center;
      border: 1px solid color-mix(in srgb, var(--accent), transparent 68%);
      border-radius: 9px;
      background: var(--accent-soft);
      color: var(--accent-strong);
    }
    .brand-mark svg { width: 1.15rem; height: 1.15rem; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .brand-name { font-size: .94rem; font-weight: 650; letter-spacing: -.035em; }
    nav { display: flex; align-items: center; gap: .4rem; margin-left: auto; }
    nav a, .link {
      border: 0;
      border-radius: 7px;
      padding: .42rem .7rem;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
      font-size: .86rem;
      text-decoration: none;
      transition: color .16s, background .16s;
    }
    nav a:hover, .link:hover { background: var(--surface-raised); color: var(--text); text-decoration: none; }
    nav form { margin: 0; }
    .theme-toggle {
      display: inline-flex;
      min-height: 2.15rem;
      align-items: center;
      gap: .4rem;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: .35rem .65rem;
      background: var(--surface);
      color: var(--muted);
      cursor: pointer;
      font: inherit;
      font-size: .8rem;
      transition: border-color .16s, color .16s;
    }
    .theme-toggle:hover { border-color: var(--accent); color: var(--text); }
    .theme-toggle svg, .external-link-icon { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .who { max-width: 15rem; overflow: hidden; color: var(--muted); font-size: .8rem; text-overflow: ellipsis; white-space: nowrap; }
    .inline { display: inline; }
    main { width: min(100% - 3rem, 1080px); margin: 0 auto; padding: clamp(2.5rem, 6vw, 5rem) 0 5rem; }
    .page-heading { display: flex; justify-content: space-between; gap: 1rem; align-items: end; margin: 0 0 2rem; }
    .page-heading .muted { margin: 0 0 .35rem; color: var(--accent); font-size: .73rem; font-weight: 650; letter-spacing: .105em; text-transform: uppercase; }
    .page-heading h2 { margin: 0; font-size: clamp(1.8rem, 4vw, 2.6rem); font-weight: 570; letter-spacing: -.06em; line-height: 1.12; }
    .card {
      margin-bottom: 1.1rem;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: clamp(1.25rem, 3vw, 1.8rem);
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .card h2, .card h3 { margin: 0 0 .75rem; font-weight: 590; letter-spacing: -.035em; line-height: 1.3; }
    .card h2 { font-size: 1.08rem; }
    .card h3 { font-size: .98rem; }
    .card > :last-child { margin-bottom: 0; }
    .card p.dashboard-back-link-row { margin-top: 1.5rem; }
    a.dashboard-back-link { display: inline-flex; min-height: 2.4rem; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: 7px; padding: .45rem .85rem; background: var(--surface-raised); color: var(--text); font-size: .82rem; font-weight: 580; text-decoration: none; transition: border-color .16s, background .16s, color .16s; }
    a.dashboard-back-link:hover { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-strong); text-decoration: none; }
    .card > p:first-of-type { margin-top: .35rem; }
    form.row { display: flex; align-items: end; flex-wrap: wrap; gap: .85rem; }
    form.row > div { flex: 1 1 180px; }
    form.row > button { flex: 0 0 auto; }
    form.provisioning-form { display: grid; grid-template-columns: minmax(0, 1fr); align-items: stretch; gap: 1rem; }
    form.provisioning-form > div { min-width: 0; }
    form.provisioning-form > button { width: 100%; }
    label { display: block; margin-bottom: .4rem; color: var(--muted); font-size: .78rem; font-weight: 560; }
    input[type=text], input[type=password], input[type=file], select {
      min-width: min(260px, 100%);
      min-height: 2.7rem;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: .62rem .75rem;
      background: var(--bg);
      color: var(--text);
      font: inherit;
      font-size: .88rem;
      transition: border-color .16s, box-shadow .16s, background .16s;
    }
    input::placeholder { color: color-mix(in srgb, var(--muted), transparent 22%); }
    input:hover, select:hover { border-color: color-mix(in srgb, var(--accent), var(--line) 45%); }
    input:focus, select:focus { border-color: var(--accent); background: var(--surface); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent), transparent 87%); outline: 0; }
    input[type=checkbox] { accent-color: var(--accent); }
    .password-group { flex: 1 1 280px; min-width: min(260px, 100%); }
    .password-control { display: flex; align-items: stretch; gap: .45rem; }
    .password-input { width: 100%; min-width: 0 !important; }
    .password-control-button { flex: 0 0 5rem; padding: .45rem .6rem !important; }
    .password-feedback { display: flex; align-items: center; gap: .6rem; min-height: 1.5rem; margin-top: .25rem; }
    .password-meter { width: 5rem; height: .5rem; accent-color: #b75b50; }
    .password-meter[data-strength="fair"] { accent-color: #bd8b48; }
    .password-meter[data-strength="strong"] { accent-color: #638266; }
    .password-match[data-match="yes"] { color: #638266; }
    .password-match[data-match="no"] { color: var(--danger); }
    .password-generate { margin-top: .4rem; padding: .4rem .65rem !important; font-size: .82rem !important; }
    input[aria-invalid="true"] { border-color: var(--danger); }
    button[type=submit], button.action, a.primary {
      display: inline-flex;
      min-height: 2.6rem;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--accent-strong);
      border-radius: 7px;
      padding: .55rem .95rem;
      background: var(--accent-strong);
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-size: .84rem;
      font-weight: 590;
      text-decoration: none;
      transition: transform .16s, background .16s, border-color .16s, box-shadow .16s;
    }
    button[type=submit]:hover, button.action:hover, a.primary:hover { transform: translateY(-1px); background: var(--accent); border-color: var(--accent); color: #fff; box-shadow: 0 4px 12px color-mix(in srgb, var(--accent), transparent 80%); text-decoration: none; }
    button.danger { border-color: var(--danger); background: var(--danger); color: #fff; }
    button.secondary { border-color: var(--line); background: var(--surface); color: var(--text); }
    button.secondary:hover { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-strong); box-shadow: none; }
    button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent), transparent 45%); outline-offset: 2px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: .86rem; }
    th, td { border-bottom: 1px solid var(--line); padding: .85rem .7rem; text-align: left; vertical-align: middle; }
    th { color: var(--muted); font-size: .68rem; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; white-space: nowrap; }
    tbody tr { transition: background .14s; }
    tbody tr:hover { background: color-mix(in srgb, var(--surface-raised), transparent 40%); }
    tbody tr:last-child td { border-bottom: 0; }
    .badge { display: inline-flex; align-items: center; border: 1px solid transparent; border-radius: 999px; padding: .2rem .58rem; font-size: .7rem; font-weight: 650; letter-spacing: .01em; white-space: nowrap; }
    .badge.ready { border-color: #d4e3d3; background: #edf4eb; color: #48664b; }
    .badge.failed { border-color: #edd2cd; background: #fbefec; color: #9c4d43; }
    .badge.pending { border-color: #e9dfca; background: #f8f3e7; color: #8a7041; }
    .error { border-color: color-mix(in srgb, var(--danger), var(--line) 60%); background: color-mix(in srgb, var(--danger), var(--surface) 94%); color: var(--danger); }
    .muted { color: var(--muted); font-size: .84rem; }
    .err-text { color: var(--danger); font-size: .84rem; }
    .warning { border-color: #dfcda9; background: #fbf7ed; }
    .danger-zone { border-color: color-mix(in srgb, var(--danger), var(--line) 58%); }
    .actions { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; }
    .hostname-link { display: inline-flex; align-items: center; gap: .35rem; color: var(--accent-strong); text-decoration: none; white-space: nowrap; }
    .hostname-link:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    a.manage-link { display: inline-flex; min-height: 2.15rem; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: 7px; padding: .35rem .7rem; background: var(--surface); color: var(--text); font-size: .78rem; font-weight: 600; text-decoration: none; transition: border-color .16s, background .16s; }
    a.manage-link:hover { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-strong); text-decoration: none; }
    button:disabled { cursor: not-allowed; opacity: .48; transform: none !important; box-shadow: none !important; }
    .metric { display: inline-flex; align-items: baseline; gap: .35rem; border: 1px solid var(--line); border-radius: 999px; padding: .4rem .8rem; background: var(--surface); color: var(--muted); font-size: .78rem; box-shadow: var(--shadow); }
    pre { overflow: auto; border: 1px solid var(--line); border-radius: 8px; padding: 1rem; background: var(--bg); color: var(--text); font-size: .78rem; }
    :root[data-theme="dark"] .badge.ready { border-color: #3e5841; background: #29392c; color: #b9d0b8; }
    :root[data-theme="dark"] .badge.failed { border-color: #65423d; background: #422e2a; color: #efb7ad; }
    :root[data-theme="dark"] .badge.pending { border-color: #62563d; background: #3b3528; color: #e2cc97; }
    :root[data-theme="dark"] .warning { border-color: #62563d; background: #302d25; }
    :root[data-theme="dark"] .password-match[data-match="yes"] { color: #b9d0b8; }
    @media (max-width: 700px) {
      header { position: static; align-items: flex-start; flex-wrap: wrap; gap: .8rem; padding: .85rem 1rem; }
      nav { width: 100%; flex-wrap: wrap; gap: .2rem; margin-left: 0; }
      .who { max-width: 100%; margin-left: auto; align-self: center; }
      main { width: min(100% - 2rem, 1080px); padding: 2.3rem 0 3rem; }
      .page-heading { align-items: flex-start; flex-direction: column; margin-bottom: 1.5rem; }
      .card { padding: 1.15rem; }
      form.row > div, .password-group { flex-basis: 100%; }
      form.row > button { width: 100%; }
      th, td { padding: .7rem .55rem; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
    }
  </style>
  <script>
    (function () {
      var stored;
      try { stored = localStorage.getItem('erpnext-hosting-theme'); } catch (_) {}
      var theme = stored === 'light' || stored === 'dark'
        ? stored
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', theme);
    })();
  </script>
</head>
<body>
  <header>
    <a class="brand" href="${user ? '/dashboard' : '/'}" aria-label="ERPNext Hosting home">
      <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 18.5V5.5h5.2c3 0 4.8 1.6 4.8 4.1 0 2.4-1.8 4-4.8 4H5"/><path d="m13.5 13.5 5.5 5M15 5.5h4v4"/></svg></span>
      <span class="brand-name">ERPNext Hosting</span>
    </a>
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
  <script>
    (function () {
      function secureRandomInt(max) {
        var range = Math.floor(4294967296 / max) * max;
        var value;
        do {
          var random = new Uint32Array(1);
          window.crypto.getRandomValues(random);
          value = random[0];
        } while (value >= range);
        return value % max;
      }

      function generatePassword() {
        if (!window.crypto || !window.crypto.getRandomValues) {
          throw new Error('Secure password generation is unavailable in this browser.');
        }
        var groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*-_=+?'];
        var alphabet = groups.join('');
        var characters = groups.map(function (group) {
          return group[secureRandomInt(group.length)];
        });
        while (characters.length < 20) {
          characters.push(alphabet[secureRandomInt(alphabet.length)]);
        }
        for (var i = characters.length - 1; i > 0; i -= 1) {
          var index = secureRandomInt(i + 1);
          var character = characters[i];
          characters[i] = characters[index];
          characters[index] = character;
        }
        return characters.join('');
      }

      function updateForm(form) {
        var password = form.querySelector('[data-password-value]');
        var confirmation = form.querySelector('[data-password-confirm]');
        var match = form.querySelector('[data-password-match]');
        var meter = form.querySelector('[data-password-meter]');
        var strength = form.querySelector('[data-password-strength]');
        if (!password || !confirmation) return;

        var value = password.value;
        if (meter && strength) {
          var variety = [
            /[a-z]/.test(value),
            /[A-Z]/.test(value),
            /[0-9]/.test(value),
            /[^A-Za-z0-9]/.test(value)
          ].filter(Boolean).length;
          var score = (value.length >= 12 ? 1 : 0)
            + (value.length >= 16 ? 1 : 0)
            + (value.length >= 20 ? 1 : 0)
            + (variety >= 3 ? 1 : 0)
            + (variety === 4 ? 1 : 0);
          var level = score >= 4 ? 'strong' : score >= 2 ? 'fair' : 'weak';
          meter.value = score;
          meter.setAttribute('data-strength', value ? level : '');
          strength.textContent = !value
            ? 'Use at least 12 characters.'
            : value.length < 12
              ? 'Too short — use at least 12 characters.'
              : level.charAt(0).toUpperCase() + level.slice(1) + ' password';
        }

        confirmation.setCustomValidity('');
        if (!confirmation.value) {
          confirmation.removeAttribute('aria-invalid');
          if (match) {
            match.textContent = '';
            match.removeAttribute('data-match');
          }
          return;
        }
        var matches = value === confirmation.value;
        confirmation.setCustomValidity(matches ? '' : 'Administrator passwords do not match.');
        confirmation.setAttribute('aria-invalid', String(!matches));
        if (match) {
          match.textContent = matches ? 'Passwords match.' : 'Passwords do not match yet.';
          match.setAttribute('data-match', matches ? 'yes' : 'no');
        }
      }

      document.querySelectorAll('form[data-password-form]').forEach(function (form) {
        var password = form.querySelector('[data-password-value]');
        var confirmation = form.querySelector('[data-password-confirm]');
        if (!password || !confirmation) return;

        form.querySelectorAll('[data-password-toggle]').forEach(function (toggle) {
          toggle.addEventListener('click', function () {
            var input = document.getElementById(toggle.getAttribute('aria-controls'));
            if (!input) return;
            var visible = input.type === 'password';
            input.type = visible ? 'text' : 'password';
            toggle.textContent = visible ? 'Hide' : 'Show';
            toggle.setAttribute('aria-label', (visible ? 'Hide' : 'Show') + ' ' + (input === password ? 'password' : 'confirmation password'));
            toggle.setAttribute('aria-pressed', String(visible));
          });
        });

        password.addEventListener('input', function () { updateForm(form); });
        confirmation.addEventListener('input', function () { updateForm(form); });
        form.querySelectorAll('[data-password-generate]').forEach(function (button) {
          button.addEventListener('click', function () {
            try {
              var generated = generatePassword();
              password.value = generated;
              confirmation.value = generated;
              password.dispatchEvent(new Event('input', { bubbles: true }));
              confirmation.dispatchEvent(new Event('input', { bubbles: true }));
              password.type = 'text';
              confirmation.type = 'text';
              form.querySelectorAll('[data-password-toggle]').forEach(function (toggle) {
                toggle.textContent = 'Hide';
                toggle.setAttribute('aria-pressed', 'true');
                toggle.setAttribute('aria-label', 'Hide ' + (toggle.getAttribute('aria-controls') === password.id ? 'password' : 'confirmation password'));
              });
              password.focus();
            } catch (error) {
              var feedback = form.querySelector('[data-password-strength]');
              if (feedback) feedback.textContent = error.message;
            }
          });
        });
        form.addEventListener('submit', function (event) {
          updateForm(form);
          if (password.value.length < 12 || password.value.length > 128 || password.value !== confirmation.value) {
            event.preventDefault();
            if (password.value.length < 12 || password.value.length > 128) password.reportValidity();
            else confirmation.reportValidity();
          }
        });
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
        <form class="row provisioning-form" method="post" action="/dashboard/instances" data-password-form>
          <div>
            <label for="name">Company / site name</label>
            <input id="name" type="text" name="name" placeholder="Acme Manufacturing" required maxlength="100">
          </div>
          ${passwordFields('adminPassword', 'confirmAdminPassword', 'ERPNext Administrator password', 'Confirm Administrator password')}
          <button type="submit">Create instance</button>
        </form>
        <p class="muted">Use at least 12 characters; longer passphrases are stronger. Your login is <strong>Administrator</strong>; the password is encrypted for recovery and can be changed later.</p>
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
    const parsed = createFormBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Please check the form fields';
      await reply.redirect(`/dashboard?error=${encodeURIComponent(message)}`, 303);
      return;
    }
    const body = parsed.data;
    try {
      const instance = await instanceService.create(user, {
        companyName: body.name ?? '',
        adminPassword: body.adminPassword,
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
    const hasLoginCredentials = await instanceService.hasLoginCredentials(instance.id);
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
    const credentialChangePending =
      latestJob?.type === 'credentials' && ['queued', 'running'].includes(latestJob.status);
    const credentialChangeFailed =
      latestJob?.type === 'credentials' && latestJob.status === 'failed';
    const credentialChangeSucceeded =
      latestJob?.type === 'credentials' && latestJob.status === 'succeeded';
    const credentialsPanel = ready
      ? `<div class="card">
        <h3>ERPNext login</h3>
        <p>Sign in at your workspace using username <strong>Administrator</strong>.</p>
        ${
          hasLoginCredentials
            ? `<p><button class="action secondary" type="button" id="showCredentials">Show saved password</button></p>
              <div id="credentialResult" class="muted" aria-live="polite"></div>`
            : '<p class="muted">No recoverable password is stored for this site yet. Set a new password below to regain managed access.</p>'
        }
        ${
          credentialChangePending
            ? '<p class="muted" role="status">Password change is being applied. Keep using your current password until the operation completes.</p>'
            : ''
        }
        ${credentialChangePending ? '<script>setTimeout(function () { location.reload(); }, 3000);</script>' : ''}
        ${
          credentialChangeSucceeded
            ? '<p class="muted" role="status">Administrator password updated successfully.</p>'
            : ''
        }
        ${
          credentialChangeFailed
            ? `<p class="err-text">Password change failed: ${escapeHtml(latestJob?.lastError ?? 'unknown error')}. The saved current password is unchanged; submit a new password to retry.</p>`
            : ''
        }
        <form class="row" method="post" action="/dashboard/instances/${encodeURIComponent(instance.id)}/credentials" data-password-form>
          ${passwordFields('newAdminPassword', 'confirmNewAdminPassword', 'New Administrator password', 'Confirm new password', credentialChangePending)}
          <button class="action" type="submit" ${credentialChangePending ? 'disabled' : ''}>${hasLoginCredentials ? 'Change password' : 'Set password'}</button>
        </form>
        <p class="muted">Passwords are encrypted in platform storage. A password change is applied by the worker and remains pending until successful. If you change the password directly in ERPNext, its one-way hash cannot be recovered here; update it through this panel to keep recovery in sync.</p>
        ${
          hasLoginCredentials
            ? `<script>
              (function () {
                var button = document.getElementById('showCredentials');
                var output = document.getElementById('credentialResult');
                var revealed = false;
                button.addEventListener('click', function () {
                  if (revealed) {
                    output.textContent = '';
                    button.textContent = 'Show saved password';
                    revealed = false;
                    return;
                  }
                  button.disabled = true;
                  fetch('/api/instances/${encodeURIComponent(instance.id)}/credentials', { credentials: 'same-origin', cache: 'no-store' })
                    .then(function (response) {
                      if (!response.ok) throw new Error('Could not load saved credentials.');
                      return response.json();
                    })
                    .then(function (data) {
                      output.textContent = 'Username: ' + data.credentials.username + ' · Password: ' + data.credentials.password;
                      button.textContent = 'Hide saved password';
                      revealed = true;
                    })
                    .catch(function (error) { output.textContent = error.message; })
                    .finally(function () { button.disabled = false; });
                });
              })();
            </script>`
            : ''
        }
      </div>`
      : '';
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
        <p class="muted">Latest operation attempts: ${latestJob?.attempts ?? 0} / ${latestJob?.maxAttempts ?? 0}</p>
        <p class="dashboard-back-link-row"><a class="dashboard-back-link" href="/dashboard">Back to dashboard</a></p>
        ${poll}
      </div>`;
    const editableBody = `
      ${credentialsPanel}
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

  app.post('/dashboard/instances/:id/credentials', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const parsed = credentialsFormBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Please check the password fields';
      await reply.redirect(`/dashboard/instances/${encodeURIComponent(id)}?error=${encodeURIComponent(message)}`, 303);
      return;
    }
    const body = parsed.data;
    try {
      await instanceService.changeLoginPassword(user, id, body.adminPassword);
      await reply.redirect(`/dashboard/instances/${encodeURIComponent(id)}`, 303);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not change login password';
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
        <p class="muted">S3 credentials and per-instance Administrator passwords are encrypted before storage. Configure the same persistent BACKUP_CREDENTIALS_ENCRYPTION_KEY in API and worker deployments. Local full backups remain available if remote upload fails. Next run: ${siteBackupSettings.nextRunAt?.toISOString() ?? 'not scheduled'}.</p>
      </div>
      <div class="card">
        <h2>Backup &amp; restore</h2>
        <p class="muted">Platform snapshots contain accounts, ownership, instances and jobs — never sessions, tokens, or ERPNext business data. Instance login passwords are included only as encrypted ciphertext; retain the matching BACKUP_CREDENTIALS_ENCRYPTION_KEY to restore them.</p>
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
