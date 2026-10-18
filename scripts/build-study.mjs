#!/usr/bin/env node
// Renders the troubleshooting spine, ADRs, runbooks and notes into one
// self-contained study page. Node standard library only.
// Conventions: docs/notes/README.md

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPINE = join(ROOT, 'docs/troubleshooting-spine.html');
const ADR_DIR = join(ROOT, 'docs/adr');
const RUNBOOK_DIR = join(ROOT, 'runbooks');
const NOTES_DIR = join(ROOT, 'docs/notes');
const LINUX_NOTE = 'linux-map';
const HOW_NOTE = 'how-it-works';
const INTERVIEW_NOTE = 'interview';
const DIAGRAM_DIR = join(ROOT, 'scripts/study/diagrams');

let out = join(ROOT, 'docs/study/index.html');
let includeTemplates = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out' && argv[i + 1]) out = resolve(argv[++i]);
  else if (argv[i] === '--include-templates') includeTemplates = true;
  else {
    console.error(`usage: build-study.sh [--out <path>] [--include-templates]\nunknown argument: ${argv[i]}`);
    process.exit(2);
  }
}

const warnings = [];
const rel = (f) => relative(ROOT, f);
const warn = (file, msg) => warnings.push(`${rel(file)}: ${msg}`);

// ---------- markdown ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => s.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function inline(text) {
  const codes = [];
  let s = text.replace(/\\\|/g, '|').replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>/;
