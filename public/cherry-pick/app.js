const form = document.getElementById('form');
const submitBtn = document.getElementById('submitBtn');
const logEl = document.getElementById('log');
const logWrap = document.getElementById('logWrap');
const resultEl = document.getElementById('result');

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    if (cfg.defaultRepo && cfg.defaultRepo.includes('/') && !form.repo.value) form.repo.value = cfg.defaultRepo;
  })
  .catch(() => {});

tokenStore.bind(form.token, 'github');
tokenStore.bindClearButton(document.getElementById('clearToken'), 'github');

const repoInput = document.getElementById('repo');
const baseInput = document.getElementById('base');
const prsInput = document.getElementById('prs');
const tokenInput = document.getElementById('token');

combobox.attach(repoInput, { getOptions: () => githubSearch.getRepoOptions(tokenInput.value) });
combobox.attach(baseInput, {
  liveSearch: (query) => {
    const repo = repoInput.value.trim();
    if (!repo) return Promise.resolve([]);
    return githubSearch.searchRefs(repo, query, tokenInput.value).then(({ branches, tags }) => [...branches, ...tags]);
  },
});
combobox.attach(prsInput, {
  multi: true,
  getOptions: () => {
    const repo = repoInput.value.trim();
    if (!repo) return Promise.resolve([]);
    return githubSearch.getPullsForRepo(repo, tokenInput.value).then((list) => list.map((p) => ({ value: String(p.number), label: `#${p.number} (${p.state}) ${p.title}` })));
  },
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function appendLog(line) {
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function showResult(html, kind) {
  resultEl.innerHTML = `<div class="banner ${kind}">${html}</div>`;
  resultEl.style.display = 'block';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  submitBtn.disabled = true;
  resultEl.style.display = 'none';
  resultEl.innerHTML = '';
  logEl.textContent = '';
  logWrap.style.display = 'block';

  const payload = {
    repo: form.repo.value.trim(),
    base: form.base.value.trim(),
    tag: form.tag.value.trim(),
    prs: form.prs.value.trim(),
    token: form.token.value,
  };

  let runId;
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) {
      showResult(escapeHtml(body.error || 'Request failed'), 'error');
      submitBtn.disabled = false;
      return;
    }
    runId = body.runId;
  } catch (err) {
    showResult('Could not reach the server: ' + escapeHtml(err.message), 'error');
    submitBtn.disabled = false;
    return;
  }

  const source = new EventSource(`/api/runs/${runId}/events`);

  source.addEventListener('log', (ev) => {
    const { line } = JSON.parse(ev.data);
    appendLog(line);
  });

  source.addEventListener('result', (ev) => {
    const data = JSON.parse(ev.data);
    if (data.status === 'success') {
      showResult(
        `Tag <strong>${escapeHtml(form.tag.value.trim())}</strong> created and pushed.` +
          `<br><a class="dl" href="${data.tagUrl}" target="_blank" rel="noopener">View on GitHub →</a>`,
        'success'
      );
    } else if (data.status === 'conflict') {
      showResult(
        `This cherry-pick has a conflict — it needs manual resolution. Please resolve it locally.`,
        'conflict'
      );
    } else {
      showResult(escapeHtml(data.message || 'The run failed.'), 'error');
    }
    submitBtn.disabled = false;
    source.close();
  });

  source.onerror = () => {
    // Server closes the stream itself on completion; treat any other drop as terminal.
    if (submitBtn.disabled) {
      appendLog('[connection closed]');
      submitBtn.disabled = false;
    }
    source.close();
  };
});
