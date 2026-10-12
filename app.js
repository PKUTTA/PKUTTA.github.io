/* Shared public and local-admin application. Hash routes keep the public export
   deployable as a single static index.html on GitHub Pages. */
(() => {
  'use strict';

  const admin = document.body.dataset.mode === 'admin';
  const app = document.getElementById('app');
  const modalRoot = document.getElementById('modal-root');
  const toastRoot = document.getElementById('toast-root');
  const label = {
    men: '男子', women: '女子', mixed: '混合',
    single: '单打', double: '双打', team: '团体',
    'group-knockout': '小组赛 · 淘汰赛', knockout: '淘汰赛',
    'round-robin': '循环赛', group: '小组赛', round_robin: '循环赛'
  };
  const icon = {
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l11-11a2.1 2.1 0 0 0-4-4L4 16v4Zm9-13 4 4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 4h4m-8 3 1 13h10l1-13M10 11v6m4-6v6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l14 14M19 5 5 19"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
  };
  let routeSerial = 0;
  let current = null;
  let modalState = null;
  const rankingVisibility = new Map();
  const scoreQueues = new Map();

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const attr = esc;
  const routeHome = '#/';
  const routeCompetition = slug => `#/competitions/${encodeURIComponent(slug)}`;
  const routeEvent = (slug, eventSlug, stage) => `${routeCompetition(slug)}/events/${encodeURIComponent(eventSlug)}${stage ? `?stage=${encodeURIComponent(stage)}` : ''}`;
  const endpoint = path => admin ? `/api${path}` : `./database${path}`;
  const apiPath = (slug, eventSlug, stage, matchId) => `/competitions/${encodeURIComponent(slug)}` +
    (eventSlug ? `/events/${encodeURIComponent(eventSlug)}` : '') +
    (stage ? `/stages/${encodeURIComponent(stage)}` : '') +
    (matchId ? `/matches/${encodeURIComponent(matchId)}` : '');

  function route() {
    const raw = location.hash.slice(1) || '/';
    const [path, query = ''] = raw.split('?');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const stage = new URLSearchParams(query).get('stage');
    if (parts.length === 0) return { page: 'home' };
    if (parts[0] === 'competitions' && parts.length === 2) return { page: 'competition', slug: parts[1] };
    if (parts[0] === 'competitions' && parts[2] === 'events' && parts.length === 4) {
      return { page: 'event', slug: parts[1], eventSlug: parts[3], stage };
    }
    return { page: 'not-found' };
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 404 ? '页面或数据不存在。' : `读取数据失败（${response.status}）。`);
    return response.json();
  }

  async function getJson(path) {
    if (admin) return fetchJson(endpoint(path));
    const read = relativePath => fetchJson(endpoint(`/${relativePath}`));
    const competitionMeta = async slug => ({ ...(await read(`${encodeURIComponent(slug)}/meta.json`)), slug });
    if (path === '/competitions') {
      const index = await read('index.json');
      return { competitions: await Promise.all((index.competitions || []).map(competitionMeta)) };
    }
    const routeParts = path.match(/^\/competitions\/([^/]+)(?:\/events\/([^/]+))?$/);
    if (!routeParts) throw new Error('页面或数据不存在。');
    const slug = decodeURIComponent(routeParts[1]);
    const competition = await competitionMeta(slug);
    const eventMeta = async eventSlug => ({ ...(await read(`${encodeURIComponent(slug)}/${encodeURIComponent(eventSlug)}/meta.json`)), slug: eventSlug });
    if (!routeParts[2]) {
      return { competition, events: await Promise.all((competition.events || []).map(eventMeta)) };
    }
    const event = await eventMeta(decodeURIComponent(routeParts[2]));
    const stages = Object.fromEntries(await Promise.all((event.stages || []).map(async name => {
      const prefix = `${encodeURIComponent(slug)}/${encodeURIComponent(event.slug)}/${encodeURIComponent(name)}`;
      const [metadata, data] = await Promise.all([read(`${prefix}/metadata.json`), read(`${prefix}/data.json`)]);
      return [name, { metadata, data }];
    })));
    return { competition, event, stages };
  }

  async function mutate(method, path, body) {
    const response = await fetch(endpoint(path), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `操作失败（${response.status}）。`);
    return result;
  }

  async function readCsvText(file) {
    const bytes = await file.arrayBuffer();
    let csv;
    try {
      csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      try {
        csv = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
      } catch {
        throw new Error('无法读取 CSV 编码，请将名单保存为 UTF-8 或 GBK/GB18030 后重试。');
      }
    }
    if (csv.includes('\uFFFD')) {
      throw new Error('CSV 名单中已有乱码字符“�”，请检查原始文件并重新导出。');
    }
    return csv;
  }

  function toast(message, isError = false) {
    const node = document.createElement('div');
    node.className = `toast${isError ? ' error' : ''}`;
    node.textContent = message;
    toastRoot.append(node);
    setTimeout(() => node.remove(), 4200);
  }

  function shell(content, title = '赛事中心') {
    document.title = `${title} · 北京大学乒乓球协会`;
    app.innerHTML = `<header class="site-header"><div class="header-inner">
      <a class="brand" href="${routeHome}" aria-label="返回赛事首页"><span class="brand-mark">PKU</span>
      <span class="brand-name">北京大学乒乓球协会<small>TABLE TENNIS ASSOCIATION</small></span></a>
      <div class="header-right">${admin ? '<span class="mode-badge">管理后台</span>' : ''}<a class="header-link" href="${routeHome}">赛事首页</a></div>
    </div></header><main class="page-shell">${content}</main>
    <footer class="site-footer"><div class="footer-inner"><span>北京大学乒乓球协会 · 赛事中心</span></div></footer>`;
  }

  function breadcrumbs(items) {
    return `<nav class="breadcrumbs" aria-label="面包屑导航"><a href="${routeHome}">赛事首页</a>` +
      items.map(item => `<span class="sep">/</span>${item.href ? `<a href="${attr(item.href)}">${esc(item.text)}</a>` : `<span aria-current="page">${esc(item.text)}</span>`}`).join('') + '</nav>';
  }

  function empty(title, description, isError = false) {
    return `<div class="empty-state${isError ? ' error-state' : ''}"><strong>${esc(title)}</strong><p>${esc(description)}</p></div>`;
  }

  function dateText(competition) {
    const start = competition.start_date || '';
    const end = competition.end_date || start;
    return start && end && start !== end ? `${start} — ${end}` : start || '日期待定';
  }

  function byDateDescending(a, b) {
    return String(b.start_date || b.end_date || '').localeCompare(String(a.start_date || a.end_date || '')) ||
      String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  }

  function eventName(event) {
    return event.name || `${label[event.discipline] || ''}${label[event.format] || ''}` || event.slug;
  }

  function iconButton(action, aria, id, danger = false) {
    return `<button class="icon-button${danger ? ' danger' : ''}" type="button" data-action="${attr(action)}" data-id="${attr(id)}" aria-label="${attr(aria)}" title="${attr(aria)}">${icon[danger ? 'trash' : 'edit']}</button>`;
  }

  function competitionCard(competition) {
    return `<article class="entity-card"><div class="card-kicker">COMPETITION</div>
      <h3>${esc(competition.name)}</h3>
      <div class="card-meta"><span>◷ ${esc(dateText(competition))}</span><span>⌖ ${esc(competition.venue || '地点待定')}</span></div>
      <div class="card-bottom"><div class="card-tools">${admin ? iconButton('edit-competition', '编辑赛事', competition.slug) + iconButton('delete-competition', '删除赛事', competition.slug, true) : ''}</div>
      <a class="arrow-link" href="${attr(routeCompetition(competition.slug))}" aria-label="查看${attr(competition.name)}">${icon.arrow}</a></div></article>`;
  }

  function eventCard(event, competitionSlug) {
    return `<article class="entity-card"><div class="card-kicker">EVENT</div><h3>${esc(eventName(event))}</h3>
      <div class="card-meta"><span>${esc(label[event.schedule] || event.schedule || '赛程待定')}</span></div>
      <div class="card-bottom"><div class="card-tools">${admin ? iconButton('delete-event', '删除项目', event.slug, true) : ''}</div>
      <a class="arrow-link" href="${attr(routeEvent(competitionSlug, event.slug))}" aria-label="查看${attr(eventName(event))}">${icon.arrow}</a></div></article>`;
  }

  async function render() {
    const serial = ++routeSerial;
    const r = route();
    shell('<div class="empty-state"><strong>正在加载赛事信息…</strong></div>');
    try {
      if (r.page === 'home') {
        const data = await getJson('/competitions');
        if (serial !== routeSerial) return;
        current = { page: 'home', competitions: data.competitions || [] };
        renderHome();
      } else if (r.page === 'competition') {
        const data = await getJson(`/competitions/${encodeURIComponent(r.slug)}`);
        if (serial !== routeSerial) return;
        current = { page: 'competition', ...data };
        renderCompetition();
      } else if (r.page === 'event') {
        const data = await getJson(`/competitions/${encodeURIComponent(r.slug)}/events/${encodeURIComponent(r.eventSlug)}`);
        if (serial !== routeSerial) return;
        current = { page: 'event', ...data, requestedStage: r.stage };
        renderEvent();
      } else {
        shell(empty('页面不存在', '请从赛事首页选择要查看的内容。', true), '页面不存在');
      }
    } catch (error) {
      if (serial !== routeSerial) return;
      shell(`${breadcrumbs([])}${empty('暂时无法显示', error.message, true)}`, '加载失败');
    }
  }

  function renderHome() {
    const competitions = [...current.competitions].sort(byDateDescending);
    shell(`<div class="page-head"><div class="eyebrow">PKU TABLE TENNIS</div><h1>赛事中心</h1>
      <p class="lead">查看比赛项目、对阵安排与实时赛果。</p></div>
      <div class="section-heading"><div><h2>全部赛事</h2><span class="count">共 ${competitions.length} 场赛事</span></div>
      ${admin ? `<div class="section-actions"><button class="button primary" data-action="add-competition">${icon.plus} 添加赛事</button></div>` : ''}</div>
      ${competitions.length ? `<div class="card-grid">${competitions.map(competitionCard).join('')}</div>` : empty('尚无赛事', admin ? '点击“添加赛事”创建第一场比赛。' : '赛事信息发布后会显示在这里。')}`, '赛事中心');
  }

  function renderCompetition() {
    const { competition, events = [] } = current;
    shell(`${breadcrumbs([{ text: competition.name }])}
      <div class="page-head"><div class="eyebrow">COMPETITION</div><h1>${esc(competition.name)}</h1>
      <p class="lead">${esc(dateText(competition))}　·　${esc(competition.venue || '地点待定')}</p></div>
      <div class="section-heading"><div><h2>比赛项目</h2><span class="count">共 ${events.length} 个项目</span></div>
      ${admin ? `<div class="section-actions"><button class="button primary" data-action="add-event">${icon.plus} 添加项目</button></div>` : ''}</div>
      ${events.length ? `<div class="card-grid">${events.map(event => eventCard(event, competition.slug)).join('')}</div>` : empty('尚无项目', admin ? '点击“添加项目”设置赛程与选手。' : '项目发布后会显示在这里。')}`, competition.name);
  }

  function isGroupComplete(stage) {
    const groups = stage?.data?.groups || [];
    return !!stage?.data?.drawn && groups.length > 0 && groups.every(group =>
      (group.matches || []).length >= Math.max(0, (group.participants || []).length * ((group.participants || []).length - 1) / 2) &&
      (group.matches || []).every(match => match.finished));
  }

  function stageForEvent() {
    const stages = current.stages || {};
    if (current.event.schedule === 'round-robin') return 'round_robin';
    if (current.event.schedule === 'knockout') return 'knockout';
    const complete = isGroupComplete(stages.group);
    return current.requestedStage === 'group' ? 'group' : complete ? 'knockout' : 'group';
  }

  function renderEvent() {
    const { competition, event, stages = {} } = current;
    const stage = stageForEvent();
    current.stage = stage;
    const complete = isGroupComplete(stages.group);
    const tabs = event.schedule === 'group-knockout' ? `<div class="schedule-tabs" role="tablist" aria-label="赛程阶段">
      <a class="schedule-tab${stage === 'group' ? ' active' : ''}" role="tab" aria-selected="${stage === 'group'}" href="${attr(routeEvent(competition.slug, event.slug, 'group'))}">小组赛</a>
      ${complete ? `<a class="schedule-tab${stage === 'knockout' ? ' active' : ''}" role="tab" aria-selected="${stage === 'knockout'}" href="${attr(routeEvent(competition.slug, event.slug, 'knockout'))}">淘汰赛</a>` : '<button class="schedule-tab locked" type="button" disabled title="小组赛结束后开放">淘汰赛 · 待解锁</button>'}</div>` : '';
    const stageData = stages[stage];
    let body = empty('赛程准备中', '该阶段尚未建立。');
    if (stageData && stage === 'round_robin') body = renderRoundRobinStage(stageData);
    if (stageData && stage === 'group') body = renderGroupStage(stageData);
    if (stageData && stage === 'knockout') body = renderKnockoutStage(stageData);
    const drawButton = admin && (stage === 'group' || stage === 'knockout') && stageData && (stage !== 'knockout' || event.schedule !== 'group-knockout' || complete) ?
      `<button class="button primary" data-action="draw" data-stage="${stage}">${stageData.data?.drawn ? '重新抽签' : '抽签'}</button>` : '';
    shell(`${breadcrumbs([{ text: competition.name, href: routeCompetition(competition.slug) }, { text: eventName(event) }])}
      <div class="event-heading"><div><div class="eyebrow">EVENT</div><h1>${esc(competition.name)} <span style="color:var(--brand)">·</span> ${esc(eventName(event))}</h1>
      <p class="lead">${esc(label[event.schedule] || event.schedule)}</p>${tabs}</div></div>
      <div class="stage-toolbar"><div class="stage-summary"><strong>${esc(label[stage])}</strong>　${stage === 'group' ? '各组排名与出线名单' : stage === 'knockout' ? '对阵与晋级路线' : '选手与对阵成绩'}</div>
      <div class="section-actions">${drawButton}</div></div>${body}`, `${eventName(event)} · ${competition.name}`);
  }

  function participantName(participant) {
    const person = participant && typeof participant === 'object' ? participant : { kind: 'undecided' };
    if (person.kind === 'bye') return '轮空';
    if (person.kind === 'undecided') return '未确定';
    if (person.kind === 'team') return person.team || person.members?.join(' / ') || '团体';
    if (person.kind === 'pair') return (person.members || []).join(' / ') || '组合';
    return person.members?.[0] || person.name || '选手';
  }

  function participantClickable(participant) {
    return !!participant && !['undecided', 'bye'].includes(participant.kind);
  }

  function participantButton(participant, extraClass = '') {
    return `<button type="button" class="person-link ${extraClass}" ${participantClickable(participant) ? `data-action="participant" data-person="${attr(JSON.stringify(participant))}"` : 'disabled'}>${esc(participantName(participant))}</button>`;
  }

  function bigScore(match) {
    let a = 0, b = 0;
    for (const game of match?.games || []) {
      if (!hasCompleteGameScore(game)) continue;
      if (Number(game[0]) > Number(game[1])) a++;
      if (Number(game[1]) > Number(game[0])) b++;
    }
    return [a, b];
  }

  function hasCompleteGameScore(game) {
    return Array.isArray(game) && game[0] !== null && game[1] !== null &&
      game[0] !== undefined && game[1] !== undefined && game[0] !== '' && game[1] !== '' &&
      Number.isFinite(Number(game[0])) && Number.isFinite(Number(game[1]));
  }

  function hasScoredGame(match) {
    return (match?.games || []).some(hasCompleteGameScore);
  }

  function rankingOpen(id) {
    return rankingVisibility.get(id) !== false;
  }

  function rankingPanel(id, title, subtitle, table, extraClass = '') {
    return `<details class="panel ranking-panel ${extraClass}" data-ranking-id="${attr(id)}" ${rankingOpen(id) ? 'open' : ''}>
      <summary class="panel-header ranking-summary"><h2>${esc(title)}</h2><span class="ranking-summary-right"><span class="panel-subtitle">${esc(subtitle)}</span><span class="ranking-chevron" aria-hidden="true"></span></span></summary>
      <div class="panel-body">${table}</div></details>`;
  }

  function rankingToggle(id) {
    const open = rankingOpen(id);
    return `<button class="ranking-toggle" type="button" data-action="toggle-rank" data-ranking-id="${attr(id)}" aria-controls="${attr(id)}-table" aria-expanded="${open}" aria-label="${open ? '收起' : '展开'}排名">${open ? '收起排名' : '展开排名'}</button>`;
  }

  function winnerForMatch(match, participantA, participantB) {
    if (participantA?.kind === 'bye') return participantB;
    if (participantB?.kind === 'bye') return participantA;
    if (!match?.finished) return { kind: 'undecided', members: [], team: '' };
    const [a, b] = bigScore(match);
    if (a === b) return { kind: 'undecided', members: [], team: '' };
    return a > b ? participantA : participantB;
  }

  function rankRoundRobin(participants, matches) {
    const count = participants.length;
    const expected = count * (count - 1) / 2;
    if (matches.length < expected || !matches.every(match => match.finished)) return null;
    const records = [];
    for (const match of matches) {
      const { a, b } = match;
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 ||
          a >= count || b >= count || a === b) continue;
      let gamesA = 0, gamesB = 0, pointsA = 0, pointsB = 0;
      for (const game of match.games || []) {
        if (!hasCompleteGameScore(game)) continue;
        const scoreA = Number(game[0]), scoreB = Number(game[1]);
        if (scoreA > scoreB) gamesA++;
        if (scoreB > scoreA) gamesB++;
        pointsA += scoreA;
        pointsB += scoreB;
      }
      const winner = gamesA > gamesB ? a : gamesB > gamesA ? b : null;
      records.push({ a, b, winner, gamesA, gamesB, pointsA, pointsB });
    }

    const totals = eligible => {
      const scores = Array.from({ length: count }, () => [0, 0, 0]);
      for (const { a, b, winner, gamesA, gamesB, pointsA, pointsB } of records) {
        if (!eligible.has(a) || !eligible.has(b)) continue;
        if (winner !== null) scores[winner][0]++;
        scores[a][1] += gamesA;
        scores[b][1] += gamesB;
        scores[a][2] += pointsA;
        scores[b][2] += pointsB;
      }
      return scores;
    };
    const compareTotals = (left, right) => right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
    const sameTotals = (left, right) => left.every((value, i) => value === right[i]);
    const names = participants.map(person => person?.kind === 'team' ? String(person.team ?? '') :
      (person?.members || []).map(String).join(' / '));
    const compareNames = (left, right) => {
      const a = Array.from(left, char => char.codePointAt(0));
      const b = Array.from(right, char => char.codePointAt(0));
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
      }
      return a.length - b.length;
    };

    const overall = totals(new Set(Array.from({ length: count }, (_, i) => i)));
    const byOverall = Array.from({ length: count }, (_, i) => i)
      .sort((a, b) => compareTotals(overall[a], overall[b]));
    const order = [];
    for (let start = 0; start < count;) {
      let end = start + 1;
      while (end < count && sameTotals(overall[byOverall[start]], overall[byOverall[end]])) end++;
      const tied = byOverall.slice(start, end);
      if (tied.length > 1) {
        const direct = totals(new Set(tied));
        tied.sort((a, b) => compareTotals(direct[a], direct[b]) ||
          compareNames(names[a], names[b]) || a - b);
      }
      order.push(...tied);
      start = end;
    }
    const rank = Array(count);
    order.forEach((index, position) => { rank[index] = position + 1; });
    return rank;
  }

  function findMatrixMatch(matches, a, b) {
    return matches.find(match => (match.a === a && match.b === b) || (match.a === b && match.b === a));
  }

  function renderRoundRobinTable(participants, matches, qualifiers = 0, rankingId = 'round-robin-rank') {
    const rank = rankRoundRobin(participants, matches);
    const rankColumn = `data-rank-column="${attr(rankingId)}" ${rankingOpen(rankingId) ? '' : 'hidden'}`;
    const rosterRows = participants.map((person, i) => `<tr><td>${i + 1}</td><td class="${rank && rank[i] <= qualifiers ? 'qualifier' : ''}">${participantButton(person)}</td><td ${rankColumn}>${rank ? rank[i] : ''}</td></tr>`).join('');
    const header = participants.map((_, i) => `<th scope="col">${i + 1}</th>`).join('');
    const rows = participants.map((_, i) => {
      const cells = participants.map((__, j) => {
        if (i === j) return '<td class="self" aria-label="同一选手"></td>';
        const match = findMatrixMatch(matches, i, j);
        if (!match) return '<td>—</td>';
        const [a, b] = bigScore(match);
        const score = match.a === i ? `${a}:${b}` : `${b}:${a}`;
        const text = hasScoredGame(match) ? score : '···';
        const state = match.finished ? '' : hasScoredGame(match) ? ' live' : ' pending';
        return `<td class="match-cell${match.finished ? ' finished' : ''}"><button type="button" class="score-button${state}" data-action="match" data-match-id="${attr(match.id)}" aria-label="查看 ${i + 1} 对 ${j + 1} 的场次">${text}</button></td>`;
      }).join('');
      return `<tr><th scope="row">${i + 1}</th>${cells}</tr>`;
    }).join('');
    return `<div class="round-robin-layout"><div><div class="table-section-title"><span>选手列表</span>${rankingToggle(rankingId)}</div>
      <div class="table-wrap"><table id="${attr(rankingId)}-table" class="data-table roster-table ranked-roster"><thead><tr><th scope="col">#</th><th scope="col">选手</th><th scope="col" ${rankColumn}>排名</th></tr></thead><tbody>${rosterRows}</tbody></table></div></div>
      <div><div class="table-section-title"><span>对阵图</span></div><div class="table-wrap matrix-wrap"><table class="data-table matrix-table"><thead><tr><th></th>${header}</tr></thead><tbody>${rows}</tbody></table></div></div></div>`;
  }

  function renderRoundRobinStage(stage) {
    const participants = stage.data?.participants || stage.metadata?.entrants?.map(entry => entry.participant) || [];
    const matches = stage.data?.matches || [];
    return `<section class="panel"><div class="panel-header"><h2>循环赛</h2><span class="panel-subtitle">${participants.length} 位选手 · ${matches.length} 场比赛</span></div>
      <div class="panel-body">${participants.length ? renderRoundRobinTable(participants, matches, 0, `${current.competition.slug}-${current.event.slug}-round-robin`) : empty('暂无选手', '请添加包含选手名单的项目。')}</div></section>`;
  }

  function renderGroupStage(stage) {
    const groups = stage.data?.groups || [];
    const finished = isGroupComplete(stage);
    const panels = groups.map((group, index) => {
      const participants = group.participants || [];
      const matches = group.matches || [];
      const groupId = group.id ?? index + 1;
      return `<section class="panel"><div class="panel-header"><div class="group-heading"><h2>小组 #${esc(groupId)}</h2>
        <div class="group-schedule"><span>预定时间：${esc(group.scheduled_time || '待定')}</span><span>预定桌号：${esc(group.scheduled_table || '待定')}</span></div></div>
        <div class="group-header-actions"><span class="panel-subtitle">出线 ${esc(group.qualifiers ?? 0)} 人 · ${matches.filter(match => match.finished).length}/${matches.length} 场已完成</span>
        ${admin ? `<button class="button secondary small" type="button" data-action="edit-group-schedule" data-group-id="${attr(groupId)}">${icon.edit} 设置预定安排</button>` : ''}</div></div>
        <div class="panel-body">${renderRoundRobinTable(participants, matches, group.qualifiers || 0, `${current.competition.slug}-${current.event.slug}-group-${group.id ?? index + 1}`)}</div></section>`;
    }).join('');
    const qualifierNames = finished ? groups.flatMap((group, index) => {
      const rank = rankRoundRobin(group.participants || [], group.matches || []);
      return rank ? (group.participants || []).flatMap((person, i) => rank[i] <= group.qualifiers ? [{ person, group: group.id ?? index + 1, groupIndex: index, rank: rank[i] }] : []) : [];
    }) : [];
    qualifierNames.sort((a, b) => a.groupIndex - b.groupIndex || a.rank - b.rank);
    const qualifierTable = `<div class="table-wrap"><table class="data-table qualifier-table"><thead><tr><th scope="col">小组</th><th scope="col">选手</th><th scope="col">出线名次</th></tr></thead>
        <tbody>${qualifierNames.map(item => `<tr><td>小组 #${esc(item.group)}</td><td>${participantButton(item.person)}</td><td>${item.rank}</td></tr>`).join('')}</tbody></table></div>`;
    return `<div class="stage-stack">${finished ? rankingPanel(`${current.competition.slug}-${current.event.slug}-qualifiers`, '小组出线名单', `${qualifierNames.length} 位选手出线`, qualifierTable, 'qualifier-panel') : ''}
      ${groups.length ? panels : empty('小组尚未抽签', admin ? '点击“抽签”分配选手到各小组。' : '抽签完成后会显示对阵信息。')}</div>`;
  }

  function findCurrentMatch(matchId) {
    const stage = current?.stages?.[current.stage];
    if (!stage) return null;
    if (current.stage === 'group') {
      for (const group of stage.data?.groups || []) {
        const match = (group.matches || []).find(item => item.id === matchId);
        if (match) return { match, participants: group.participants || [] };
      }
      return null;
    }
    const match = (stage.data?.matches || []).find(item => item.id === matchId) ||
      (current.stage === 'knockout' && stage.data?.bronze_match?.id === matchId ? stage.data.bronze_match : null);
    return match ? { match, participants: stage.data?.participants || [] } : null;
  }

  function bracketScore(match) {
    if (!match) return '···';
    const [a, b] = bigScore(match);
    return hasScoredGame(match) ? `${a}:${b}` : '···';
  }

  function renderBracketCard(node, champion = false) {
    const person = node.person || { kind: 'undecided', members: [], team: '' };
    const clickable = participantClickable(person);
    const title = champion ? '冠军 · ' : '';
    return `<div class="bracket-card${champion ? ' champion' : ''}${clickable ? ' interactive' : ''}" 
      style="left:${node.x}px;top:${node.y - 22}px;width:${node.width}px" 
      ${clickable ? `role="button" tabindex="0" data-action="participant" data-person="${attr(JSON.stringify(person))}"` : ''}
      title="${attr(participantName(person))}"><span class="name">${title}${esc(participantName(person))}</span></div>`;
  }

  function renderKnockoutStage(stage) {
    const rounds = Math.max(1, Number(stage.data?.rounds) || 1);
    const count = 2 ** rounds;
    const half = count / 2;
    const cardWidth = 150, gapX = 76, marginX = 24, centerGap = 190;
    const width = 2 * (marginX + (rounds - 1) * (cardWidth + gapX) + cardWidth) + centerGap;
    const bronzeMatch = stage.data?.bronze_match;
    const height = Math.max(bronzeMatch ? 500 : 340, 100 + (half - 1) * 72);
    const leafTop = (height - (half - 1) * 72) / 2;
    const undecided = { kind: 'undecided', members: [], team: '' };
    const slots = stage.data?.drawn ? stage.data.slots || [] : [];
    const matches = stage.data?.matches || [];
    const matchMap = new Map(matches.map(match => [`${Number(match.round)}:${Number(match.index)}`, match]));
    const sides = [];
    const cards = [];
    const lines = [];
    const buttons = [];

    for (const side of ['left', 'right']) {
      const offset = side === 'left' ? 0 : half;
      const xAt = level => side === 'left' ? marginX + level * (cardWidth + gapX) : width - marginX - cardWidth - level * (cardWidth + gapX);
      let nodes = Array.from({ length: half }, (_, i) => ({
        x: xAt(0), y: leafTop + i * 72, width: cardWidth, person: slots[offset + i] || undecided
      }));
      nodes.forEach(node => cards.push(renderBracketCard(node)));
      for (let level = 1; level < rounds; level++) {
        const next = [];
        for (let j = 0; j < nodes.length; j += 2) {
          const first = nodes[j], second = nodes[j + 1];
          const matchIndex = offset / (2 ** level) + j / 2;
          const match = matchMap.get(`${level - 1}:${matchIndex}`);
          const parent = { x: xAt(level), y: (first.y + second.y) / 2, width: cardWidth,
            person: winnerForMatch(match, first.person, second.person) };
          const childEdge = side === 'left' ? first.x + cardWidth : first.x;
          const parentEdge = side === 'left' ? parent.x : parent.x + cardWidth;
          const junction = (childEdge + parentEdge) / 2;
          for (const child of [first, second]) {
            lines.push(`<path class="bracket-line" d="M ${side === 'left' ? child.x + cardWidth : child.x} ${child.y} H ${junction} V ${parent.y} H ${parentEdge}"/>`);
          }
          if (match) buttons.push(`<button class="bracket-match${match.finished ? ' finished' : hasScoredGame(match) ? ' live' : ''}" 
            style="left:${junction - 21}px;top:${parent.y - 14}px" data-action="match" data-match-id="${attr(match.id)}" 
            aria-label="查看第 ${level} 轮场次">${bracketScore(match)}</button>`);
          next.push(parent);
          cards.push(renderBracketCard(parent));
        }
        nodes = next;
      }
      sides.push(nodes[0]);
    }

    const [left, right] = sides;
    const finalMatch = matchMap.get(`${rounds - 1}:0`);
    const champion = { x: width / 2 - cardWidth / 2, y: height / 2, width: cardWidth,
      person: winnerForMatch(finalMatch, left.person, right.person) };
    lines.push(`<path class="bracket-line" d="M ${left.x + cardWidth} ${left.y} H ${champion.x}"/>`);
    lines.push(`<path class="bracket-line" d="M ${right.x} ${right.y} H ${champion.x + cardWidth}"/>`);
    cards.push(renderBracketCard(champion, true));
    if (finalMatch) buttons.push(`<button class="bracket-match${finalMatch.finished ? ' finished' : hasScoredGame(finalMatch) ? ' live' : ''}" 
      style="left:${width / 2 - 21}px;top:${height / 2 + 33}px" data-action="match" data-match-id="${attr(finalMatch.id)}" 
      aria-label="查看决赛场次">${bracketScore(finalMatch)}</button>`);

    const bronze = bronzeMatch ? `<div class="bronze-fixture" style="left:${width / 2 - 85}px;top:${height / 2 + 83}px">
      <div class="bronze-title">铜牌赛</div>
      <div class="bronze-person">${participantButton(bronzeMatch.a)}</div>
      <button class="bracket-match bronze-score${bronzeMatch.finished ? ' finished' : hasScoredGame(bronzeMatch) ? ' live' : ''}"
        type="button" data-action="match" data-match-id="${attr(bronzeMatch.id)}" aria-label="查看铜牌赛场次">${bracketScore(bronzeMatch)}</button>
      <div class="bronze-person">${participantButton(bronzeMatch.b)}</div></div>` : '';
    const results = stage.data?.results;
    const resultsTable = `<div class="table-wrap"><table class="data-table knockout-results-table">
      <thead><tr><th scope="col">名次</th><th scope="col">选手</th></tr></thead>
      <tbody>${Array.isArray(results) ? results.map(item => `<tr><td>${esc(item.rank)}</td><td>${esc(participantName(item.participant))}</td></tr>`).join('') : ''}</tbody>
      </table></div>`;
    const resultsPanel = Array.isArray(results) && results.length ? rankingPanel(`${current.competition.slug}-${current.event.slug}-knockout-results`, '比赛结果', `前 ${results.length} 名`, resultsTable, 'knockout-results') : '';
    return `<div class="stage-stack">${resultsPanel}<div><div class="bracket-scroll"><div class="bracket-canvas" style="width:${width}px;height:${height}px">
      <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${lines.join('')}</svg>${cards.join('')}${buttons.join('')}${bronze}</div></div>
      <div class="bracket-legend"><span><i></i>选手 / 晋级位置</span><span><i class="winner"></i>冠军</span><span>点击比分查看场次详情</span></div></div></div>`;
  }

  function openModal(title, body, footer = '', subtitle = '', wide = false) {
    modalRoot.innerHTML = `<div class="modal-overlay" data-overlay><section class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-header"><div><h2 id="modal-title">${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
      <button class="icon-button" type="button" data-action="close-modal" aria-label="关闭弹窗">${icon.close}</button></div>
      <div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}</section></div>`;
    document.body.style.overflow = 'hidden';
    modalRoot.querySelector('.modal button, .modal input, .modal select')?.focus();
  }

  function closeModal() {
    flushVisibleGameRows();
    const closing = modalState;
    const routeAtClose = location.hash;
    modalRoot.innerHTML = '';
    modalState = null;
    document.body.style.overflow = '';
    if (closing?.type === 'match' && closing.scoreEdited) {
      void waitForGameSaves(closing.path).then(() => {
        if (location.hash === routeAtClose && !modalRoot.firstChild && current?.page === 'event') {
          scoreQueues.delete(closing.path);
          return refreshCurrentEvent(closing.stage);
        }
      }).catch(error => {
        scoreQueues.delete(closing.path);
        toast(`局分保存失败：${error.message}`, true);
        if (location.hash === routeAtClose && !modalRoot.firstChild && current?.page === 'event') {
          void refreshCurrentEvent(closing.stage).catch(refreshError => toast(refreshError.message, true));
        }
      });
    }
  }

  function modalError(message) {
    const body = modalRoot.querySelector('.modal-body');
    if (!body) return;
    body.querySelector('.form-error')?.remove();
    body.insertAdjacentHTML('afterbegin', `<div class="form-error" role="alert">${esc(message)}</div>`);
  }

  function confirmation(title, message, confirmText, callback) {
    modalState = { type: 'confirm', callback };
    openModal(title, `<p class="danger-copy">${esc(message)}</p>`,
      `<button class="button secondary" type="button" data-action="close-modal">取消</button>
      <button class="button danger" type="button" data-action="confirm">${esc(confirmText)}</button>`);
  }

  function showCompetitionForm(competition = null) {
    modalState = { type: 'competition', slug: competition?.slug || null };
    const edit = !!competition;
    openModal(edit ? '编辑赛事' : '添加赛事', `<form id="competition-form" data-form="competition">
      <div class="field"><label for="competition-name">赛事名称</label><input id="competition-name" name="name" required maxlength="120" value="${attr(competition?.name || '')}" placeholder="例如：北京大学秋季乒乓球赛"></div>
      <div class="field-row"><div class="field"><label for="competition-start">开始日期</label><input id="competition-start" name="start_date" type="date" required value="${attr(competition?.start_date || '')}"></div>
      <div class="field"><label for="competition-end">结束日期</label><input id="competition-end" name="end_date" type="date" required value="${attr(competition?.end_date || '')}"></div></div>
      <div class="field"><label for="competition-venue">比赛地点</label><input id="competition-venue" name="venue" required maxlength="120" value="${attr(competition?.venue || '')}" placeholder="例如：邱德拔体育馆"></div>
      </form>`, `<button class="button secondary" type="button" data-action="close-modal">取消</button>
      <button class="button primary" type="submit" form="competition-form">${edit ? '保存修改' : '创建赛事'}</button>`);
  }

  function showEventForm() {
    modalState = { type: 'event' };
    openModal('添加项目', `<form id="event-form" data-form="event">
      <div class="field-row"><div class="field"><label for="event-discipline">参赛组别</label><select id="event-discipline" name="discipline" required>
      <option value="men">男子</option><option value="women">女子</option><option value="mixed">混合</option></select></div>
      <div class="field"><label for="event-format">比赛形式</label><select id="event-format" name="format" required>
      <option value="single">单打</option><option value="double">双打</option><option value="team">团体</option></select></div></div>
      <div class="field"><label for="event-schedule">赛程</label><select id="event-schedule" name="schedule" required>
      <option value="group-knockout">小组赛 - 淘汰赛</option><option value="knockout">淘汰赛</option><option value="round-robin">循环赛</option></select></div>
      <div class="field"><label for="event-csv">选手名单（CSV）</label><input id="event-csv" name="csv_file" type="file" accept=".csv,text/csv" required>
      <span class="field-help">单打：姓名、队伍、种子级别；双打：选手1、选手2、队伍、种子级别；团体：队伍、种子级别、成员1…。种子级别填写 0 或正整数，数字越大优先级越高。</span></div>
      <div class="field" data-group-field><label for="event-groups">小组规格</label><input id="event-groups" name="group_spec" placeholder="例如：2*4(2) + 2*3(1)">
      <span class="field-help">组数 × 每组人数（每组出线人数）</span></div>
      <div class="field" data-rounds-field><label for="event-rounds">淘汰赛轮数</label><input id="event-rounds" name="knockout_rounds" type="number" min="1" max="10" step="1" placeholder="例如：3"></div>
      </form>`, `<button class="button secondary" type="button" data-action="close-modal">取消</button>
      <button class="button primary" type="submit" form="event-form">创建项目</button>`, '项目创建后，组别、形式和赛程不能修改。', true);
    updateEventFields();
  }

  function updateEventFields() {
    const form = modalRoot.querySelector('#event-form');
    if (!form) return;
    const schedule = form.elements.schedule.value;
    form.querySelector('[data-group-field]').hidden = schedule !== 'group-knockout';
    form.querySelector('[data-rounds-field]').hidden = schedule === 'round-robin';
    form.elements.group_spec.required = schedule === 'group-knockout';
    form.elements.knockout_rounds.required = schedule !== 'round-robin';
  }

  function showParticipant(participant) {
    if (!participantClickable(participant)) return;
    const name = participantName(participant);
    const content = participant.kind === 'team' ?
      `<dl class="detail-list"><div><dt>团体成员</dt><dd>${esc((participant.members || []).join('、') || '暂无成员信息')}</dd></div></dl>` :
      `<dl class="detail-list"><div><dt>队伍</dt><dd>${esc(participant.team || '未填写')}</dd></div></dl>`;
    modalState = { type: 'participant' };
    openModal(name, content, `<button class="button secondary" type="button" data-action="close-modal">关闭</button>`, participant.kind === 'team' ? '参赛团体' : participant.kind === 'pair' ? '双打组合' : '参赛选手');
  }

  function showGroupSchedule(groupId) {
    const group = (current?.stages?.group?.data?.groups || []).find(item => String(item.id) === String(groupId));
    if (!group) return toast('找不到该小组。', true);
    modalState = { type: 'group-schedule', groupId: group.id };
    const body = `<form id="group-schedule-form" data-form="group-schedule">
      <div class="field-row"><div class="field"><label for="group-scheduled-time">预定时间</label><input id="group-scheduled-time" name="scheduled_time" value="${attr(group.scheduled_time || '')}" placeholder="例如：14:30"></div>
      <div class="field"><label for="group-scheduled-table">预定桌号</label><input id="group-scheduled-table" name="scheduled_table" value="${attr(group.scheduled_table || '')}" placeholder="例如：3"></div></div>
      <p class="field-help">保存会将预定时间和预定桌号覆盖到本组所有场次的时间和桌号；留空会清除对应安排。单独修改场次的实际时间或桌号不会改变小组的预定安排。</p></form>`;
    openModal(`小组 #${group.id} · 预定安排`, body,
      '<button class="button secondary" type="button" data-action="close-modal">取消</button><button class="button primary" type="submit" form="group-schedule-form">保存预定安排</button>');
  }

  function matchParticipants(match, participants) {
    const a = Number.isInteger(match.a) ? participants[match.a] : match.a;
    const b = Number.isInteger(match.b) ? participants[match.b] : match.b;
    return [a || { kind: 'undecided' }, b || { kind: 'undecided' }];
  }

  function gamePath(matchId) {
    return `${apiPath(current.competition.slug, current.event.slug, current.stage, matchId)}/games`;
  }

  function sameGameScore(a, b) {
    return a[0] === b[0] && a[1] === b[1];
  }

  function nullableScore(input) {
    if (!input.checkValidity()) throw new Error('局分请输入 0 到 99 的整数，或留空。');
    const value = input.value.trim();
    return value === '' ? null : Number(value);
  }

  function gameSaveStatus(path, index, message, isError = false) {
    if (modalState?.type !== 'match' || modalState.path !== path) return;
    const row = [...modalRoot.querySelectorAll('[data-game-row]')].find(item => Number(item.dataset.gameRow) === index);
    const status = row?.querySelector('.game-save-status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  function syncMatchCompletion(path, matchId) {
    if (modalState?.type !== 'match' || modalState.path !== path) return;
    const match = findCurrentMatch(matchId)?.match;
    if (!match) return;
    const [a, b] = bigScore(match);
    if (!hasScoredGame(match) || a === b) match.finished = false;
    const status = modalRoot.querySelector('[data-match-finished-status]');
    if (status) status.textContent = match.finished ? '已结束' : '未结束';
    const checkbox = modalRoot.querySelector('[data-form="match-meta"] input[name="finished"]');
    if (checkbox) checkbox.checked = !!match.finished;
  }

  function runGameQueue(state, index, queue) {
    if (queue.running) return;
    queue.running = (async () => {
      while (!sameGameScore(queue.saved, queue.desired)) {
        const [a, b] = queue.desired;
        gameSaveStatus(state.path, index, '保存中…');
        try {
          await mutate('PATCH', `${state.path}/${index}`, { a, b });
        } catch (error) {
          queue.error = error;
          gameSaveStatus(state.path, index, '保存失败', true);
          toast(error.message, true);
          return;
        }
        queue.saved = [a, b];
        queue.error = null;
        syncMatchCompletion(state.path, state.matchId);
      }
      gameSaveStatus(state.path, index, '已保存');
    })().finally(() => {
      queue.running = null;
      if (!queue.error && !sameGameScore(queue.saved, queue.desired)) runGameQueue(state, index, queue);
    });
  }

  function saveGameRow(input) {
    if (!admin || modalState?.type !== 'match' || !input.matches('[data-game-side]')) return;
    const row = input.closest('[data-game-row]');
    if (!row) return;
    const index = Number(row.dataset.gameRow);
    const matchId = modalState.matchId;
    const path = modalState.path;
    const fields = [row.querySelector('[data-game-side="a"]'), row.querySelector('[data-game-side="b"]')];
    let desired;
    try {
      desired = fields.map(nullableScore);
    } catch (error) {
      gameSaveStatus(path, index, error.message, true);
      return;
    }
    const found = findCurrentMatch(matchId);
    if (!found?.match?.games?.[index]) return;
    let state = scoreQueues.get(path);
    if (!state) {
      state = { path, matchId, rows: new Map() };
      scoreQueues.set(path, state);
    }
    let queue = state.rows.get(index);
    if (!queue) {
      queue = { saved: [...found.match.games[index]], desired: [...found.match.games[index]], running: null, error: null };
      state.rows.set(index, queue);
    }
    if (sameGameScore(queue.desired, desired) && !queue.error) return;
    queue.desired = desired;
    queue.error = null;
    found.match.games[index] = desired;
    modalState.scoreEdited = true;
    const [a, b] = bigScore(found.match);
    const displayedScore = modalRoot.querySelector('.match-score');
    if (displayedScore) displayedScore.textContent = `${a} : ${b}`;
    runGameQueue(state, index, queue);
  }

  function flushVisibleGameRows() {
    if (!admin || modalState?.type !== 'match') return;
    for (const row of modalRoot.querySelectorAll('[data-game-row]')) {
      const input = row.querySelector('[data-game-side="a"]');
      if (input) saveGameRow(input);
    }
  }

  async function waitForGameSaves(path) {
    const state = scoreQueues.get(path);
    if (!state) return;
    for (;;) {
      const active = [...state.rows.values()].map(row => row.running).filter(Boolean);
      if (!active.length) break;
      await Promise.all(active);
    }
    const failed = [...state.rows.values()].find(row => row.error);
    if (failed) throw failed.error;
  }

  function showMatch(matchId) {
    const found = findCurrentMatch(matchId);
    if (!found) return toast('找不到该场次。', true);
    const { match, participants } = found;
    const [a, b] = matchParticipants(match, participants);
    const [scoreA, scoreB] = bigScore(match);
    modalState = { type: 'match', matchId, stage: current.stage, path: gamePath(matchId), scoreEdited: false, mutating: false };
    const games = admin ? match.games || [] : (match.games || []).filter(hasCompleteGameScore);
    const gameList = games.length ? `<ul class="game-list">${games.map((game, index) => `<li class="${admin ? 'game-row-admin' : ''}" data-game-row="${index}"><span class="game-number">第 ${index + 1} 局</span>
      ${admin ? `<div class="game-score-fields">
        <label class="game-score-field"><span>选手 A</span><input type="number" min="0" max="99" step="1" inputmode="numeric" data-game-side="a" aria-label="${attr(participantName(a))}第 ${index + 1} 局得分" value="${attr(game?.[0] ?? '')}"></label>
        <span class="game-score-separator" aria-hidden="true">:</span>
        <label class="game-score-field"><span>选手 B</span><input type="number" min="0" max="99" step="1" inputmode="numeric" data-game-side="b" aria-label="${attr(participantName(b))}第 ${index + 1} 局得分" value="${attr(game?.[1] ?? '')}"></label>
      </div><span class="game-save-status" role="status" aria-live="polite"></span>
      <button class="icon-button danger" type="button" data-action="delete-game" data-index="${index}" aria-label="删除第 ${index + 1} 局">${icon.trash}</button>` : `<strong>${esc(game[0])} : ${esc(game[1])}</strong>`}</li>`).join('')}</ul>` : '<div class="game-empty">暂无局分记录</div>';
    const metaForm = admin ? `<div class="modal-divider"></div><form data-form="match-meta">
      <div class="field-row"><div class="field"><label for="match-table">桌号</label><input id="match-table" name="table" value="${attr(match.table || '')}" placeholder="例如：3"></div>
      <div class="field"><label for="match-time">比赛时间</label><input id="match-time" name="time" value="${attr(match.time || '')}" placeholder="例如：14:30"></div></div>
      <div class="field"><label><input name="finished" type="checkbox" ${match.finished ? 'checked' : ''} style="width:auto;min-height:auto;margin-right:7px">本场次已结束</label>
      <span class="field-help">结束场次前请录入局分，且双方局数不能相同。</span></div>
      <button class="button secondary small" type="submit">保存场次信息</button></form>` : '';
    const body = `<div class="match-players"><div class="match-player">${esc(participantName(a))}</div><span class="match-vs">VS</span><div class="match-player">${esc(participantName(b))}</div></div>
      <div class="match-score">${scoreA} : ${scoreB}</div>
      <div class="match-details"><span>桌号：${esc(match.table || '待定')}</span><span>时间：${esc(match.time || '待定')}</span>
      <span data-match-finished-status>${match.finished ? '已结束' : '未结束'}</span></div>
      <div class="game-heading"><h3>各局比分</h3>${admin ? `<button class="button secondary small" type="button" data-action="add-game">${icon.plus} 添加一局</button>` : ''}</div>
      ${admin ? '<p class="game-help">修改后自动暂存；留空的局不计入比分，保存场次信息时会移除。</p>' : ''}
      ${gameList}${metaForm}`;
    openModal('场次详情', body, `<button class="button secondary" type="button" data-action="close-modal">关闭</button>`, `场次 ${match.id}`, true);
  }

  async function refreshCurrentEvent(stage = current.stage, matchId = null) {
    const slug = current.competition.slug;
    const eventSlug = current.event.slug;
    const data = await getJson(apiPath(slug, eventSlug));
    current = { page: 'event', ...data, requestedStage: stage };
    renderEvent();
    if (matchId) showMatch(matchId);
  }

  async function onAction(action, button) {
    if (action === 'close-modal') return closeModal();
    if (action === 'participant') return showParticipant(JSON.parse(button.dataset.person));
    if (action === 'match') return showMatch(button.dataset.matchId);
    if (action === 'toggle-rank') {
      const id = button.dataset.rankingId;
      const expanded = !rankingOpen(id);
      rankingVisibility.set(id, expanded);
      button.setAttribute('aria-expanded', String(expanded));
      button.setAttribute('aria-label', `${expanded ? '收起' : '展开'}排名`);
      button.textContent = expanded ? '收起排名' : '展开排名';
      for (const column of document.querySelectorAll('[data-rank-column]')) {
        if (column.dataset.rankColumn === id) column.hidden = !expanded;
      }
      return;
    }
    if (!admin) return;

    if (action === 'edit-group-schedule') return showGroupSchedule(button.dataset.groupId);
    if (action === 'add-competition') return showCompetitionForm();
    if (action === 'edit-competition') {
      const competition = current.competitions.find(item => item.slug === button.dataset.id);
      if (competition) showCompetitionForm(competition);
      return;
    }
    if (action === 'delete-competition') {
      const competition = current.competitions.find(item => item.slug === button.dataset.id);
      if (!competition) return;
      return confirmation('删除赛事', `将删除“${competition.name}”及其所有项目、阶段和比分。此操作无法撤销。`, '删除赛事', async () => {
        await mutate('DELETE', apiPath(competition.slug));
        await render();
        toast('赛事已删除。');
      });
    }
    if (action === 'add-event') return showEventForm();
    if (action === 'delete-event') {
      const event = current.events.find(item => item.slug === button.dataset.id);
      if (!event) return;
      return confirmation('删除项目', `将删除“${eventName(event)}”及其全部赛程与比分。此操作无法撤销。`, '删除项目', async () => {
        await mutate('DELETE', apiPath(current.competition.slug, event.slug));
        await render();
        toast('项目已删除。');
      });
    }
    if (action === 'draw') {
      const stage = button.dataset.stage;
      const perform = async () => {
        await mutate('POST', `${apiPath(current.competition.slug, current.event.slug, stage)}/draw`, {});
        await refreshCurrentEvent(stage);
        toast('抽签已完成。');
      };
      if (current.stages[stage]?.data?.drawn) {
        return confirmation('重新抽签', '重新抽签将改变本阶段的选手位置与对阵，并清除相关比分。', '重新抽签', perform);
      }
      try { await perform(); } catch (error) { toast(error.message, true); }
      return;
    }
    if (action === 'confirm' && modalState?.type === 'confirm') {
      const callback = modalState.callback;
      closeModal();
      try { await callback(); } catch (error) { toast(error.message, true); }
      return;
    }
    if (action === 'add-game' && modalState?.type === 'match') {
      const editing = modalState;
      if (editing.mutating) return;
      editing.mutating = true;
      button.disabled = true;
      try {
        flushVisibleGameRows();
        await waitForGameSaves(editing.path);
        const index = findCurrentMatch(editing.matchId)?.match?.games?.length ?? 0;
        await mutate('POST', editing.path, { a: null, b: null });
        scoreQueues.delete(editing.path);
        if (modalState === editing) {
          await refreshCurrentEvent(editing.stage, editing.matchId);
          modalRoot.querySelector(`[data-game-row="${index}"] [data-game-side="a"]`)?.focus();
        }
      } catch (error) { toast(error.message, true); }
      finally {
        editing.mutating = false;
        if (button.isConnected) button.disabled = false;
      }
      return;
    }
    if (action === 'delete-game' && modalState?.type === 'match') {
      const editing = modalState;
      if (editing.mutating) return;
      const gameIndex = Number(button.dataset.index);
      editing.mutating = true;
      button.disabled = true;
      try {
        flushVisibleGameRows();
        await waitForGameSaves(editing.path);
        await mutate('DELETE', `${editing.path}/${gameIndex}`);
        scoreQueues.delete(editing.path);
        if (modalState === editing) await refreshCurrentEvent(editing.stage, editing.matchId);
      } catch (error) { toast(error.message, true); }
      finally {
        editing.mutating = false;
        if (button.isConnected) button.disabled = false;
      }
      return;
    }
  }

  async function onSubmit(event) {
    const form = event.target;
    if (!form.dataset.form) return;
    event.preventDefault();
    if (!admin) return;
    const submitter = event.submitter;
    if (submitter) submitter.disabled = true;
    try {
      if (form.dataset.form === 'competition') {
        const body = {
          name: form.elements.name.value.trim(),
          start_date: form.elements.start_date.value,
          end_date: form.elements.end_date.value,
          venue: form.elements.venue.value.trim()
        };
        if (body.end_date < body.start_date) throw new Error('结束日期不能早于开始日期。');
        const editingSlug = modalState.slug;
        await mutate(editingSlug ? 'PATCH' : 'POST', editingSlug ? apiPath(editingSlug) : '/competitions', body);
        closeModal();
        await render();
        toast(editingSlug ? '赛事已更新。' : '赛事已创建。');
      } else if (form.dataset.form === 'event') {
        const file = form.elements.csv_file.files[0];
        if (!file) throw new Error('请上传选手名单 CSV 文件。');
        const body = {
          discipline: form.elements.discipline.value,
          format: form.elements.format.value,
          schedule: form.elements.schedule.value,
          csv: await readCsvText(file),
          group_spec: form.elements.schedule.value === 'group-knockout' ? form.elements.group_spec.value.trim() : '',
          knockout_rounds: form.elements.schedule.value === 'round-robin' ? null : Number(form.elements.knockout_rounds.value)
        };
        await mutate('POST', apiPath(current.competition.slug) + '/events', body);
        closeModal();
        await render();
        toast('项目已创建。');
      } else if (form.dataset.form === 'group-schedule' && modalState?.type === 'group-schedule') {
        const body = {
          scheduled_time: form.elements.scheduled_time.value.trim(),
          scheduled_table: form.elements.scheduled_table.value.trim()
        };
        await mutate('PATCH', `${apiPath(current.competition.slug, current.event.slug)}/groups/${encodeURIComponent(modalState.groupId)}`, body);
        closeModal();
        await refreshCurrentEvent('group');
        toast('小组预定安排已保存。');
      } else if (form.dataset.form === 'match-meta' && modalState?.type === 'match') {
        const editing = modalState;
        const matchId = editing.matchId;
        flushVisibleGameRows();
        await waitForGameSaves(editing.path);
        const body = {
          table: form.elements.table.value.trim() || null,
          time: form.elements.time.value.trim() || null,
          finished: form.elements.finished.checked
        };
        await mutate('PATCH', apiPath(current.competition.slug, current.event.slug, current.stage, matchId), body);
        scoreQueues.delete(editing.path);
        if (modalState === editing) await refreshCurrentEvent(editing.stage, matchId);
        toast('场次信息已保存。');
      }
    } catch (error) {
      modalError(error.message);
    } finally {
      if (submitter?.isConnected) submitter.disabled = false;
    }
  }

  document.addEventListener('click', event => {
    if (event.target.matches('[data-overlay]')) return closeModal();
    const button = event.target.closest('[data-action]');
    if (!button) return;
    event.preventDefault();
    void onAction(button.dataset.action, button);
  });
  document.addEventListener('submit', event => { void onSubmit(event); });
  document.addEventListener('change', event => {
    if (event.target.id === 'event-schedule') updateEventFields();
    if (event.target.matches('[data-game-side]')) saveGameRow(event.target);
  });
  document.addEventListener('focusout', event => {
    if (event.target.matches('[data-game-side]')) saveGameRow(event.target);
  });
  document.addEventListener('toggle', event => {
    const details = event.target;
    if (details.matches?.('details[data-ranking-id]')) rankingVisibility.set(details.dataset.rankingId, details.open);
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modalRoot.firstChild) closeModal();
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.bracket-card[data-action]')) {
      event.preventDefault();
      void onAction('participant', event.target);
    }
  });
  window.addEventListener('hashchange', () => { closeModal(); void render(); });
  void render();
})();