const DIAGRAM = /^\s*\[diagram:\s*([\w-]+)\]\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const indentOf = (l) => l.match(/^\s*/)[0].length;
const isTable = (lines, i) => lines[i].trim().startsWith('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]);
const startsBlock = (lines, i) => {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || RULE.test(l) || LIST.test(l) || QUOTE.test(l) || DIAGRAM.test(l) || isTable(lines, i);
};

function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

function codeBlock(code, lang) {
  const attr = lang ? ` data-lang="${esc(lang)}"` : '';
  return `<div class="code"${attr}><button type="button" class="copy">Copy</button><pre><code>${esc(code)}</code></pre></div>`;
}

// [diagram: name] inlines scripts/study/diagrams/name.mjs (generated: export html(),
// optionally svg() and svgPath) or, failing that, the hand-written name.html.
const diagramMods = new Map();
if (existsSync(DIAGRAM_DIR)) {
  for (const f of readdirSync(DIAGRAM_DIR).filter((n) => n.endsWith('.mjs')).sort()) {
    const name = basename(f, '.mjs');
    diagramMods.set(name, await import(pathToFileURL(join(DIAGRAM_DIR, f)).href));
    if (existsSync(join(DIAGRAM_DIR, `${name}.html`))) warn(join(DIAGRAM_DIR, `${name}.html`), `shadowed by ${name}.mjs and unused; delete it`);
  }
}
const diagramsUsed = new Set();
function diagramFile(name) {
  if (diagramMods.has(name)) { diagramsUsed.add(name); return diagramMods.get(name).html(); }
  const file = join(DIAGRAM_DIR, `${name}.html`);
  if (!existsSync(file)) { warn(file, 'not found'); return null; }
  diagramsUsed.add(name);
  return readFileSync(file, 'utf8');
}
const diagram = (name) => {
  const html = diagramFile(name);
  return html === null ? `<p class="missing">Missing diagram: scripts/study/diagrams/${esc(name)}.html</p>` : `<figure class="dg" data-diagram="${esc(name)}">${html}</figure>`;
};
const diagramText = (name) => {
  const file = join(DIAGRAM_DIR, `${name}.html`);
  const src = diagramMods.has(name) ? diagramMods.get(name).html() : existsSync(file) ? readFileSync(file, 'utf8') : '';
  return src.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
};

function table(lines, i) {
  const head = cells(lines[i]);
  const align = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : ''));
  const rows = [];
  i += 2;
  while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
  const td = (tag, c, j) => `<${tag}${align[j] ? ` style="text-align:${align[j]}"` : ''}>${inline(c)}</${tag}>`;
  const qa = norm(head[head.length - 1]) === 'answer' ? ' class="qa"' : '';
  const html = `<div class="tbl"><table${qa}><thead><tr>${head.map((c, j) => td('th', c, j)).join('')}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr>${head.map((_, j) => td('td', r[j] ?? '', j)).join('')}</tr>`).join('')}</tbody></table></div>`;
  return [html, i];
}

function list(lines, i) {
  const first = lines[i].match(LIST);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  while (i < lines.length) {
    const l = lines[i];
    const m = l.match(LIST);
    if (m && m[1].length === indent) { items.push({ text: [m[3]], rest: [] }); i++; continue; }
    if (m && m[1].length < indent) break;
    const item = items[items.length - 1];
    if (!l.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const nm = j < lines.length && lines[j].match(LIST);
      if (j < lines.length && (indentOf(lines[j]) > indent || (nm && nm[1].length === indent))) {
        if (indentOf(lines[j]) > indent) for (let k = i; k < j; k++) item.rest.push('');
        i = j;
        continue;
      }
      break;
    }
    if (indentOf(l) > indent) {
      // An indented line continues the item's text until a nested block starts.
      if (!item.rest.length && !startsBlock(lines, i)) item.text.push(l.trim());
      else item.rest.push(l);
      i++;
      continue;
    }
    if (!startsBlock(lines, i)) { item.text.push(l.trim()); i++; continue; }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const start = ordered && parseInt(first[2], 10) !== 1 ? ` start="${parseInt(first[2], 10)}"` : '';
  const lis = items.map((it) => {
    let body = inline(it.text.join(' '));
    if (it.rest.length) {
      const min = Math.min(...it.rest.filter((r) => r.trim()).map(indentOf));
      body += blocks(it.rest.map((r) => r.slice(Math.min(min, indentOf(r)))));
    }
    return `<li>${body}</li>`;
  }).join('');
  return [`<${tag}${start}>${lis}</${tag}>`, i];
}

function blocks(lines) {
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }
    if ((m = line.match(FENCE))) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(m[1])) body.push(lines[i++]);
      i++;
      const pad = Math.min(...body.filter((b) => b.trim()).map(indentOf), Infinity);
      html += codeBlock(body.map((b) => b.slice(Number.isFinite(pad) ? pad : 0)).join('\n'), m[2]);
      continue;
    }
    if ((m = line.match(HEADING))) {
      const n = m[1].length;
      html += `<h${n}>${inline(m[2])}</h${n}>`;
      i++;
      continue;
    }
    if (RULE.test(line)) { html += '<hr>'; i++; continue; }
    if ((m = line.match(DIAGRAM))) { html += diagram(m[1]); i++; continue; }
    if (isTable(lines, i)) { const [h, ni] = table(lines, i); html += h; i = ni; continue; }
    if (QUOTE.test(line)) {
      const q = [];
      while (i < lines.length && QUOTE.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += `<blockquote>${blocks(q)}</blockquote>`;
      continue;
    }
    if (LIST.test(line)) { const [h, ni] = list(lines, i); html += h; i = ni; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++].trim());
    html += `<p>${inline(para.join(' '))}</p>`;
  }
  return html;
}

const md = (text) => blocks(text.replace(/\r\n?/g, '\n').split('\n'));

// Plain text for the search index.
const plain = (text) => text
  .replace(new RegExp(DIAGRAM.source, 'gm'), (_, n) => diagramText(n))
  .replace(/^\s*(`{3,}|~{3,}).*$/gm, '')
  .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
  .replace(/\\\|/g, '|')
  .replace(/[|*`#>]/g, ' ')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

// ---------- sources ----------

function parseDoc(file) {
  const lines = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  let title = null;
  let cur = null;
  let fence = false;
  const meta = [];
  const intro = [];
  const sections = [];
  for (const line of lines) {
    if (FENCE.test(line)) fence = !fence;
    if (!fence && title === null && /^#\s+/.test(line)) { title = line.replace(/^#\s+/, '').trim(); continue; }
    if (!fence && /^##\s+/.test(line)) {
      cur = { heading: line.replace(/^##\s+/, '').replace(/\s*#*\s*$/, '').trim(), lines: [] };
      sections.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
    else if (title !== null) {
      const m = line.match(/^([A-Z][\w -]{0,30}):\s+(.+)$/);
      if (m && !intro.some((l) => l.trim())) meta.push([m[1], m[2]]);
      else intro.push(line);
    }
  }
  const name = basename(file, '.md');
  if (!title) { warn(file, 'no "# Title" line, using the file name'); title = name; }
  sections.forEach((s) => { s.text = s.lines.join('\n'); s.slug = slug(s.heading); });
  return { file, name, title, meta, intro: intro.join('\n').trim(), sections };
}

function listMd(dir, skip = []) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !skip.includes(f) && (includeTemplates || !f.startsWith('_')))
    .sort()
    .map((f) => parseDoc(join(dir, f)));
}

// ---------- rendering ----------

const index = [];
const domId = (s) => s.replace(/[^A-Za-z0-9_-]+/g, '-');
const reviewBox = (key) => `<label class="rev"><input type="checkbox" data-rev="${esc(key)}"> Reviewed</label>`;
const missing = (label) => `<p class="missing">Missing: add <code>## ${esc(label)}</code> to the source.</p>`;

function cardHead(doc, key, coverLabel) {
  const chips = doc.meta.map(([k, v]) => `<span class="chip"><span>${esc(k)}</span> ${inline(v)}</span>`).join('');
  const cover = coverLabel
    ? `<button type="button" class="btn cover-btn" aria-pressed="false" title="Hide ${coverLabel} to quiz yourself">Cover ${coverLabel}</button>`
    : '';
  const tmpl = doc.name.startsWith('_') ? '<span class="chip tmpl">template</span>' : '';
  return `<header class="card-head"><h2>${inline(doc.title)}</h2>${tmpl}<div class="chips">${chips}</div>`
    + `<div class="ctl">${cover}${reviewBox(key)}</div>`
    + `<span class="src">${esc(rel(doc.file))}</span></header>`
    + (doc.intro ? `<div class="md intro">${md(doc.intro)}</div>` : '');
}

function coverable(inner, label) {
  return `<div class="cov-body">${inner}</div><button type="button" class="veil">Covered. Reveal ${esc(label)}</button>`;
}

const ADR_BOXES = [
  ['context', 'Context'],
  ['options', 'Options'],
  ['decision', 'Decision'],
  ['when i would flip it', 'When I would flip it'],
];

function renderAdr(doc) {
  const key = `adr:${doc.name}`;
  const id = domId(`adr-${doc.name}`);
  const byName = new Map(doc.sections.map((s) => [norm(s.heading), s]));
  const boxes = ADR_BOXES.map(([k, label]) => {
    const s = byName.get(k);
    if (!s) warn(doc.file, `missing "## ${label}"`);
    const body = s ? md(s.text) : missing(label);
    const cls = `box box-${k.split(' ')[0]}`;
    if (k === 'decision') return `<section class="${cls} coverable"><h3>${label}</h3><div class="md">${coverable(body, label)}</div></section>`;
    return `<section class="${cls}"><h3>${label}</h3><div class="md">${body}</div></section>`;
  }).join('');
  const known = new Set(ADR_BOXES.map(([k]) => k));
  const extra = doc.sections.filter((s) => !known.has(norm(s.heading)))
    .map((s) => `<section class="box box-extra"><h3>${inline(s.heading)}</h3><div class="md">${md(s.text)}</div></section>`).join('');
  index.push({ v: 'adr', t: id, g: 'Trade-offs', h: doc.title, x: plain(doc.sections.map((s) => `${s.heading} ${s.text}`).join(' ')) });
  return `<article class="card adr" id="${id}">${cardHead(doc, key, 'decision')}<div class="adr-grid">${boxes}${extra}</div></article>`;
}

const STEPS = ['Detect', 'Triage', 'Mitigate', 'Diagnose', 'Fix'];

function renderRunbook(doc) {
  const key = `runbook:${doc.name}`;
  const id = domId(`rb-${doc.name}`);
  const byName = new Map(doc.sections.map((s) => [norm(s.heading), s]));
  const steps = STEPS.map((label, n) => {
    const s = byName.get(norm(label));
    if (!s) warn(doc.file, `missing "## ${label}"`);
    const body = s ? md(s.text) : missing(label);
    const head = `<div class="step-h"><span class="step-n">${n + 1}</span>${label}</div>`;
    if (label === 'Fix') return `<section class="step coverable">${head}<div class="md">${coverable(body, label)}</div></section>`;
    return `<section class="step">${head}<div class="md">${body}</div></section>`;
  }).join('');
  const pm = byName.get('postmortem');
  if (!pm) warn(doc.file, 'missing "## Postmortem"');
  else {
    const n = pm.lines.filter((l) => /^\s*([-*+]|\d+[.)])\s+/.test(l) && indentOf(l) === 0).length;
    if (n !== 10) warn(doc.file, `postmortem has ${n} list items, expected 10`);
  }
  const pmBody = pm ? md(pm.text).replace(/<li>([^<:]{1,40}):/g, '<li><span class="k">$1</span>') : missing('Postmortem');
  const known = new Set([...STEPS.map(norm), 'postmortem']);
  const extra = doc.sections.filter((s) => !known.has(norm(s.heading)))
    .map((s) => `<section class="box box-extra"><h3>${inline(s.heading)}</h3><div class="md">${md(s.text)}</div></section>`).join('');
  index.push({ v: 'drills', t: id, g: 'Drills', h: doc.title, x: plain(doc.sections.map((s) => `${s.heading} ${s.text}`).join(' ')) });
  return `<article class="card runbook" id="${id}">${cardHead(doc, key, 'fix')}`
    + `<div class="rb">${steps}<aside class="pm"><div class="step-h"><span class="step-n">6</span>Postmortem</div><div class="md">${pmBody}</div></aside></div>`
    + (extra ? `<div class="rb-extra">${extra}</div>` : '')
    + '</article>';
}

function renderNote(doc, view, group) {
  const blocksHtml = doc.sections.map((s) => {
    const id = domId(`n-${doc.name}-${s.slug}`);
    index.push({ v: view, t: id, g: group, h: s.heading, x: plain(s.text) });
    return `<section class="nblock" id="${id}"><header><h2>${inline(s.heading)}</h2>${reviewBox(`note:${doc.name}#${s.slug}`)}</header><div class="md">${md(s.text)}</div></section>`;
  }).join('');
  if (!doc.sections.length) warn(doc.file, 'no "##" sections, nothing to review');
  return `<article class="note" id="${domId(`n-${doc.name}`)}"><header class="note-head"><h2>${inline(doc.title)}</h2><span class="src">${esc(rel(doc.file))}</span></header>`
    + (doc.intro ? `<div class="md intro">${md(doc.intro)}</div>` : '')
    + `<div class="nblocks">${blocksHtml}</div></article>`;
}

function spineIndex(html) {
  const text = (h) => h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/­/g, '')
    .replace(/\s+/g, ' ').trim();
  const units = [];
  const head = html.match(/<header[\s\S]*?<\/header>/);
  if (head) units.push({ h: 'Where I run commands', x: text(head[0]) });
  const main = html.match(/<main[\s\S]*?<\/main>/);
  if (main) {
    main[0].split(/<!--\s*(?=\d+\s*-->)/).slice(1).forEach((chunk) => {
      const n = chunk.match(/^(\d+)/)[1];
      const name = (chunk.match(/class="name">([^<]+)</) || [])[1] || 'row';
      units.push({ h: `${n}. ${name}`, x: text(chunk.replace(/^\d+\s*-->/, '')) });
    });
  }
  for (const m of html.matchAll(/<section class="panel[^"]*">\s*<h2>([\s\S]*?)<\/h2>([\s\S]*?)<\/section>/g)) {
    units.push({ h: text(m[1]), x: text(m[2]) });
  }
  if (!units.length) units.push({ h: 'Troubleshooting spine', x: text(html) });
  units.forEach((u) => index.push({ v: 'spine', t: '', g: 'Spine', ...u }));
  return units.length;
}

