const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../../frontend/src/features');

function walk(dir, files = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else if (e.name.endsWith('.tsx')) files.push(p);
  }
  return files;
}

const reps = [
  [/text-slate-500/g, 'text-erp-text-muted'],
  [/text-slate-600/g, 'text-erp-text-secondary'],
  [/text-slate-700/g, 'text-erp-text-secondary'],
  [/text-slate-800/g, 'text-erp-text-primary'],
  [/text-slate-400/g, 'text-erp-text-muted'],
  [/bg-slate-50/g, 'bg-transparent'],
  [/bg-slate-100/g, 'bg-[var(--erp-accent-muted)]'],
  [/border-slate-200/g, 'border-[var(--erp-border)]'],
  [/border-slate-300/g, 'border-[var(--erp-border)]'],
  [/hover:bg-slate-50/g, 'hover:opacity-90'],
  [/rounded-lg border bg-white p-4 shadow-sm/g, 'erp-card p-4'],
  [/rounded-lg border bg-white p-3/g, 'erp-card-sm p-3'],
  [/rounded-lg border bg-white p-4/g, 'erp-card p-4'],
  [/overflow-hidden rounded-lg border bg-white/g, 'erp-card overflow-hidden p-0'],
  [/rounded-lg border bg-white/g, 'erp-card'],
  [/rounded bg-blue-600 px-3 py-1\.5 text-sm text-white/g, 'erp-btn-primary px-3 py-1.5'],
  [/rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700/g, 'erp-btn-primary px-4 py-2'],
  [/rounded bg-blue-600 px-3 py-1 text-sm text-white/g, 'erp-btn-primary px-3 py-1'],
  [/rounded border px-3 py-1 text-sm hover:bg-slate-50/g, 'erp-btn-secondary px-3 py-1'],
  [/className="min-w-full text-sm"/g, 'className="erp-data-table min-w-full"'],
  [/className="w-full text-sm"/g, 'className="erp-data-table w-full"'],
  [/text-blue-600/g, 'text-[var(--erp-accent)]'],
  [/bg-amber-100 text-amber-800/g, 'erp-status-badge erp-status-pending'],
  [/bg-green-100 text-green-800/g, 'erp-status-badge erp-status-delivered'],
  [/bg-red-100 text-red-700/g, 'erp-status-badge erp-status-cancelled'],
  [/bg-blue-100 text-blue-800/g, 'erp-status-badge erp-status-shipped'],
  [/bg-slate-100 text-slate-700/g, 'erp-status-badge erp-status-pending'],
];

const skip = new Set([
  path.join(root, 'auth', 'LoginPage.tsx'),
  path.join(root, 'dashboard', 'DashboardPage.tsx'),
]);

let count = 0;
for (const f of walk(root)) {
  if (skip.has(f)) continue;
  let s = fs.readFileSync(f, 'utf8');
  const orig = s;
  for (const [from, to] of reps) s = s.replace(from, to);
  if (s !== orig) {
    fs.writeFileSync(f, s);
    count += 1;
    console.log('updated', path.relative(root, f));
  }
}
console.log('total', count);
