const resolveForm = document.getElementById('resolveForm');
const resolveBtn = document.getElementById('resolveBtn');
const taskInput = document.getElementById('taskInput');
const linearTokenInput = document.getElementById('linearToken');
const linearSourceFields = document.getElementById('linearSourceFields');
const resolveResult = document.getElementById('resolveResult');

const configStep = document.getElementById('configStep');
const repoListEl = document.getElementById('repoList');
const configForm = document.getElementById('configForm');

const tagFields = document.getElementById('tagFields');
const branchStartFields = document.getElementById('branchStartFields');
const updateStartFields = document.getElementById('updateStartFields');
const prSharedFields = document.getElementById('prSharedFields');

const cpBaseTagInput = document.getElementById('cpBaseTag');
const newTagNameInput = document.getElementById('newTagName');
const cpBaseBranchInput = document.getElementById('cpBaseBranch');
const newBranchNameInput = document.getElementById('newBranchName');
const existingBranchNameInput = document.getElementById('existingBranchName');
const prTargetBranchInput = document.getElementById('prTargetBranch');
const prTitleInput = document.getElementById('prTitle');
const prBodyInput = document.getElementById('prBody');
const githubTokenInput = document.getElementById('githubToken');
const runBtn = document.getElementById('runBtn');

const runStep = document.getElementById('runStep');
const repoRunsEl = document.getElementById('repoRuns');

let resolvedRepos = []; // [{ repo, prs, include }]

tokenStore.bind(linearTokenInput, 'linear');
tokenStore.bind(githubTokenInput, 'github');
tokenStore.bindClearButton(document.getElementById('clearLinearToken'), 'linear');
tokenStore.bindClearButton(document.getElementById('clearGithubToken'), 'github');

// --- GitHub data for the search/autocomplete fields (org is fixed server-side) ---
function getRepoOptions() {
  return githubSearch.getRepoOptions(githubTokenInput.value);
}
function getCommitsForRepo(repo) {
  return githubSearch.getCommitsForRepo(repo, githubTokenInput.value);
}
function getPullsForRepo(repo) {
  return githubSearch.getPullsForRepo(repo, githubTokenInput.value);
}

function getReferenceRepo() {
  const r = resolvedRepos.find((x) => x.include && x.repo && REPO_NAME_RE.test(x.repo));
  return r ? r.repo : null;
}

function searchRefsForReference(includeTags) {
  return (query) => {
    const repo = getReferenceRepo();
    if (!repo || !githubTokenInput.value) return Promise.resolve([]);
    return githubSearch.searchRefs(repo, query, githubTokenInput.value).then(({ branches, tags }) => (includeTags ? [...branches, ...tags] : branches));
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function showBanner(container, html, kind) {
  container.innerHTML = `<div class="banner ${kind}">${html}</div>`;
}
function parseTasks(raw) {
  return [...new Set(raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}
function parsePrNumbers(raw) {
  return [
    ...new Set(
      raw.split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0)
    ),
  ];
}
const COMMIT_SHA_RE = /^[0-9a-fA-F]{7,40}$/;
function parseCommitShas(raw) {
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean).filter((s) => COMMIT_SHA_RE.test(s)))];
}
const REPO_NAME_RE = /^[\w.-]+\/[\w.-]+$/;
const REF_NAME_RE = /^[A-Za-z0-9._/-]+$/;

// --- Step 1: source ---
function currentSourceMode() {
  return document.querySelector('input[name="sourceMode"]:checked').value;
}
document.querySelectorAll('input[name="sourceMode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    linearSourceFields.style.display = currentSourceMode() === 'linear' ? 'grid' : 'none';
  });
});

resolveForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  resolveBtn.disabled = true;
  resolveResult.innerHTML = '';
  configStep.style.display = 'none';
  runStep.style.display = 'none';

  if (currentSourceMode() === 'direct') {
    resolvedRepos = [];
    renderRepoList();
    configStep.style.display = 'block';
    resolveBtn.disabled = false;
    return;
  }

  const tasks = parseTasks(taskInput.value);
  if (tasks.length === 0) {
    showBanner(resolveResult, 'Enter at least one Linear task ID, or switch to direct entry above.', 'error');
    resolveBtn.disabled = false;
    return;
  }
  const linearToken = linearTokenInput.value;
  if (!linearToken) {
    showBanner(resolveResult, 'A Linear API key is required to resolve task IDs.', 'error');
    resolveBtn.disabled = false;
    return;
  }

  try {
    const res = await fetch('/api/linear/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linearToken, tasks }),
    });
    const body = await res.json();
    if (!res.ok) {
      showBanner(resolveResult, escapeHtml(body.error || 'Resolve failed'), 'error');
      return;
    }
    renderTaskSummary(body.tasks);
    resolvedRepos = (body.repos || []).map((r) => ({ ...r, commits: [], base: '', include: true }));
    renderRepoList();
    configStep.style.display = 'block';
  } catch (err) {
    showBanner(resolveResult, 'Could not reach the server: ' + escapeHtml(err.message), 'error');
  } finally {
    resolveBtn.disabled = false;
  }
});

