/* House Lights — starts the app.
 *
 * This stays a plain script (not a module) on purpose: an iPhone can keep an
 * older copy of the page, and any copy of the page loads "app.js". A plain
 * script works for all of them: it swaps an out-of-date page for the
 * current one, then loads the app (main.js). If that fails, it shows a way to
 * reload instead of a blank screen.
 */
(function () {
  var version = '2026.11.24-11';

  // The page says which version it belongs to. If it's an older copy, fetch
  // the current page once (the ?fresh= also skips any cached copy).
  var meta = document.querySelector('meta[name="app-version"]');
  var fresh = 'fresh=' + version;
  if ((!meta || meta.content !== version) && location.search.indexOf(fresh) === -1) {
    location.replace(location.pathname + '?' + fresh + location.hash);
    return;
  }
  if (location.search.indexOf('fresh=') !== -1) {
    history.replaceState(null, '', location.pathname + location.hash);
  }

  import('./main.js?v=' + version).catch(function (err) {
    console.error('House Lights could not start', err);
    var box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'padding:48px 24px;font:17px -apple-system,system-ui,sans-serif;color:#eef0f4;background:#111318;min-height:100vh;box-sizing:border-box';
    var title = document.createElement('h1');
    title.textContent = 'House Lights didn’t load';
    title.style.cssText = 'font-size:22px;margin:0 0 12px';
    var text = document.createElement('p');
    text.textContent = 'Check your connection, then try again.';
    text.style.cssText = 'color:#9aa1ad;margin:0 0 20px';
    var btn = document.createElement('button');
    btn.textContent = 'Reload';
    btn.style.cssText = 'font:inherit;font-weight:600;padding:12px 28px;border-radius:12px;border:0;background:#ffb547;color:#1a1205';
    btn.addEventListener('click', function () { location.reload(); });
    box.append(title, text, btn);
    document.body.replaceChildren(box);
  });
})();
