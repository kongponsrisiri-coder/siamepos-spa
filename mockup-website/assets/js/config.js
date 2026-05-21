/* Baan Siam Spa demo site — shared client config + helpers.
   Pulled in by every page before the booking widget loads, so the widget
   knows which spa-api to talk to. Local dev auto-detects localhost; ?api=
   override lets QA test against any backend.
*/
(function () {
  var params = new URLSearchParams(location.search);
  var override = params.get('api');
  var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var prod = 'https://spa-api.siamepos.co.uk';
  window.SPA_API = (override || (isLocal ? 'http://localhost:5050' : prod)).replace(/\/$/, '');
  // The booking widget reads this same value to know where to send /api/widget/*
  window.SIAMEPOS_SPA_API = window.SPA_API;
})();

// Small helper for the live-data pages.
window.spaFetch = function (path) {
  return fetch(window.SPA_API + path).then(function (res) {
    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  });
};

// Mobile burger toggle, shared by every page.
window.addEventListener('DOMContentLoaded', function () {
  var burger = document.querySelector('.burger');
  var nav = document.querySelector('.site-nav');
  if (burger && nav) {
    burger.addEventListener('click', function () { nav.classList.toggle('open'); });
    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') nav.classList.remove('open');
    });
  }
});
