const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const SCRIPT_PATH =
  process.env.CHERRY_PICK_SCRIPT_PATH ||
  path.join(__dirname, 'scripts', 'cherry-pick-release.sh');
const PORT = process.env.PORT || 4545;
const DEFAULT_REPO = 'ZuperHQ';
const GITHUB_ORG = process.env.GITHUB_ORG || DEFAULT_REPO.split('/')[0];
const MAX_CONCURRENT_RUNS = 3;
const RUN_TTL_MS = 10 * 60 * 1000; // how long a finished run stays queryable

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const REF_RE = /^[A-Za-z0-9._/-]+$/;
const PRS_RE = /^\s*\d+(\s*,\s*\d+)*\s*$/;
const COMMITS_RE = /^\s*[0-9a-fA-F]{7,40}(\s*,\s*[0-9a-fA-F]{7,40})*\s*$/;

const runs = new Map(); // runId -> { status, log: [{event,data}], clients: Set(res), child, workDir, createdAt }

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function scrub(text, token) {
  if (!token) return text;
  return text.split(token).join('***');
}

function newRun() {
  const runId = crypto.randomUUID();
  const run = { id: runId, status: 'starting', log: [], clients: new Set(), child: null, workDir: null, createdAt: Date.now() };
  runs.set(runId, run);
  return { runId, run };
}

function emit(run, event, data) {
  run.log.push({ event, data });
  for (const res of run.clients) sendSSE(res, event, data);
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function emitLines(run, text) {
  text.split('\n').filter((l) => l.length > 0).forEach((line) => emit(run, 'log', { line }));
}

function cleanupWorkDir(workDir) {
  if (!workDir) return;
  fs.rm(workDir, { recursive: true, force: true }, () => {});
}

function scheduleForget(runId) {
  setTimeout(() => runs.delete(runId), RUN_TTL_MS).unref();
}

function activeRunCount() {
  let n = 0;
  for (const r of runs.values()) if (r.status === 'starting' || r.status === 'running') n++;
  return n;
}

function finalizeRun(run) {
  cleanupWorkDir(run.workDir);
  for (const res of run.clients) res.end();
  run.clients.clear();
  scheduleForget(run.id);
}

app.post('/api/runs', (req, res) => {
  const { repo, base, tag, branch, updateBranch, prBase, prs, commits, token, prTitle, prBody } = req.body || {};

  if (!repo || !REPO_RE.test(repo)) return res.status(400).json({ error: 'repo must look like owner/name' });

  const targetCount = [tag, branch, updateBranch].filter(Boolean).length;
  if (targetCount !== 1) {
    return res.status(400).json({ error: 'specify exactly one of: a new tag, a new branch, or an existing branch to update' });
  }
  if ((tag || branch) && (!base || !REF_RE.test(base))) return res.status(400).json({ error: 'invalid base ref' });
  if (tag && !REF_RE.test(tag)) return res.status(400).json({ error: 'invalid new tag name' });
  if (branch && !REF_RE.test(branch)) return res.status(400).json({ error: 'invalid new branch name' });
  if (updateBranch && !REF_RE.test(updateBranch)) return res.status(400).json({ error: 'invalid existing branch name' });
  if ((branch || updateBranch) && (!prTitle || !prTitle.trim())) {
    return res.status(400).json({ error: 'a PR title is required (used if this branch has no open PR yet)' });
  }
  if ((branch || updateBranch) && (!prBase || !REF_RE.test(prBase))) {
    return res.status(400).json({ error: 'a valid PR target branch is required' });
  }
  if (!prs && !commits) return res.status(400).json({ error: 'at least one PR number or commit SHA is required' });
  if (prs && !PRS_RE.test(prs)) return res.status(400).json({ error: 'prs must be a comma-separated list of numbers' });
  if (commits && !COMMITS_RE.test(commits)) return res.status(400).json({ error: 'commits must be a comma-separated list of SHAs (7+ hex chars each)' });
  if (!token) return res.status(400).json({ error: 'a GitHub token is required (used only for this run, never stored)' });

  if (activeRunCount() >= MAX_CONCURRENT_RUNS) {
    return res.status(429).json({ error: 'too many runs in progress, try again shortly' });
  }

  const { runId, run } = newRun();
  res.json({ runId });

  startRun(run, {
    repo,
    base,
    tag,
    branch,
    updateBranch,
    prBase,
    prs: prs ? prs.replace(/\s+/g, '') : '',
    commits: commits ? commits.replace(/\s+/g, '') : '',
    token,
    prTitle,
    prBody,
  }).catch((e) => {
    emit(run, 'log', { line: `internal error: ${e.message}` });
    run.status = 'error';
    emit(run, 'result', { status: 'error', message: 'Internal error, see log above.' });
    finalizeRun(run);
  });
});

app.get('/api/runs/:id/events', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  for (const { event, data } of run.log) sendSSE(res, event, data);

  if (run.status === 'done' || run.status === 'conflict' || run.status === 'error') {
    res.end();
    return;
  }

  run.clients.add(res);
  req.on('close', () => run.clients.delete(res));
});

