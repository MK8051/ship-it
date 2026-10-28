// Shared, cached lookups backing the search/autocomplete fields across every
// tool. Token is passed explicitly (not read from a specific page's input)
// so this module has no assumptions about any one page's DOM structure.
(function () {
  let reposCache = null; // Promise, fetched once and reused
  const commitsCacheByRepo = new Map(); // repo -> Promise<[{sha,message}]>
  const pullsCacheByRepo = new Map(); // repo -> Promise<[{number,title,state}]>

  function ghPost(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  }

  function getRepoOptions(token) {
    if (!token) return Promise.resolve([]);
    if (!reposCache) reposCache = ghPost('/api/github/repos', { token }).then((b) => b.repos || []);
    return reposCache;
  }

  // Guards against two things: (1) firing a request before a token is
  // filled in, and (2) permanently caching that kind of failure — without
  // this, an early empty attempt would mean "no results, forever" even
  // after the token shows up.
  function cachedRepoFetch(cache, repo, token, endpoint, mapResult) {
    if (!token) return Promise.resolve(mapResult({}));
    if (!cache.has(repo)) {
      const promise = ghPost(endpoint, { token, repo })
        .then((b) => {
          if (b.error) throw new Error(b.error);
          return mapResult(b);
        })
        .catch(() => {
          cache.delete(repo);
          return mapResult({});
        });
      cache.set(repo, promise);
    }
    return cache.get(repo);
  }

  function getCommitsForRepo(repo, token) {
    return cachedRepoFetch(commitsCacheByRepo, repo, token, '/api/github/commits', (b) => b.commits || []);
  }

  function getPullsForRepo(repo, token) {
    return cachedRepoFetch(pullsCacheByRepo, repo, token, '/api/github/pulls', (b) => b.pulls || []);
  }

  const refsSearchCache = new Map(); // "repo|query" -> Promise<{branches,tags}>

  // Real search-as-you-type: asks GitHub itself to fuzzy-match branch/tag
  // names against the typed text (via GraphQL, server-side), instead of
  // filtering a bulk-fetched list that can be truncated for large repos.
  function searchRefs(repo, query, token) {
    if (!token || !query) return Promise.resolve({ branches: [], tags: [] });
    const key = `${repo}|${query}`;
    if (!refsSearchCache.has(key)) {
      const promise = ghPost('/api/github/refs-search', { token, repo, query })
        .then((b) => {
          if (b.error) throw new Error(b.error);
          return { branches: b.branches || [], tags: b.tags || [] };
        })
        .catch(() => {
          refsSearchCache.delete(key);
          return { branches: [], tags: [] };
        });
      refsSearchCache.set(key, promise);
    }
    return refsSearchCache.get(key);
  }

  window.githubSearch = { getRepoOptions, getCommitsForRepo, getPullsForRepo, searchRefs };
})();
