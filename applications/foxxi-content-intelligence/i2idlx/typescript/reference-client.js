
(function () {
  function flash(btn, text) {
    var old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = old; }, 1600);
  }
  function fallback(btn, text) {
    var box = btn.parentNode.querySelector('.copy-fallback');
    if (!box) {
      box = document.createElement('input');
      box.className = 'copy-fallback';
      box.readOnly = true;
      btn.insertAdjacentElement('afterend', box);
    }
    box.value = text;
    box.focus();
    box.select();
    flash(btn, 'Selected');
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy], [data-copy-from]');
    if (!btn) return;
    var src = btn.dataset.copyFrom ? document.getElementById(btn.dataset.copyFrom) : null;
    var text = src ? src.textContent : btn.dataset.copy;
    try {
      navigator.clipboard.writeText(text).then(function () { flash(btn, 'Copied'); }, function () {
        if (src) { var r = document.createRange(); r.selectNodeContents(src); var s = getSelection(); s.removeAllRanges(); s.addRange(r); flash(btn, 'Selected'); }
        else fallback(btn, text);
      });
    } catch (err) { fallback(btn, text); }
  });

  // Stored queries: rebind parameters, update the shown query and its live link.
  document.querySelectorAll('.query').forEach(function (card) {
    var src = card.querySelector('.q-src');
    if (!src) return;
    var template = JSON.parse(src.textContent);
    var code = card.querySelector('pre code');
    var run = card.querySelector('a.run');
    var inputs = card.querySelectorAll('input[data-param]');
    function bind() {
      var q = template;
      inputs.forEach(function (inp) {
        var re = new RegExp('\\$' + inp.dataset.param + '\\b', 'g');
        q = q.replace(re, function () { return inp.value; });
      });
      code.textContent = q.replace(/\s+$/, '');
      if (run) run.href = '__ENDPOINT__?query=' + encodeURIComponent(q);
    }
    inputs.forEach(function (inp) { inp.addEventListener('input', bind); });
  });

  // Row filters.
  function wire(opts) {
    var box = document.getElementById(opts.search);
    var sel = opts.select ? document.getElementById(opts.select) : null;
    var rows = Array.prototype.slice.call(document.querySelectorAll(opts.rows));
    var count = document.getElementById(opts.count);
    function apply() {
      var q = (box.value || '').trim().toLowerCase();
      var v = sel ? sel.value : '';
      var shown = 0;
      rows.forEach(function (r) {
        var ok = (!q || r.dataset.search.indexOf(q) !== -1) && (!v || r.getAttribute(opts.attr) === v);
        r.hidden = !ok;
        if (ok) shown++;
      });
      if (opts.after) opts.after();
      count.textContent = shown === rows.length ? rows.length + ' shown' : shown + ' of ' + rows.length + ' shown';
    }
    box.addEventListener('input', apply);
    if (sel) sel.addEventListener('change', apply);
    apply();
  }
  wire({ search: 'enact-q', select: 'enact-role', attr: 'data-role', rows: '#enact-table tbody tr', count: 'enact-count' });
  wire({ search: 'map-q', select: 'map-vocab', attr: 'data-vocab', rows: '#map-table tbody tr', count: 'map-count' });
  wire({ search: 'vocab-q', rows: '.term', count: 'vocab-count', after: function () {
    document.querySelectorAll('.vocab-section').forEach(function (sec) {
      sec.hidden = !sec.querySelector('.term:not([hidden])') && !!document.getElementById('vocab-q').value.trim();
    });
  } });

  // Package download: the package's files are published next to this page as text; on request they are
  // zipped in the browser (JSZip, loaded only then) and offered through the downloads capability.
  var btn = document.getElementById('save-package');
  var note = document.getElementById('save-note');
  var files = JSON.parse(document.getElementById('pkg-manifest').textContent);
  function loadZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '__JSZIP__';
      s.onload = function () { window.JSZip ? resolve(window.JSZip) : reject({ code: 'zip' }); };
      s.onerror = function () { reject({ code: 'zip' }); };
      document.head.appendChild(s);
    });
  }
  var ready = (window.claude && typeof window.claude.use === 'function') ? window.claude.use('downloads') : Promise.resolve({
    save: function (file) {
      var url = URL.createObjectURL(file.data);
      var link = document.createElement('a');
      link.href = url; link.download = file.filename; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      return Promise.resolve();
    }
  });
  ready.then(function (dl) {
    if (!dl) { btn.hidden = true; note.textContent = 'Saving the package isn’t available in this view. Every graph is linked below.'; return; }
    btn.addEventListener('click', function () {
      btn.disabled = true;
      var done = 0;
      note.textContent = 'Collecting files…';
      loadZip().then(function (JSZip) {
        var zip = new JSZip();
        var queue = files.slice();
        function next() {
          var path = queue.shift();
          if (!path) return Promise.resolve();
          return fetch(path).then(function (r) {
            if (!r.ok) throw { code: 'fetch' };
            return r.arrayBuffer();
          }).then(function (buf) {
            zip.file(path.replace(/^\/i2idlx\//, ''), buf);
            done++;
            note.textContent = 'Collecting files… ' + done + ' of ' + files.length;
            return next();
          });
        }
        var lanes = [];
        for (var i = 0; i < 6; i++) lanes.push(next());
        return Promise.all(lanes).then(function () {
          note.textContent = 'Zipping…';
          return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        });
      }).then(function (blob) {
        return dl.save({ filename: '__PACKAGE__', data: blob });
      }).then(function () {
        note.textContent = 'Package saved.';
      }, function (err) {
        var c = err && err.code;
        note.textContent = c === 'declined' ? 'Not saved.' : c === 'rate_limited' ? 'A save prompt is already open.'
          : c === 'fetch' ? 'A package file could not be loaded. Try again.'
          : c === 'zip' ? 'The zip tool did not load. Try again in a moment.' : 'Saving isn’t available here.';
      }).then(function () { btn.disabled = false; });
    });
  }, function () { btn.hidden = true; });
})();