// ---------- page ----------

if (!existsSync(SPINE)) { console.error(`missing ${rel(SPINE)}`); process.exit(1); }
const spineSrc = readFileSync(SPINE, 'utf8');
const spineUnits = spineIndex(spineSrc);

const adrs = listMd(ADR_DIR);
const runbooks = listMd(RUNBOOK_DIR, ['README.md']);
const notes = listMd(NOTES_DIR, ['README.md']);
const interviewNotes = notes.filter((d) => d.name === INTERVIEW_NOTE);
const howNotes = notes.filter((d) => d.name === HOW_NOTE);
const linuxNotes = notes.filter((d) => d.name === LINUX_NOTE);
const conceptNotes = notes.filter((d) => ![LINUX_NOTE, HOW_NOTE, INTERVIEW_NOTE].includes(d.name));
if (!howNotes.length) warn(join(NOTES_DIR, `${HOW_NOTE}.md`), 'not found, How it works is empty');
if (!linuxNotes.length) warn(join(NOTES_DIR, `${LINUX_NOTE}.md`), 'not found, Linux map is empty');

const interviewHtml = interviewNotes.map((d) => renderNote(d, 'interview', 'Interview')).join('');
const howHtml = howNotes.map((d) => renderNote(d, 'how', 'How it works')).join('');
const adrHtml = adrs.map(renderAdr).join('');
const rbHtml = runbooks.map(renderRunbook).join('');
const linuxHtml = linuxNotes.map((d) => renderNote(d, 'linux', 'Linux map')).join('');
const conceptHtml = conceptNotes.map((d) => renderNote(d, 'concepts', 'Concepts')).join('');