app.get('/api/script', (req, res) => {
  res.download(SCRIPT_PATH, 'cherry-pick-release.sh');
});

app.get('/api/config', (req, res) => {
  res.json({ defaultRepo: DEFAULT_REPO, githubOrg: GITHUB_ORG });
});

const GH_API = process.env.GITHUB_API_BASE || 'https://api.github.com';

function ghFetch(pathName, token, opts = {}) {
  return fetch(`${GH_API}${pathName}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
}

function describeGhError(status) {
  if (status === 401) return { code: 401, message: 'GitHub rejected the token (invalid or expired)' };
  if (status === 403) return { code: 403, message: 'the token does not have permission for this repo' };
  return { code: 502, message: `GitHub API error (${status})` };
}

app.post('/api/tag-lookup', async (req, res) => {
  const { repo, tag, token } = req.body || {};
  if (!repo || !REPO_RE.test(repo)) return res.status(400).json({ error: 'repo must look like owner/name' });
  if (!tag || !REF_RE.test(tag)) return res.status(400).json({ error: 'invalid tag name' });
  if (!token) return res.status(400).json({ error: 'a GitHub token is required' });

  try {
    const ghRes = await ghFetch(`/repos/${repo}/git/refs/tags/${tag}`, token);
    if (ghRes.status === 404) return res.status(404).json({ error: `tag "${tag}" was not found on ${repo}` });
    if (!ghRes.ok) {
      const { code, message } = describeGhError(ghRes.status);
      return res.status(code).json({ error: message });
    }
    const data = await ghRes.json();
    res.json({ sha: data.object.sha, type: data.object.type });
  } catch (e) {
    res.status(502).json({ error: 'could not reach the GitHub API' });
  }
});

app.post('/api/delete-tag', async (req, res) => {
  const { repo, tag, token, confirmTag } = req.body || {};
  if (!repo || !REPO_RE.test(repo)) return res.status(400).json({ error: 'repo must look like owner/name' });
  if (!tag || !REF_RE.test(tag)) return res.status(400).json({ error: 'invalid tag name' });
  if (!token) return res.status(400).json({ error: 'a GitHub token is required' });
  if (confirmTag !== tag) return res.status(400).json({ error: 'confirmation text did not match the tag name' });

  try {
    const ghRes = await ghFetch(`/repos/${repo}/git/refs/tags/${tag}`, token, { method: 'DELETE' });
    if (ghRes.status === 404) return res.status(404).json({ error: `tag "${tag}" was not found on ${repo}` });
    if (ghRes.status !== 204) {
      const { code, message } = describeGhError(ghRes.status);
      return res.status(code).json({ error: message });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'could not reach the GitHub API' });
  }
});

app.post('/api/rename-tag', async (req, res) => {
  const { repo, oldTag, newTag, token, confirmOldTag } = req.body || {};
  if (!repo || !REPO_RE.test(repo)) return res.status(400).json({ error: 'repo must look like owner/name' });
  if (!oldTag || !REF_RE.test(oldTag)) return res.status(400).json({ error: 'invalid current tag name' });
  if (!newTag || !REF_RE.test(newTag)) return res.status(400).json({ error: 'invalid new tag name' });
  if (oldTag === newTag) return res.status(400).json({ error: 'new tag name must be different from the current one' });
  if (!token) return res.status(400).json({ error: 'a GitHub token is required' });
  if (confirmOldTag !== oldTag) return res.status(400).json({ error: 'confirmation text did not match the current tag name' });

  try {
    // The new name must not already be taken.
    const existingRes = await ghFetch(`/repos/${repo}/git/refs/tags/${newTag}`, token);
    if (existingRes.status === 200) return res.status(409).json({ error: `tag "${newTag}" already exists` });
    if (existingRes.status !== 404) {
      const { code, message } = describeGhError(existingRes.status);
      return res.status(code).json({ error: message });
    }

    // Look up what the current tag points to.
    const oldRefRes = await ghFetch(`/repos/${repo}/git/refs/tags/${oldTag}`, token);
    if (oldRefRes.status === 404) return res.status(404).json({ error: `tag "${oldTag}" was not found on ${repo}` });
    if (!oldRefRes.ok) {
      const { code, message } = describeGhError(oldRefRes.status);
      return res.status(code).json({ error: message });
    }
    const oldRef = await oldRefRes.json();
    let newRefSha = oldRef.object.sha;

    // An annotated tag's ref points at a tag object, not the commit — recreate
    // that annotation under the new name so it isn't silently dropped.
    if (oldRef.object.type === 'tag') {
      const tagObjRes = await ghFetch(`/repos/${repo}/git/tags/${oldRef.object.sha}`, token);
      if (!tagObjRes.ok) {
        const { code, message } = describeGhError(tagObjRes.status);
        return res.status(code).json({ error: `couldn't read the existing annotated tag: ${message}` });
      }
      const tagObj = await tagObjRes.json();
      const createTagRes = await ghFetch(`/repos/${repo}/git/tags`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag: newTag,
          message: tagObj.message,
          object: tagObj.object.sha,
          type: tagObj.object.type,
          tagger: tagObj.tagger,
        }),
      });
      if (!createTagRes.ok) {
        const { code, message } = describeGhError(createTagRes.status);
        return res.status(code).json({ error: `couldn't create the new annotated tag object: ${message}` });
      }
      const newTagObj = await createTagRes.json();
      newRefSha = newTagObj.sha;
    }

    // Create the new ref first — only delete the old one once this succeeds,
    // so a failure here never leaves the repo with neither tag.
    const createRefRes = await ghFetch(`/repos/${repo}/git/refs`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/tags/${newTag}`, sha: newRefSha }),
    });
    if (!createRefRes.ok) {
      const { code, message } = describeGhError(createRefRes.status);
      return res.status(code).json({ error: `couldn't create "${newTag}": ${message}` });
    }

    const deleteRes = await ghFetch(`/repos/${repo}/git/refs/tags/${oldTag}`, token, { method: 'DELETE' });
    if (deleteRes.status !== 204) {
      const { code, message } = describeGhError(deleteRes.status);
      return res.json({
        ok: true,
        warning: `"${newTag}" was created, but deleting "${oldTag}" failed (${message} / HTTP ${code}). Delete it manually.`,
      });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'could not reach the GitHub API' });
  }
});

