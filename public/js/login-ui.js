(function() {
  'use strict';
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('suspended') === '1') {
    const banner = document.getElementById('suspended-banner');
    if (banner) banner.style.display = 'block';
  }
})();