const empty = (what, tmpl) => `<p class="empty">No ${what} yet. Copy <code>${tmpl}</code> to a new file and rebuild.</p>`;

const sub = (view, items) => (items.length
  ? `<ul>${items.map((it) => `<li><a href="#${view}/${it.id}" data-target="${it.id}"${it.key ? ` data-key="${esc(it.key)}"` : ''}>${esc(it.label)}</a></li>`).join('')}</ul>`
  : '');
const noteItems = (docs) => docs.flatMap((d) => d.sections.map((s) => ({
  id: domId(`n-${d.name}-${s.slug}`), key: `note:${d.name}#${s.slug}`, label: s.heading,
})));
const navGroups = [
  { view: 'interview', label: 'Interview', items: noteItems(interviewNotes) },
  { view: 'how', label: 'How it works', items: noteItems(howNotes) },
  { sep: 'Reference' },
  { view: 'spine', label: 'Spine', items: [] },
  { view: 'adr', label: 'Trade-offs', items: adrs.map((d) => ({ id: domId(`adr-${d.name}`), key: `adr:${d.name}`, label: d.title.replace(/^ADR\s*/i, '') })) },
  { view: 'drills', label: 'Drills', items: runbooks.map((d) => ({ id: domId(`rb-${d.name}`), key: `runbook:${d.name}`, label: d.title.replace(/^Runbook:\s*/i, '') })) },
  { view: 'linux', label: 'Linux map', items: noteItems(linuxNotes) },
  { view: 'concepts', label: 'Concepts', items: noteItems(conceptNotes) },
];
const navHtml = navGroups.map((g) => (g.sep ? `<li class="sep">${g.sep}</li>` : `<li><a href="#${g.view}" class="top" data-view="${g.view}">${g.label}<span class="count" data-count="${g.view}"></span></a>${sub(g.view, g.items)}</li>`)).join('');