function renderTaskSummary(tasks) {
  const lines = tasks.map((t) => {
    if (!t.found) return `<div>❌ <strong>${escapeHtml(t.identifier)}</strong> — ${t.error ? escapeHtml(t.error) : 'not found'}</div>`;
    if (t.prs.length === 0) {
      const raw = t.rawAttachments.length ? ` (${t.rawAttachments.length} non-PR attachment${t.rawAttachments.length > 1 ? 's' : ''} found)` : '';
      return `<div>⚠️ <strong>${escapeHtml(t.identifier)}</strong> — ${escapeHtml(t.title)} — no linked GitHub PRs${raw}</div>`;
    }
    return `<div>✅ <strong>${escapeHtml(t.identifier)}</strong> — ${escapeHtml(t.title)} — ${t.prs.length} PR${t.prs.length > 1 ? 's' : ''}</div>`;
  });
  resolveResult.innerHTML = lines.join('');
}

// --- Step 2: repo/PR review ---
function searchRefsForRow(idx, includeTags) {
  return (query) => {
    const repo = resolvedRepos[idx] && resolvedRepos[idx].repo;
    if (!repo || !REPO_NAME_RE.test(repo) || !githubTokenInput.value) return Promise.resolve([]);
    return githubSearch.searchRefs(repo, query, githubTokenInput.value).then(({ branches, tags }) => (includeTags ? [...branches, ...tags] : branches));
  };
}

function renderRepoList() {
  repoListEl.innerHTML = '';
  resolvedRepos.forEach((r, idx) => {
    const li = document.createElement('li');

    // A plain div, not a <label> — wrapping both the checkbox and the repo
    // name field in one <label> means clicking into the text field to edit
    // it also implicitly toggles the checkbox (the browser forwards label
    // clicks to the first labelable descendant), silently excluding the repo.
    const row = document.createElement('div');
    row.className = 'repo-head';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = r.include;
    cb.addEventListener('change', () => { resolvedRepos[idx].include = cb.checked; });
    const repoNameField = document.createElement('input');
    repoNameField.value = r.repo;
    repoNameField.placeholder = 'search ZuperHQ repos...';
    repoNameField.style.fontWeight = '600';
    repoNameField.addEventListener('input', () => { resolvedRepos[idx].repo = repoNameField.value.trim(); });
    row.appendChild(cb);
    row.appendChild(repoNameField);
    li.appendChild(row);
    combobox.attach(repoNameField, { getOptions: getRepoOptions });

    const prRow = document.createElement('div');
    const prLabel = document.createElement('label');
    prLabel.textContent = 'PR numbers';
    prLabel.style.fontWeight = '400';
    prLabel.style.fontSize = '0.78rem';
    prLabel.style.marginTop = '0.4rem';
    const prInput = document.createElement('input');
    prInput.value = r.prs.join(', ');
    prInput.placeholder = 'search PRs, or type numbers...';
    prInput.addEventListener('input', () => { resolvedRepos[idx].prs = parsePrNumbers(prInput.value); });
    prRow.appendChild(prLabel);
    prRow.appendChild(prInput);
    li.appendChild(prRow);
    combobox.attach(prInput, {
      multi: true,
      getOptions: () => {
        const repo = resolvedRepos[idx].repo;
        if (!repo || !REPO_NAME_RE.test(repo)) return Promise.resolve([]);
        return getPullsForRepo(repo).then((list) => list.map((p) => ({ value: String(p.number), label: `#${p.number} (${p.state}) ${p.title}` })));
      },
    });

    const commitRow = document.createElement('div');
    const commitLabel = document.createElement('label');
    commitLabel.textContent = 'Commit SHAs (optional — for commits with no PR)';
    commitLabel.style.fontWeight = '400';
    commitLabel.style.fontSize = '0.78rem';
    commitLabel.style.marginTop = '0.4rem';
    const commitInput = document.createElement('input');
    commitInput.value = (r.commits || []).join(', ');
    commitInput.placeholder = 'search recent commits, or paste a SHA...';
    commitInput.addEventListener('input', () => { resolvedRepos[idx].commits = parseCommitShas(commitInput.value); });
    commitRow.appendChild(commitLabel);
    commitRow.appendChild(commitInput);
    combobox.attach(commitInput, {
      multi: true,
      getOptions: () => {
        const repo = resolvedRepos[idx].repo;
        if (!repo || !REPO_NAME_RE.test(repo)) return Promise.resolve([]);
        return getCommitsForRepo(repo).then((list) => list.map((c) => ({ value: c.sha, label: `${c.sha.slice(0, 10)}  ${c.message}` })));
      },
    });
    li.appendChild(commitRow);

    const baseRow = document.createElement('div');
    baseRow.className = 'repo-base-row';
    baseRow.style.display = currentTargetMode() === 'update' ? 'none' : 'block';
    const baseLabel = document.createElement('label');
    baseLabel.textContent = 'Cherry-pick from (override)';
    baseLabel.style.fontWeight = '400';
    baseLabel.style.fontSize = '0.78rem';
    baseLabel.style.marginTop = '0.4rem';
    const baseInput = document.createElement('input');
    baseInput.value = r.base || '';
    baseInput.placeholder = 'leave blank to use the shared value above';
    baseInput.addEventListener('input', () => { resolvedRepos[idx].base = baseInput.value.trim(); });
    baseRow.appendChild(baseLabel);
    baseRow.appendChild(baseInput);
    li.appendChild(baseRow);
    combobox.attach(baseInput, { liveSearch: searchRefsForRow(idx, true) });

    repoListEl.appendChild(li);
  });
}