const LINEAR_API = process.env.LINEAR_API_BASE || 'https://api.linear.app/graphql';

// Attachments are the only documented way to read what's linked to an issue;
// Linear doesn't publish a stable enum for "this is a GitHub PR", so this
// matches on the URL shape instead of trusting sourceType.
const GITHUB_PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/i;

const LINEAR_ISSUE_QUERY = `
  query($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      url
      attachments {
        nodes { url title }
      }
    }
  }
`;

async function fetchLinearIssue(identifier, token) {
  const ghRes = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query: LINEAR_ISSUE_QUERY, variables: { id: identifier } }),
  });
  if (ghRes.status === 401) throw new Error('Linear rejected the API key (invalid or expired)');
  if (!ghRes.ok) {
    const text = await ghRes.text().catch(() => '');
    throw new Error(`Linear API HTTP ${ghRes.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const body = await ghRes.json();
  if (body.errors && body.errors.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data && body.data.issue;
}

app.post('/api/linear/resolve', async (req, res) => {
  const { linearToken, tasks } = req.body || {};
  if (!linearToken) return res.status(400).json({ error: 'a Linear API key is required' });
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: 'at least one Linear task identifier is required' });
  }

  const cleaned = [...new Set(tasks.map((t) => String(t).trim()).filter(Boolean))];
  if (cleaned.length === 0) return res.status(400).json({ error: 'at least one Linear task identifier is required' });
  if (cleaned.length > 30) return res.status(400).json({ error: 'too many tasks at once (limit 30)' });

  let results;
  try {
    results = await Promise.all(
      cleaned.map(async (identifier) => {
        try {
          const issue = await fetchLinearIssue(identifier, linearToken);
          if (!issue) return { identifier, found: false };
          const attachments = (issue.attachments && issue.attachments.nodes) || [];
          const prs = [];
          const rawAttachments = [];
          for (const a of attachments) {
            const m = a.url && a.url.match(GITHUB_PR_URL_RE);
            if (m) prs.push({ repo: `${m[1]}/${m[2]}`, number: parseInt(m[3], 10), url: a.url });
            else rawAttachments.push({ url: a.url, title: a.title });
          }
          return { identifier: issue.identifier, title: issue.title, linearUrl: issue.url, found: true, prs, rawAttachments };
        } catch (e) {
          return { identifier, found: false, error: e.message };
        }
      })
    );
  } catch (e) {
    return res.status(502).json({ error: 'could not reach the Linear API' });
  }

  const repoMap = new Map();
  for (const r of results) {
    if (!r.found) continue;
    for (const pr of r.prs) {
      if (!repoMap.has(pr.repo)) repoMap.set(pr.repo, new Set());
      repoMap.get(pr.repo).add(pr.number);
    }
  }
  const repos = [...repoMap.entries()].map(([repo, nums]) => ({ repo, prs: [...nums].sort((a, b) => a - b) }));

  res.json({ tasks: results, repos });
});

app.post('/api/github/whoami', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const ghRes = await ghFetch('/user', token);
    if (!ghRes.ok) {
      const { code, message } = describeGhError(ghRes.status);
      return res.status(code).json({ error: message });
    }
    const data = await ghRes.json();
    res.json({ login: data.login, name: data.name || data.login });
  } catch (e) {
    res.status(502).json({ error: 'could not reach the GitHub API' });
  }
});

// Fetches every page of a paginated GitHub list endpoint, capped at 10 pages
// (1000 items) to bound the number of requests for a repo with an unusually
// large number of refs. This is a mitigation, not a guarantee — a repo can
// still exceed it, which is why the exact-match verification below exists:
// it checks the literal typed value directly against GitHub regardless of
// whether the bulk list was truncated.
async function ghFetchAllPages(pathBase, token) {
  let results = [];
  for (let page = 1; page <= 10; page++) {
    const sep = pathBase.includes('?') ? '&' : '?';
    const res = await ghFetch(`${pathBase}${sep}per_page=100&page=${page}`, token);
    if (!res.ok) {
      if (page === 1) throw new Error(`GitHub API HTTP ${res.status}`);
      break;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    results = results.concat(data);
    if (data.length < 100) break;
  }
  return results;
}

app.post('/api/github/repos', async (req, res) => {
  const { token, org } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  const targetOrg = org || GITHUB_ORG;
  if (!targetOrg) return res.status(400).json({ error: 'no GitHub org configured (set GITHUB_ORG)' });
  try {
    const data = await ghFetchAllPages(`/orgs/${targetOrg}/repos`, token);
    res.json({ repos: data.map((r) => r.full_name).sort() });
  } catch (e) {
    res.status(502).json({ error: 'could not list repos: ' + e.message });
  }
});

app.post('/api/github/commits', async (req, res) => {
  const { token, repo, ref } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  if (!repo || !REPO_RE.test(repo)) return res.status(400).json({ error: 'repo must look like owner/name' });
  try {
    const shaParam = ref ? `&sha=${encodeURIComponent(ref)}` : '';
    const ghRes = await ghFetch(`/repos/${repo}/commits?per_page=50${shaParam}`, token);
    if (!ghRes.ok) {
      const { code, message } = describeGhError(ghRes.status);
      return res.status(code).json({ error: message });
    }
    const data = await ghRes.json();
    res.json({
      commits: data.map((c) => ({ sha: c.sha, message: ((c.commit && c.commit.message) || '').split('\n')[0] })),
    });
  } catch (e) {
    res.status(502).json({ error: 'could not list commits: ' + e.message });
  }
});

app.post('/api/github/pulls', async (req, res) => {
  const { token, repo } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  if (!repo || !REPO_RE.test(repo)) return res.status(400).json({ error: 'repo must look like owner/name' });
  try {
    const ghRes = await ghFetch(`/repos/${repo}/pulls?state=all&per_page=50&sort=updated&direction=desc`, token);
    if (!ghRes.ok) {
      const { code, message } = describeGhError(ghRes.status);
      return res.status(code).json({ error: message });
    }
    const data = await ghRes.json();
    res.json({ pulls: data.map((p) => ({ number: p.number, title: p.title, state: p.state })) });
  } catch (e) {
    res.status(502).json({ error: 'could not list PRs: ' + e.message });
  }
});

// Real search-as-you-type for branches/tags, via the GraphQL API's
// Repository.refs(query:) field — the same fuzzy-match-by-substring
// mechanism that powers GitHub's own branch/tag switcher on repo pages.
// Unlike the REST /branches or /tags list, this is filtered server-side,
// so it isn't limited by the bulk list's pagination cap.
const GH_GRAPHQL = `${GH_API}/graphql`;

async function ghGraphQL(query, variables, token) {
  const res = await fetch(GH_GRAPHQL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL API HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors && body.errors.length) throw new Error(body.errors[0].message);
  return body.data;
}

const REFS_SEARCH_QUERY = `
  query($owner: String!, $name: String!, $q: String!) {
    repository(owner: $owner, name: $name) {
      branches: refs(refPrefix: "refs/heads/", query: $q, first: 20) {
        nodes { name }
      }
      tags: refs(refPrefix: "refs/tags/", query: $q, first: 20) {
        nodes { name }
      }
    }
  }
`;

app.post('/api/github/refs-search', async (req, res) => {
  const { token, repo, query } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  if (!repo || !REPO_RE.test(repo)) return res.status(400).json({ error: 'repo must look like owner/name' });
  if (!query) return res.json({ branches: [], tags: [] });
  const [owner, name] = repo.split('/');
  try {
    const data = await ghGraphQL(REFS_SEARCH_QUERY, { owner, name, q: query }, token);
    const repository = data && data.repository;
    res.json({
      branches: (repository && repository.branches.nodes.map((n) => n.name)) || [],
      tags: (repository && repository.tags.nodes.map((n) => n.name)) || [],
    });
  } catch (e) {
    res.status(502).json({ error: 'could not search branches/tags: ' + e.message });
  }
});

app.post('/api/linear/whoami', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const linRes = await fetch(LINEAR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ query: '{ viewer { name email } }' }),
    });
    if (linRes.status === 401) return res.status(401).json({ error: 'Linear rejected the API key' });
    if (!linRes.ok) return res.status(502).json({ error: `Linear API HTTP ${linRes.status}` });
    const body = await linRes.json();
    if (body.errors && body.errors.length) return res.status(502).json({ error: body.errors.map((e) => e.message).join('; ') });
    res.json({ name: body.data.viewer.name, email: body.data.viewer.email });
  } catch (e) {
    res.status(502).json({ error: 'could not reach the Linear API' });
  }
});

function execFilePromise(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function startRun(run, { repo, base, tag, branch, updateBranch, prBase, prs, commits, token, prTitle, prBody }) {
  run.status = 'running';
  run.workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpapp-'));

  // A PR's target must be an actual branch — GitHub can't target a tag. This
  // is separate from `base`, which is just where the cherry-pick starts from
  // (that one is fine as a tag). Check upfront so a bad value fails in
  // seconds instead of after a full clone + cherry-pick + push.
  if (branch || updateBranch) {
    emit(run, 'log', { line: `Checking that "${prBase}" is a branch on ${repo}...` });
    try {
      const branchRes = await ghFetch(`/repos/${repo}/branches/${prBase}`, token);
      if (branchRes.status === 404) {
        run.status = 'error';
        emit(run, 'result', {
          status: 'error',
          message: `"${prBase}" is not a branch on ${repo}. A pull request's target must be an actual branch — a tag won't work here.`,
        });
        finalizeRun(run);
        return;
      }
      if (!branchRes.ok) {
        const { code, message } = describeGhError(branchRes.status);
        run.status = 'error';
        emit(run, 'result', { status: 'error', message: `Could not verify the PR target branch: ${message}` });
        finalizeRun(run);
        return;
      }
    } catch (e) {
      run.status = 'error';
      emit(run, 'result', { status: 'error', message: 'Could not reach the GitHub API to verify the PR target branch.' });
      finalizeRun(run);
      return;
    }
  }

  emit(run, 'log', { line: `Cloning ${repo}...` });
  // Test-only escape hatch: point clones at a local repo instead of real
  // GitHub, mirroring the GITHUB_API_BASE/LINEAR_API_BASE overrides above.
  const cloneUrl = process.env.GIT_CLONE_URL_OVERRIDE || `https://x-access-token:${token}@github.com/${repo}.git`;
  try {
    await execFilePromise('git', ['clone', '--quiet', cloneUrl, run.workDir]);
  } catch (e) {
    emitLines(run, scrub(`${e.stdout || ''}${e.stderr || ''}`, token));
    emit(run, 'log', { line: 'Clone failed — check the repo name and that the token has access.' });
    run.status = 'error';
    emit(run, 'result', { status: 'error', message: 'Clone failed. Check the repo name and token permissions.' });
    cleanupWorkDir(run.workDir);
    scheduleForget(run.id);
    return;
  }
  emit(run, 'log', { line: 'Clone complete. Starting cherry-pick...' });

  const branchName = branch || updateBranch;
  const args = [SCRIPT_PATH, '--repo', repo];
  if (prs) args.push('--prs', prs);
  if (commits) args.push('--commits', commits);
  if (tag) args.push('--base', base, '--tag', tag);
  else if (branch) args.push('--base', base, '--branch', branch);
  else args.push('--update-branch', updateBranch);

  const child = spawn('bash', args, { cwd: run.workDir, env: { ...process.env, GITHUB_TOKEN: token } });
  run.child = child;

  let combined = '';
  child.stdout.on('data', (d) => {
    const text = scrub(d.toString(), token);
    combined += text;
    emitLines(run, text);
  });
  child.stderr.on('data', (d) => {
    const text = scrub(d.toString(), token);
    combined += text;
    emitLines(run, text);
  });

  child.on('close', async (code) => {
    if (code === 0 && tag) {
      run.status = 'done';
      emit(run, 'result', { status: 'success', tagUrl: `https://github.com/${repo}/tree/${tag}` });
    } else if (code === 0) {
      const owner = repo.split('/')[0];

      if (updateBranch) {
        emit(run, 'log', { line: `Branch updated. Checking for an existing open PR on ${branchName}...` });
        try {
          const existingRes = await ghFetch(`/repos/${repo}/pulls?head=${owner}:${encodeURIComponent(branchName)}&state=open`, token);
          if (existingRes.ok) {
            const existing = await existingRes.json();
            if (Array.isArray(existing) && existing.length > 0) {
              run.status = 'done';
              emit(run, 'result', { status: 'success', prUrl: existing[0].html_url });
              finalizeRun(run);
              return;
            }
          }
        } catch (e) {
          // fall through to creating a new PR below
        }
        emit(run, 'log', { line: `No open PR found for ${branchName} — opening a new one into ${prBase}...` });
      } else {
        emit(run, 'log', { line: `Branch pushed. Opening PR into ${prBase}...` });
      }

      try {
        const ghRes = await ghFetch(`/repos/${repo}/pulls`, token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: prTitle, head: branchName, base: prBase, body: prBody || '' }),
        });
        const prData = await ghRes.json().catch(() => ({}));
        if (!ghRes.ok) {
          run.status = 'error';
          emit(run, 'result', {
            status: 'error',
            message: `Branch "${branchName}" was pushed, but opening the PR failed: ${prData.message || ghRes.status}. Open it manually.`,
          });
        } else {
          run.status = 'done';
          emit(run, 'result', { status: 'success', prUrl: prData.html_url });
        }
      } catch (e) {
        run.status = 'error';
        emit(run, 'result', {
          status: 'error',
          message: `Branch "${branchName}" was pushed, but the GitHub API was unreachable to open the PR. Open it manually.`,
        });
      }
    } else if (/conflict applying/i.test(combined)) {
      run.status = 'conflict';
      const targetFlag = tag ? `--base ${base} --tag ${tag}` : branch ? `--base ${base} --branch ${branch}` : `--update-branch ${updateBranch}`;
      const sourceFlags = [prs ? `--prs ${prs}` : '', commits ? `--commits ${commits}` : ''].filter(Boolean).join(' ');
      const command = `scripts/cherry-pick-release.sh ${targetFlag} ${sourceFlags} --repo ${repo}`;
      emit(run, 'result', { status: 'conflict', command });
    } else {
      run.status = 'error';
      emit(run, 'result', { status: 'error', message: 'The run failed. See the log above for details.' });
    }
    finalizeRun(run);
  });
}

if (!fs.existsSync(SCRIPT_PATH)) {
  console.error(`cherry-pick-release.sh not found at ${SCRIPT_PATH}`);
  console.error('Set CHERRY_PICK_SCRIPT_PATH to its actual location.');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`ship-it listening on http://localhost:${PORT}`);
  if (DEFAULT_REPO) console.log(`default repo: ${DEFAULT_REPO}`);
});
