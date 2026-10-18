(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // Reviewed marks. Storage can throw (file:// policy, private mode, quota);
  // the in-memory map keeps the page working for this session either way.
  var PREFIX = 'eksstudy.reviewed.';
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

  function isReviewed(key) {
    if (Object.prototype.hasOwnProperty.call(mem, key)) return mem[key];
    try { return !!store && store.getItem(PREFIX + key) === '1'; } catch (e) { return false; }
  }
  function setReviewed(key, on) {
    mem[key] = on;
    if (!store) return;
    try {
      if (on) store.setItem(PREFIX + key, '1'); else store.removeItem(PREFIX + key);
    } catch (e) { storeFailed(); }
  }

  function syncReviewed() {
    $$('input[data-rev]').forEach(function (cb) { cb.checked = isReviewed(cb.getAttribute('data-rev')); });
    $$('.nav a[data-key]').forEach(function (a) { a.classList.toggle('done', isReviewed(a.getAttribute('data-key'))); });
    $$('.nav .count').forEach(function (c) {
      var view = c.getAttribute('data-count');
      var keys = view === 'spine' ? ['spine'] : $$('.nav a[href^="#' + view + '/"]').map(function (a) { return a.getAttribute('data-key'); });
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
    $$('.nav a.top').forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-view') === view); });
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

  document.addEventListener('click', function (e) {
    var t = e.target;
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
    if (!cb.matches('input[data-rev]')) return;
    var key = cb.getAttribute('data-rev');
    setReviewed(key, cb.checked);
    syncReviewed();
  });

  syncReviewed();
  route();
})();
