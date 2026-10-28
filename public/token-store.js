// Keeps tokens (GitHub, Linear) in sessionStorage so they don't need retyping
// when moving between tool pages. sessionStorage is cleared automatically
// when the tab/window closes (unlike localStorage) — this is a convenience
// against retyping, not a defense against a compromised browser or XSS on
// this origin.
(function () {
  const KEYS = {
    github: 'cp-app-github-token',
    linear: 'cp-app-linear-token',
  };

  function keyFor(tokenName) {
    return KEYS[tokenName] || KEYS.github;
  }

  function hasSaved(tokenName) {
    if (tokenName) return sessionStorage.getItem(keyFor(tokenName)) !== null;
    return Object.values(KEYS).some((k) => sessionStorage.getItem(k) !== null);
  }

  // Only show "Clear saved token" once there's actually something to clear —
  // otherwise it reads as if a token is already stored when none is. Each
  // button is scoped to whichever token it's attached to (via bindClearButton's
  // tokenName), so on pages with two token fields (e.g. Release's GitHub +
  // Linear), saving one doesn't make the OTHER field's clear link appear.
  function refreshClearButtons() {
    document.querySelectorAll('.clear-token').forEach((btn) => {
      btn.style.display = hasSaved(btn.dataset.tokenName) ? '' : 'none';
    });
  }

  function restore(input, tokenName = 'github') {
    if (!input) return;
    const saved = sessionStorage.getItem(keyFor(tokenName));
    if (saved && !input.value) input.value = saved;
    refreshClearButtons();
  }

  function bind(input, tokenName = 'github') {
    if (!input) return;
    input.dataset.tokenName = tokenName;
    restore(input, tokenName);
    input.addEventListener('input', () => {
      if (input.value) sessionStorage.setItem(keyFor(tokenName), input.value);
      else sessionStorage.removeItem(keyFor(tokenName));
      refreshClearButtons();
    });
  }

  // Clears one token kind (and blanks only the field(s) bound to it) when
  // tokenName is given; wipes every known kind otherwise.
  function clearToken(tokenName) {
    const keys = tokenName ? [keyFor(tokenName)] : Object.values(KEYS);
    keys.forEach((k) => sessionStorage.removeItem(k));
    document.querySelectorAll('input[data-token-field]').forEach((el) => {
      if (!tokenName || el.dataset.tokenName === tokenName) el.value = '';
    });
    refreshClearButtons();
  }

  function bindClearButton(button, tokenName) {
    if (!button) return;
    if (tokenName) button.dataset.tokenName = tokenName;
    button.addEventListener('click', (e) => {
      e.preventDefault();
      clearToken(tokenName);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refreshClearButtons);
  } else {
    refreshClearButtons();
  }

  window.tokenStore = { bind, restore, clearToken, bindClearButton, hasSaved };
})();