document.getElementById('addRepoBtn').addEventListener('click', () => {
  resolvedRepos.push({ repo: '', prs: [], commits: [], base: '', include: true });
  renderRepoList();
});

// --- Step 3: target mode ---
function currentTargetMode() {
  return document.querySelector('input[name="targetMode"]:checked').value;
}
function updateTargetVisibility() {
  const mode = currentTargetMode();
  tagFields.style.display = mode === 'tag' ? 'grid' : 'none';
  branchStartFields.style.display = mode === 'branch' ? 'grid' : 'none';
  updateStartFields.style.display = mode === 'update' ? 'grid' : 'none';
  prSharedFields.style.display = mode === 'branch' || mode === 'update' ? 'grid' : 'none';
  runBtn.textContent = mode === 'tag' ? 'Cherry-pick & tag' : mode === 'branch' ? 'Cherry-pick & open PRs' : 'Cherry-pick & update branch';
  // "Update an existing branch" has no "cherry-pick from" concept at all (it
  // picks onto the branch's own current tip), so the per-repo override is
  // only meaningful for the other two modes.
  document.querySelectorAll('.repo-base-row').forEach((el) => {
    el.style.display = mode === 'update' ? 'none' : 'block';
  });
}
document.querySelectorAll('input[name="targetMode"]').forEach((radio) => radio.addEventListener('change', updateTargetVisibility));

// Suggestions here come from the first included repo with a valid name —
// a convenience, not a hard constraint, since a run can span multiple repos.
combobox.attach(cpBaseTagInput, { liveSearch: searchRefsForReference(true) });
combobox.attach(cpBaseBranchInput, { liveSearch: searchRefsForReference(true) });
combobox.attach(prTargetBranchInput, { liveSearch: searchRefsForReference(false) });
combobox.attach(existingBranchNameInput, { liveSearch: searchRefsForReference(false) });

// --- Step 4: build the run plan ---
function buildPlan() {
  const included = resolvedRepos.filter((r) => r.include);
  if (included.length === 0) return { error: 'Select at least one repo.' };

  const mode = currentTargetMode();
  const common = {};

  if (mode === 'tag') {
    common.base = cpBaseTagInput.value.trim();
    common.tag = newTagNameInput.value.trim();
    if (!common.base || !REF_NAME_RE.test(common.base)) return { error: 'Invalid "Cherry-pick from" value.' };
    if (!common.tag || !REF_NAME_RE.test(common.tag)) return { error: 'Invalid new tag name.' };
  } else if (mode === 'branch') {
    common.base = cpBaseBranchInput.value.trim();
    common.branch = newBranchNameInput.value.trim();
    common.prBase = prTargetBranchInput.value.trim();
    common.prTitle = prTitleInput.value.trim();
    common.prBody = prBodyInput.value.trim();
    if (!common.base || !REF_NAME_RE.test(common.base)) return { error: 'Invalid "Cherry-pick from" value.' };
    if (!common.branch || !REF_NAME_RE.test(common.branch)) return { error: 'Invalid new branch name.' };
    if (!common.prBase || !REF_NAME_RE.test(common.prBase)) return { error: 'Invalid "Open PR against" branch.' };
    if (!common.prTitle) return { error: 'A PR title is required.' };
  } else {
    common.updateBranch = existingBranchNameInput.value.trim();
    common.prBase = prTargetBranchInput.value.trim();
    common.prTitle = prTitleInput.value.trim();
    common.prBody = prBodyInput.value.trim();
    if (!common.updateBranch || !REF_NAME_RE.test(common.updateBranch)) return { error: 'Invalid existing branch name.' };
    if (!common.prBase || !REF_NAME_RE.test(common.prBase)) return { error: 'Invalid "Open PR against" branch.' };
    if (!common.prTitle) return { error: 'A PR title is required (used only if this branch has no open PR yet).' };
  }

  const plan = [];
  for (const r of included) {
    if (!r.repo || !REPO_NAME_RE.test(r.repo)) return { error: `"${r.repo || '(empty)'}" isn't a valid repo (expected owner/name).` };
    const hasPrs = r.prs && r.prs.length > 0;
    const hasCommits = r.commits && r.commits.length > 0;
    if (!hasPrs && !hasCommits) return { error: `No PR numbers or commit SHAs for ${r.repo}.` };

    // Each repo can override "cherry-pick from" — different repos in the
    // same release often diverge on tag/branch naming — falling back to the
    // shared value above when left blank.
    let base = common.base;
    if (mode !== 'update' && r.base) {
      base = r.base;
      if (!REF_NAME_RE.test(base)) return { error: `Invalid "Cherry-pick from" override for ${r.repo}.` };
    }

    plan.push({
      repo: r.repo,
      ...(hasPrs ? { prs: r.prs.join(',') } : {}),
      ...(hasCommits ? { commits: r.commits.join(',') } : {}),
      ...common,
      ...(mode !== 'update' ? { base } : {}),
    });
  }
  return { plan };
}

