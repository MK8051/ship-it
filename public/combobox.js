// Lightweight, freely-editable autocomplete. Never blocks typing a value
// that isn't in the fetched options — it's a convenience on top of a plain
// text input, not a strict enum select.
(function () {
  function normalize(opt) {
    return typeof opt === 'string' ? { value: opt, label: opt } : opt;
  }

  // opts:
  //   getOptions() -> Promise<Array<string|{value,label}>>  (called fresh each time the field is focused)
  //   multi: boolean — if true, the input holds a comma-separated list and
  //          selecting an item only replaces the segment currently being typed.
  //   liveSearch(query) -> Promise<Array<string|{value,label}>> — optional,
  //          and mutually exclusive with getOptions. Instead of fetching a
  //          bulk list up front, this is called (debounced) on every
  //          keystroke so results come from a real server-side search
  //          rather than filtering a list that may be truncated.
  function attach(input, opts = {}) {
    const { getOptions, multi = false, liveSearch, liveSearchDelay = 200 } = opts;
    let options = [];
    let currentMatches = []; // kept in sync with whatever's actually rendered, including async-injected items — keyboard selection reads from this, not a freshly recomputed list
    let activeIndex = -1;
    let searchTimer = null;

    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    const list = document.createElement('ul');
    list.className = 'combobox-list';
    list.style.display = 'none';
    wrapper.appendChild(list);

    function currentSegment() {
      if (!multi) return input.value;
      const parts = input.value.split(',');
      return parts[parts.length - 1].trim();
    }

    // Exact match first, then prefix match, then "contains" (earlier
    // position wins ties) — otherwise an exact match can get crowded out of
    // the top-20 slice by unrelated names that merely contain the same text
    // (e.g. "features" buried behind twenty branches like "x-mirror-features").
    function matchScore(label, q) {
      if (!q) return 0;
      if (label === q) return 0;
      if (label.startsWith(q)) return 1;
      const idx = label.indexOf(q);
      return idx === -1 ? null : 2 + idx / 1e6;
    }

    function getMatches() {
      const q = currentSegment().toLowerCase();
      return options
        .map((o) => ({ opt: o, score: matchScore(o.label.toLowerCase(), q) }))
        .filter((x) => x.score !== null)
        .sort((a, b) => a.score - b.score)
        .slice(0, 20)
        .map((x) => x.opt);
    }

    function renderList(matches) {
      currentMatches = matches;
      list.innerHTML = '';
      activeIndex = -1;
      if (matches.length === 0) {
        list.style.display = 'none';
        return;
      }
      matches.forEach((opt) => {
        const li = document.createElement('li');
        li.textContent = opt.label;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          select(opt.value);
        });
        list.appendChild(li);
      });
      list.style.display = 'block';
    }

    function render() {
      renderList(getMatches());
    }

    function select(value) {
      if (multi) {
        const parts = input.value.split(',');
        parts[parts.length - 1] = ' ' + value;
        input.value = parts.join(',').replace(/^\s+/, '');
      } else {
        input.value = value;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      list.style.display = 'none';
      input.focus();
    }

    function highlight(idx) {
      const items = [...list.children];
      items.forEach((li, i) => li.classList.toggle('active', i === idx));
      activeIndex = idx;
      if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
    }

    async function loadAndRender() {
      if (!getOptions) return;
      try {
        options = ((await getOptions()) || []).map(normalize);
      } catch (e) {
        options = [];
      }
      render();
    }

    function runLiveSearch() {
      const q = currentSegment();
      if (searchTimer) clearTimeout(searchTimer);
      if (!q) {
        renderList([]);
        return;
      }
      searchTimer = setTimeout(() => {
        liveSearch(q)
          .then((results) => {
            if (currentSegment() !== q) return; // text changed while the search was in flight
            renderList((results || []).map(normalize));
          })
          .catch(() => {});
      }, liveSearchDelay);
    }

    if (liveSearch) {
      input.addEventListener('focus', () => { if (currentSegment()) runLiveSearch(); });
      input.addEventListener('input', runLiveSearch);
    } else {
      input.addEventListener('focus', loadAndRender);
      input.addEventListener('input', render);
    }
    // Closes the list when focus leaves the input for any reason — including
    // Tab/Shift+Tab, which (unlike a real click elsewhere) never fires the
    // document 'click' listener below. Safe for mouse selection too: the
    // list item's mousedown already calls preventDefault(), so clicking a
    // suggestion never blurs the input in the first place.
    input.addEventListener('blur', () => { list.style.display = 'none'; });
    input.addEventListener('keydown', (e) => {
      const items = [...list.children];
      if (list.style.display === 'none' || items.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlight(Math.min(activeIndex + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlight(Math.max(activeIndex - 1, 0));
      } else if (e.key === 'Enter' && activeIndex >= 0) {
        e.preventDefault();
        const opt = currentMatches[activeIndex];
        if (opt) select(opt.value);
      } else if (e.key === 'Escape') {
        list.style.display = 'none';
      }
    });
    document.addEventListener('click', (e) => {
      if (!wrapper.contains(e.target)) list.style.display = 'none';
    });
  }

  window.combobox = { attach };
})();