const viewHead = (title, subtitle, cover) => `<header class="view-head"><h1>${title}</h1><span class="sub">${subtitle}</span>`
  + (cover ? `<div class="ctl"><button type="button" class="btn cover-all" aria-pressed="false">Cover all</button></div>` : '')
  + '</header>';

const sourceCount = 1 + adrs.length + runbooks.length + notes.length;
const built = new Date().toLocaleDateString('en-CA');
const json = JSON.stringify(index).replace(/</g, '\\u003c');

const CSS = readFileSync(join(ROOT, 'scripts/study/study.css'), 'utf8');
const JS = readFileSync(join(ROOT, 'scripts/study/study.js'), 'utf8');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EKS Study</title>
<style>
${CSS}
</style>
</head>
<body>
<nav class="side" aria-label="Sections">
  <div class="brand">EKS study</div>
  <input type="search" id="q" placeholder="Search all pages" aria-label="Search all pages" autocomplete="off" spellcheck="false">
  <ul class="nav">${navHtml}</ul>
  <p class="store-note" hidden>Reviewed marks will not be saved: browser storage is unavailable.</p>
  <p class="built">Built ${built} from ${sourceCount} sources</p>
</nav>
<main>
  <section class="view" data-view="interview"><header class="view-head"><h1>Interview track</h1><span class="sub">docs/notes/interview.md</span><div class="ctl"><button type="button" class="btn cover-qa" aria-pressed="false">Cover answers</button></div></header>${interviewHtml || empty('interview notes', 'docs/notes/README.md')}</section>
  <section class="view" data-view="how">${viewHead('How Kubernetes works', 'docs/notes/how-it-works.md, scripts/study/diagrams')}${howHtml || empty('How it works notes', 'docs/notes/README.md')}</section>
  <section class="view" data-view="spine">
    <header class="view-head"><h1>Troubleshooting spine</h1><span class="sub">docs/troubleshooting-spine.html, embedded unchanged</span>
      <div class="ctl"><a class="btn" href="../troubleshooting-spine.html">Open standalone</a>${reviewBox('spine')}</div></header>
    <iframe id="spine-frame" title="Troubleshooting spine" srcdoc="${esc(spineSrc)}"></iframe>
  </section>
  <section class="view" data-view="adr">${viewHead('Trade-offs', 'docs/adr', adrs.length)}${adrHtml || empty('ADRs', 'docs/adr/_template.md')}</section>
  <section class="view" data-view="drills">${viewHead('Drills', 'runbooks', runbooks.length)}${rbHtml || empty('runbooks', 'runbooks/_template.md')}</section>
  <section class="view" data-view="linux">${viewHead('Linux map', 'docs/notes/linux-map.md')}${linuxHtml || empty('Linux map', 'docs/notes/README.md')}</section>
  <section class="view" data-view="concepts">${viewHead('Concepts', 'docs/notes')}${conceptHtml || empty('concept notes', 'docs/notes/README.md')}</section>
  <section class="view" data-view="search" aria-live="polite"></section>