// --- run ---
function runOne(payload, onLog) {
  return new Promise((resolve) => {
    fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then((res) => res.json().then((body) => ({ res, body })))
      .then(({ res, body }) => {
        if (!res.ok) {
          resolve({ status: 'error', message: body.error || 'Request failed' });
          return;
        }
        const source = new EventSource(`/api/runs/${body.runId}/events`);
        source.addEventListener('log', (ev) => onLog(JSON.parse(ev.data).line));
        source.addEventListener('result', (ev) => {
          resolve(JSON.parse(ev.data));
          source.close();
        });
        source.onerror = () => {
          resolve({ status: 'error', message: 'connection lost' });
          source.close();
        };
      })
      .catch((err) => resolve({ status: 'error', message: err.message }));
  });
}

function renderRunRows(plan) {
  repoRunsEl.innerHTML = '';
  const rows = new Map();
  plan.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'run-row';
    const head = document.createElement('div');
    head.className = 'run-row-head';
    const title = document.createElement('strong');
    title.textContent = p.repo;
    const status = document.createElement('span');
    status.className = 'run-status';
    status.textContent = 'pending';
    head.appendChild(title);
    head.appendChild(status);
    const log = document.createElement('pre');
    log.className = 'run-log';
    const extra = document.createElement('div');
    row.appendChild(head);
    row.appendChild(log);
    row.appendChild(extra);
    repoRunsEl.appendChild(row);
    rows.set(p.repo, { status, log, extra });
  });
  return rows;
}

async function runAll(plan, token, rows) {
  for (const p of plan) {
    const { status, log, extra } = rows.get(p.repo);
    status.textContent = 'running';
    status.className = 'run-status running';

    const result = await runOne({ ...p, token }, (line) => {
      log.textContent += line + '\n';
      log.scrollTop = log.scrollHeight;
    });

    if (result.status === 'success' && result.tagUrl) {
      status.textContent = 'tagged';
      status.className = 'run-status success';
      window.open(result.tagUrl, '_blank');
      extra.innerHTML = `<a class="dl" href="${result.tagUrl}" target="_blank" rel="noopener">View tag →</a>`;
    } else if (result.status === 'success' && result.prUrl) {
      status.textContent = 'PR ready';
      status.className = 'run-status success';
      window.open(result.prUrl, '_blank');
      extra.innerHTML = `<a class="dl" href="${result.prUrl}" target="_blank" rel="noopener">Open PR →</a>`;
    } else if (result.status === 'conflict') {
      status.textContent = 'conflict';
      status.className = 'run-status conflict';
      extra.textContent = 'This cherry-pick has a conflict — it needs manual resolution. Please resolve it locally.';
    } else {
      status.textContent = 'error';
      status.className = 'run-status error';
      extra.textContent = result.message || 'The run failed.';
    }
  }
}

configForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const { error, plan } = buildPlan();
  if (error) {
    showBanner(resolveResult, escapeHtml(error), 'error');
    return;
  }
  const token = githubTokenInput.value;
  if (!token) {
    showBanner(resolveResult, 'A GitHub token is required.', 'error');
    return;
  }

  runBtn.disabled = true;
  runStep.style.display = 'block';
  const rows = renderRunRows(plan);

  runAll(plan, token, rows).finally(() => {
    runBtn.disabled = false;
  });
});
