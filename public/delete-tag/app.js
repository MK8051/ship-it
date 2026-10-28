const lookupForm = document.getElementById('lookupForm');
const lookupBtn = document.getElementById('lookupBtn');
const confirmForm = document.getElementById('confirmForm');
const confirmTagInput = document.getElementById('confirmTag');
const deleteBtn = document.getElementById('deleteBtn');
const resultEl = document.getElementById('result');

let pending = null; // { repo, tag, token }

tokenStore.bind(lookupForm.token, 'github');
tokenStore.bindClearButton(document.getElementById('clearToken'), 'github');

const repoInput = document.getElementById('repo');
const tagInput = document.getElementById('tag');
const tokenInput = document.getElementById('token');

combobox.attach(repoInput, { getOptions: () => githubSearch.getRepoOptions(tokenInput.value) });
combobox.attach(tagInput, {
  liveSearch: (query) => {
    const repo = repoInput.value.trim();
    if (!repo) return Promise.resolve([]);
    return githubSearch.searchRefs(repo, query, tokenInput.value).then(({ tags }) => tags);
  },
});

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    if (cfg.defaultRepo && cfg.defaultRepo.includes('/') && !lookupForm.repo.value) lookupForm.repo.value = cfg.defaultRepo;
  })
  .catch(() => {});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showResult(html, kind) {
  resultEl.innerHTML = `<div class="banner ${kind}">${html}</div>`;
  resultEl.style.display = 'block';
}

function resetConfirmStep() {
  pending = null;
  confirmForm.style.display = 'none';
  confirmTagInput.value = '';
  deleteBtn.disabled = true;
}

confirmTagInput.addEventListener('input', () => {
  deleteBtn.disabled = !pending || confirmTagInput.value !== pending.tag;
});

lookupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  lookupBtn.disabled = true;
  resultEl.style.display = 'none';
  resetConfirmStep();

  const repo = lookupForm.repo.value.trim();
  const tag = lookupForm.tag.value.trim();
  const token = lookupForm.token.value;

  try {
    const res = await fetch('/api/tag-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, tag, token }),
    });
    const body = await res.json();
    if (!res.ok) {
      showResult(escapeHtml(body.error || 'Lookup failed'), 'error');
      return;
    }
    pending = { repo, tag, token };
    showResult(
      `Found <strong>${escapeHtml(tag)}</strong> on ${escapeHtml(repo)} — points to <code>${escapeHtml(body.sha.slice(0, 12))}</code> (${escapeHtml(body.type)}).` +
        ` Type the tag name below and confirm to delete it from the remote.`,
      'warn'
    );
    confirmForm.style.display = 'grid';
  } catch (err) {
    showResult('Could not reach the server: ' + escapeHtml(err.message), 'error');
  } finally {
    lookupBtn.disabled = false;
  }
});

confirmForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pending) return;
  deleteBtn.disabled = true;

  try {
    const res = await fetch('/api/delete-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...pending, confirmTag: confirmTagInput.value }),
    });
    const body = await res.json();
    if (!res.ok) {
      showResult(escapeHtml(body.error || 'Delete failed'), 'error');
      deleteBtn.disabled = confirmTagInput.value !== pending.tag;
      return;
    }
    showResult(`Tag <strong>${escapeHtml(pending.tag)}</strong> was deleted from ${escapeHtml(pending.repo)}.`, 'success');
    resetConfirmStep();
    lookupForm.reset();
    tokenStore.restore(lookupForm.token); // reset() wipes the field; restore it from sessionStorage
  } catch (err) {
    showResult('Could not reach the server: ' + escapeHtml(err.message), 'error');
    deleteBtn.disabled = false;
  }
});
