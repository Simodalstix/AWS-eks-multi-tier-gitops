(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // Reviewed marks and checklist ticks. Storage can throw (file:// policy,
  // private mode, quota); the in-memory map keeps the page working for this
  // session either way.
  var PREFIX = 'eksstudy.reviewed.';
  var TASK = 'eksstudy.task.';
  var mem = {};
  var store = null;
  try {
    var probe = PREFIX + '__probe';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    store = window.localStorage;
  } catch (e) { store = null; }

  function storeFailed() { store = null; $('.store-note').hidden = false; }
  if (!store) storeFailed();

  function getItem(k) {
    if (Object.prototype.hasOwnProperty.call(mem, k)) return mem[k];
    try { return store ? store.getItem(k) : null; } catch (e) { return null; }
  }
  function setItem(k, v) {
    mem[k] = v;
    if (!store) return;
    try {
      if (v === null) store.removeItem(k); else store.setItem(k, v);
    } catch (e) { storeFailed(); }
  }
  function isReviewed(key) { return getItem(PREFIX + key) === '1'; }
  function setReviewed(key, on) { setItem(PREFIX + key, on ? '1' : null); }

  // A tick is keyed by its block id and its text, so editing the markdown
  // only resets the items that changed. '0' records an unticked [x] item.
  $$('input[data-task]').forEach(function (cb) {
    var host = cb.closest('[id]');
    cb.setAttribute('data-k', (host ? host.id : '') + '|' + cb.parentNode.textContent.trim().slice(0, 160));
  });
  function syncTasks() {
    var boxes = $$('input[data-task]');
    boxes.forEach(function (cb) {
      var v = getItem(TASK + cb.getAttribute('data-k'));
      cb.checked = v === null ? cb.defaultChecked : v === '1';
    });
    $$('.task-count').forEach(function (c) {
      var mine = $$('input[data-task]', c.closest('.view'));
      c.textContent = mine.length ? mine.filter(function (cb) { return cb.checked; }).length + '/' + mine.length + ' ticked' : '';
    });
  }

  function syncReviewed() {
    $$('input[data-rev]').forEach(function (cb) { cb.checked = isReviewed(cb.getAttribute('data-rev')); });
    $$('.nav a[data-key]').forEach(function (a) { a.classList.toggle('done', isReviewed(a.getAttribute('data-key'))); });
    $$('.nav .count').forEach(function (c) {
      var view = c.getAttribute('data-count');
      var keys = view === 'spine' ? ['spine'] : $$('.nav a[data-key][href^="#' + view + '/"]').map(function (a) { return a.getAttribute('data-key'); });
      var done = keys.filter(isReviewed).length;
      c.textContent = keys.length ? done + '/' + keys.length : '';
    });
  }

  // Spine iframe: grow to its content so the outer page scrolls, not the frame.
  var frame = $('#spine-frame');
  function fitSpine() {
    if (!frame || !frame.offsetParent) return;
    try {
      var doc = frame.contentDocument;
      if (!doc || !doc.documentElement) return;
      frame.style.height = '0px';
      frame.style.height = doc.documentElement.scrollHeight + 2 + 'px';
    } catch (e) { frame.style.height = ''; }
  }
  if (frame) frame.addEventListener('load', fitSpine);
  var resizeTimer;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitSpine, 100); });

  // Routing: #view or #view/element-id
  var q = $('#q');
  function show(view) {
    $$('.view').forEach(function (v) { v.classList.toggle('on', v.getAttribute('data-view') === view); });
    $$('.nav a.top').forEach(function (a) {
      var on = a.getAttribute('data-view') === view;
      a.classList.toggle('active', on);
      a.parentNode.classList.toggle('open', on);
    });
  }
  function route() {
    if (q.value.trim()) return search();
    var hash = decodeURIComponent(location.hash.slice(1));
    var parts = hash.split('/');
    var first = $('.nav a.top').getAttribute('data-view');
    var view = $('.view[data-view="' + parts[0] + '"]') && parts[0] !== 'search' ? parts[0] : first;
    show(view);
    if (view === 'spine') fitSpine();
    $$('.nav ul a').forEach(function (a) { a.classList.toggle('current', a.getAttribute('data-target') === parts[1]); });
    var target = parts[1] && document.getElementById(parts[1]);
    if (target) {
      target.scrollIntoView({ block: 'start' });
      target.classList.remove('flash');
      void target.offsetWidth;
      target.classList.add('flash');
    } else {
      window.scrollTo(0, 0);
    }
  }
  window.addEventListener('hashchange', route);

  // Search across every unit in the build-time index.
  var idx = [];
  try { idx = JSON.parse($('#idx').textContent); } catch (e) { idx = []; }
  idx.forEach(function (u) { u.l = (u.h + ' ' + u.x).toLowerCase(); });
  var results = $('.view[data-view="search"]');
  var nav = $('.nav');

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function highlight(text, terms) {
    var re = new RegExp('(' + terms.map(escRe).join('|') + ')', 'gi');
    return text.split(re).map(function (part, i) { return i % 2 ? '<mark>' + escHtml(part) + '</mark>' : escHtml(part); }).join('');
  }
  function snippet(text, terms) {
    var lower = text.toLowerCase();
    var at = -1;
    terms.forEach(function (t) { var p = lower.indexOf(t); if (p >= 0 && (at < 0 || p < at)) at = p; });
    if (at < 0) return text.slice(0, 200) + (text.length > 200 ? ' ...' : '');
    var start = Math.max(0, at - 70);
    var end = Math.min(text.length, at + 170);
    return (start ? '... ' : '') + text.slice(start, end) + (end < text.length ? ' ...' : '');
  }

  function search() {
    var raw = q.value.trim();
    if (!raw) {
      nav.classList.remove('filtering');
      $$('.nav a').forEach(function (a) { a.classList.remove('nohit'); });
      return route();
    }
    var terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
    var hits = idx.filter(function (u) { return terms.every(function (t) { return u.l.indexOf(t) >= 0; }); });
    var targets = {};
    hits.forEach(function (h) { targets[h.t] = true; });
    nav.classList.add('filtering');
    $$('.nav ul a').forEach(function (a) { a.classList.toggle('nohit', !targets[a.getAttribute('data-target')]); });
    var html = '<header class="view-head"><h1>Search</h1><span class="sub">' + hits.length + ' match' + (hits.length === 1 ? '' : 'es') +
      ' for "' + escHtml(raw) + '". Esc clears.</span></header>';
    html += hits.length ? '<div class="hits">' + hits.map(function (h) {
      var href = '#' + h.v + (h.t ? '/' + h.t : '');
      return '<a class="hit" href="' + escHtml(href) + '"><span class="g">' + escHtml(h.g) + '</span><b>' + highlight(h.h, terms) +
        '</b><span class="snip">' + highlight(snippet(h.x, terms), terms) + '</span></a>';
    }).join('') + '</div>' : '<p class="empty">Nothing matches every word.</p>';
    results.innerHTML = html;
    show('search');
  }

  var searchTimer;
  q.addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(search, 80); });
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { q.value = ''; search(); }
    if (e.key === 'Enter') { var first = $('.hit', results); if (first) first.click(); }
  });
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (e.key === '/' && tag !== 'input' && tag !== 'textarea') { e.preventDefault(); q.focus(); q.select(); }
  });

  // Copy buttons, cover toggles, reveal.
  function copyFallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return copyFallback(text); });
    }
    return Promise.resolve(copyFallback(text));
  }
  function setCover(card, on) {
    card.classList.toggle('covered', on);
    $$('.coverable', card).forEach(function (c) { c.classList.remove('revealed'); });
    var b = $('.cover-btn', card);
    if (b) b.setAttribute('aria-pressed', String(on));
  }

  // Live session: a drill block holds break, triage and restore together, so
  // each command line copies on its own. Comment and blank lines do not.
  $$('.view[data-view="session"] .code code').forEach(function (code) {
    code.innerHTML = code.innerHTML.split('\n').map(function (l) {
      return /^\s*(#|$)/.test(l) ? l : '<span class="ln" title="Copy this line">' + l + '</span>';
    }).join('\n');
  });

  document.addEventListener('click', function (e) {
    var t = e.target;
    var ln = t.closest('.ln');
    if (ln && !String(window.getSelection())) {
      copyText(ln.textContent.trim()).then(function (ok) {
        ln.classList.add(ok ? 'ok' : 'fail');
        setTimeout(function () { ln.classList.remove('ok', 'fail'); }, 900);
      });
      return;
    }
    var copy = t.closest('.copy');
    if (copy) {
      var code = copy.parentNode.querySelector('code').textContent;
      copyText(code).then(function (ok) {
        copy.textContent = ok ? 'Copied' : 'Copy failed';
        copy.classList.add(ok ? 'ok' : 'fail');
        setTimeout(function () { copy.textContent = 'Copy'; copy.classList.remove('ok', 'fail'); }, 1400);
      });
      return;
    }
    var cover = t.closest('.cover-btn');
    if (cover) { var card = cover.closest('.card'); setCover(card, !card.classList.contains('covered')); return; }
    var all = t.closest('.cover-all');
    if (all) {
      var on = all.getAttribute('aria-pressed') !== 'true';
      all.setAttribute('aria-pressed', String(on));
      all.textContent = on ? 'Uncover all' : 'Cover all';
      $$('.card', all.closest('.view')).forEach(function (c) { setCover(c, on); });
      return;
    }
    var qa = t.closest('.cover-qa');
    if (qa) {
      var cov = qa.getAttribute('aria-pressed') !== 'true';
      qa.setAttribute('aria-pressed', String(cov));
      qa.textContent = cov ? 'Show answers' : 'Cover answers';
      var view = qa.closest('.view');
      view.classList.toggle('qa-covered', cov);
      $$('table.qa td.shown', view).forEach(function (td) { td.classList.remove('shown'); });
      return;
    }
    var reset = t.closest('.reset-session');
    if (reset) {
      if (!window.confirm('Clear every tick and Done mark in the live session?')) return;
      var sv = reset.closest('.view');
      $$('input[data-task]', sv).forEach(function (cb) { setItem(TASK + cb.getAttribute('data-k'), null); });
      $$('input[data-rev]', sv).forEach(function (cb) { setReviewed(cb.getAttribute('data-rev'), false); });
      syncTasks();
      syncReviewed();
      return;
    }
    var ans = t.closest('.qa-covered table.qa td:last-child');
    if (ans) { ans.classList.toggle('shown'); return; }
    var veil = t.closest('.veil');
    if (veil) { veil.closest('.coverable').classList.add('revealed'); return; }
    var hit = t.closest('.hit');
    if (hit) {
      e.preventDefault();
      q.value = '';
      nav.classList.remove('filtering');
      $$('.nav a').forEach(function (a) { a.classList.remove('nohit'); });
      var href = hit.getAttribute('href');
      if (location.hash === href) route(); else location.hash = href;
    }
  });

  document.addEventListener('change', function (e) {
    var cb = e.target;
    if (cb.matches('input[data-task]')) {
      setItem(TASK + cb.getAttribute('data-k'), cb.checked ? '1' : '0');
      syncTasks();
      return;
    }
    if (!cb.matches('input[data-rev]')) return;
    var key = cb.getAttribute('data-rev');
    setReviewed(key, cb.checked);
    syncReviewed();
  });

  syncReviewed();
  syncTasks();
  route();
})();