</main>
<script type="application/json" id="idx">${json}</script>
<script>
${JS}
</script>
</body>
</html>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);

// SVG copies of generated diagrams (README). Colours from the :root tokens in study.css.
const tokens = Object.fromEntries([...CSS.match(/:root\s*{[^}]*}/)[0].matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{3,8})/g)].map((m) => [m[1], m[2]]));
const svgsWritten = [];
for (const [name, mod] of diagramMods) {
  if (typeof mod.svg !== 'function' || !mod.svgPath) continue;
  const file = join(ROOT, mod.svgPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, mod.svg(tokens));
  svgsWritten.push(`${rel(file)} (${name})`);
}

console.log(`spine     ${rel(SPINE)} (${spineUnits} search units)`);
console.log(`adr       ${adrs.length} ${adrs.map((d) => basename(d.file)).join(' ')}`);
console.log(`runbooks  ${runbooks.length} ${runbooks.map((d) => basename(d.file)).join(' ')}`);
console.log(`notes     ${notes.length} ${notes.map((d) => `${basename(d.file)} (${d.sections.length} sections)`).join(', ')}`);
console.log(`diagrams  ${diagramsUsed.size} ${[...diagramsUsed].join(' ')}`);
console.log(`svg       ${svgsWritten.join(', ') || 'none'}`);
console.log(`index     ${index.length} search units`);
console.log(`wrote     ${out.startsWith(ROOT) ? rel(out) : out} (${Buffer.byteLength(page)} bytes)`);
warnings.forEach((w) => console.log(`warning   ${w}`));
