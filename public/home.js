const githubTokenInput = document.getElementById('homeGithubToken');
const linearTokenInput = document.getElementById('homeLinearToken');
const profileBadge = document.getElementById('profileBadge');
const linearCheck = document.getElementById('linearCheck');

tokenStore.bind(githubTokenInput, 'github');
tokenStore.bind(linearTokenInput, 'linear');
tokenStore.bindClearButton(document.getElementById('clearGithubToken'), 'github');
tokenStore.bindClearButton(document.getElementById('clearLinearToken'), 'linear');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function checkGithub() {
  const token = githubTokenInput.value;
  if (!token) {
    profileBadge.style.display = 'none';
    return;
  }
  fetch('/api/github/whoami', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
    .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
    .then(({ ok, body }) => {
      if (token !== githubTokenInput.value) return; // stale response, field changed since
      if (ok) {
        profileBadge.innerHTML = `Signed in as <strong>${escapeHtml(body.name)}</strong>`;
        profileBadge.style.display = 'flex';
      } else {
        profileBadge.style.display = 'none';
      }
    })
    .catch(() => {
      profileBadge.style.display = 'none';
    });
}

function checkLinear() {
  const token = linearTokenInput.value;
  if (!token) {
    linearCheck.style.display = 'none';
    return;
  }
  fetch('/api/linear/whoami', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
    .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
    .then(({ ok, body }) => {
      if (token !== linearTokenInput.value) return; // stale response, field changed since
      if (ok) {
        linearCheck.title = `Signed in as ${body.name}`;
        linearCheck.style.display = 'inline';
      } else {
        linearCheck.style.display = 'none';
      }
    })
    .catch(() => {
      linearCheck.style.display = 'none';
    });
}

let githubDebounce, linearDebounce;

githubTokenInput.addEventListener('input', () => {
  profileBadge.style.display = 'none';
  clearTimeout(githubDebounce);
  githubDebounce = setTimeout(checkGithub, 600);
});
githubTokenInput.addEventListener('blur', checkGithub);

linearTokenInput.addEventListener('input', () => {
  linearCheck.style.display = 'none';
  clearTimeout(linearDebounce);
  linearDebounce = setTimeout(checkLinear, 600);
});
linearTokenInput.addEventListener('blur', checkLinear);

// Tokens may already be saved from a previous page/tab session — validate
// right away instead of waiting for the user to touch the fields.
if (githubTokenInput.value) checkGithub();
if (linearTokenInput.value) checkLinear();
