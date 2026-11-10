'use strict';

const byId = id => document.getElementById(id);
const origins = {
  explicit: '原文明示', inferred: '整理推断', unknown: '原文未说明',
  'user-feedback': '用户补充', mixed: '原文与用户补充'
};
const tagLabels = {
  split: '需要拆分', rewrite: '需要重写', incorrect: '与实际不符',
  supplement: '补充说明', unknown: '暂时不知道'
};
const statusLabels = {
  pending: '已保存，待处理', applied: '已落实',
  'needs-clarification': '待澄清', 'left-open': '保留待确认'
};
const drawer = byId('drawer');
const selectionButton = byId('comment-selection');
let review;
let filter = 'all';
let drafts = [];
let draftRevision;
let batchId;
let saving = false;
let chosenSelection;
let drawerMode;
let feedbackGroupId;
let feedbackStep;
let noticeTimer;
let navigationFrame;
let saveError = '';
const openDisclosures = new Set();
const referenceSteps = new Map();
const referenceTargets = new Map();
const composerScratch = new Map();
let activeReference;
let retainComposer;
let linkedReview;
let linkedReturn;
let readingReturn;
let markedReadingPosition;
let activeStepSearch;
let drawerBackAction;
let reviewSync;
let availableRevision;
let updateComposerRevision;
const selectedChangeLocations = new Map();
const stepNumbers = new Map();

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function button(label, className, action) {
  const element = node('button', className, label);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function status(label, variant = '') {
  return node('span', ('label status ' + variant).trim(), label);
}

function announce(message) {
  clearTimeout(noticeTimer);
  byId('announcement').textContent = message;
  if (message) noticeTimer = setTimeout(() => { byId('announcement').textContent = ''; }, 4200);
}

function alertPage(message) {
  byId('page-alert').textContent = message;
  byId('page-alert').hidden = !message;
}

async function readReview() {
  const response = await fetch('/api/review', { cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || '暂时读不到审阅稿。请检查本地服务后重试。');
  }
  return response.json();
}

function placeVersionNotice() {
  const notice = byId('version-notice');
  if (drawer.open) byId('drawer-body').before(notice);
  else byId('page-alert').after(notice);
}

function showAvailableVersion(revision) {
  availableRevision = revision;
  byId('version-message').textContent = revision ? `第 ${revision} 轮已发布。当前阅读位置和未保存输入已保留。` : '';
  byId('version-notice').hidden = !revision;
  placeVersionNotice();
}

function hasReviewContext() {
  const selection = window.getSelection();
  return saving || drawer.open || drafts.length > 0 || composerScratch.size > 0 || !!readingReturn ||
    (selection && !selection.isCollapsed) ||
    !!document.activeElement?.matches('input, textarea, [contenteditable="true"]');
}

async function loadReview({ announceResult = false, automatic = false } = {}) {
  const refreshButton = byId('refresh-review');
  refreshButton.disabled = true;
  byId('read-available-version').disabled = true;
  try {
    const next = await readReview();
    const opening = !review;
    const changed = review && review.revision !== next.revision;
    // The reader may start typing while the review request is in flight.
    if (automatic && changed && hasReviewContext()) {
      showAvailableVersion(next.revision);
      return false;
    }
    retainComposer?.();
    review = next;
    if (!availableRevision || review.revision >= availableRevision) showAvailableVersion();
    alertPage('');
    render();
    if (opening) revealAnchor();
    if (changed) {
      activeStepSearch = undefined;
      linkedReturn = undefined;
      clearReadingReturn();
      if (drawer.open && ['composer', 'linked-composer'].includes(drawerMode)) {
        // Keep the actual textarea and its old target, even for an explicit refresh.
        linkedReview = undefined;
        drawerMode = 'composer';
        drawer.dataset.mode = drawerMode;
        drawer.removeAttribute('data-linked');
        byId('linked-step-navigation').hidden = true;
        setDrawerBack('返回批注列表', () => openFeedback());
        updateComposerRevision?.();
      } else if (drawer.open && (linkedReview || drawerMode === 'linked-picker')) drawer.close();
    }
    if (drawer.open && isFeedbackDrawer()) renderFeedback();
    if (drawer.open && drawerMode === 'references') {
      const reference = referenceSteps.get(activeReference?.stepId);
      if (reference) openReferences(reference);
      else drawer.close();
    }
    if (drawer.open && drawerMode.startsWith('linked-')) {
      if (changed) drawer.close();
      else if (drawerMode === 'linked-step') renderLinkedStep({ scroll: byId('drawer-body').scrollTop });
    }
    if (announceResult) announce(changed ? `已读取第 ${review.revision} 轮` : '已读取当前稿件与批注');
    return true;
  } catch (error) {
    alertPage(error.message);
    return false;
  } finally {
    refreshButton.disabled = false;
    byId('read-available-version').disabled = false;
  }
}

async function refresh(options) {
  while (reviewSync) await reviewSync;
  const request = loadReview(options);
  reviewSync = request;
  try { return await request; }
  finally { if (reviewSync === request) reviewSync = undefined; }
}

async function checkForReviewUpdate() {
  if (!review || reviewSync || saving || document.hidden) return;
  const request = (async () => {
    try {
      const response = await fetch('/api/version', { cache: 'no-store' });
      if (!response.ok) return;
      const { revision } = await response.json();
      if (!Number.isSafeInteger(revision) || revision <= review.revision) return;
      if (hasReviewContext()) showAvailableVersion(revision);
      else await loadReview({ automatic: true, announceResult: true });
    } catch { /* A background check never interrupts reading; retry on the next tick. */ }
  })();
  reviewSync = request;
  try { await request; }
  finally { if (reviewSync === request) reviewSync = undefined; }
}

const pad = value => String(value).padStart(2, '0');
const isOpen = item => item.type === 'issue' && item.status === 'open';
const allComments = () => (review.batches ?? []).flatMap(batch => batch.comments);
const isPendingComment = comment => !comment.outcome || comment.outcome.status === 'needs-clarification';
const pendingComments = () => allComments().filter(isPendingComment);
const pendingCount = () => pendingComments().length;
const currentResults = () => allComments().filter(comment => !isPendingComment(comment) && comment.outcome.revision === review.revision);
const findGroup = groupId => review.groups.find(group => group.id === groupId);
const groupAnchor = groupId => '#group-' + groupId;
const itemAnchor = itemId => '#item-' + itemId;
const isProcess = () => review.layout === 'process';
function indexStepNumbers() {
  stepNumbers.clear();
  if (!isProcess()) return;
  const first = firstReadingStep(review.groups);
  review.groups.forEach((group, index) => {
    if (group.unplaced) return;
    const steps = group.items.filter(item => item.type === 'node');
    const start = steps.findIndex(item => item.id === first);
    if (start > 0) steps.unshift(steps.splice(start, 1)[0]);
    steps.forEach((item, step) => stepNumbers.set(item.id, {
      number: `${index + 1}.${step + 1}`, tone: String(index % 6), groupId: group.id,
    }));
  });
}

function stepNumberBadge(itemId) {
  const position = stepNumbers.get(itemId);
  if (!position) return node('span');
  const badge = node('span', 'step-number', position.number);
  badge.dataset.stageTone = position.tone;
  badge.setAttribute('aria-label', '步骤 ' + position.number);
  return badge;
}
const uniqueChanges = changes => [...new Map((changes ?? []).map(change => [change.id, change])).values()];
const contentChanges = () => uniqueChanges(review.contentChanges);
const evidenceChanges = () => uniqueChanges(review.evidenceChanges);
const changesFor = group => contentChanges().filter(change => change.locations?.some(location => location.groupId === group.id));
const changeForItem = item => contentChanges().find(change => change.locations?.some(location => location.itemId === item.id));
const feedbackCountLabel = comments => {
  const unsaved = comments.filter(comment => drafts.includes(comment)).length;
  const waiting = comments.length - unsaved;
  return [waiting ? `${waiting} 条待处理` : '', unsaved ? `${unsaved} 条草稿` : ''].filter(Boolean).join(' · ');
};

// A text-only LCS keeps unchanged words in place. All fragments are DOM text
// nodes: annotations retain the exact UTF-16 text and selection offsets.
function changedTextParts(before, after) {
  const left = Array.from(before ?? '');
  const right = Array.from(after ?? '');
  const parts = { before: [], after: [] };
  const push = (side, text, changed) => {
    if (!text) return;
    const last = parts[side].at(-1);
    if (last?.changed === changed) last.text += text;
    else parts[side].push({ text, changed });
  };
  if (left.length * right.length > 1000000) {
    let start = 0, end = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) start++;
    while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
    for (const [side, chars] of [['before', left], ['after', right]]) {
      push(side, chars.slice(0, start).join(''), false);
      push(side, chars.slice(start, chars.length - end).join(''), true);
      push(side, chars.slice(chars.length - end).join(''), false);
    }
    return parts;
  }
  const matrix = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    matrix[i][j] = left[i] === right[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
  }
  let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      push('before', left[i++], false); push('after', right[j++], false);
    } else if (j < right.length && (i === left.length || matrix[i][j + 1] > matrix[i + 1][j])) push('after', right[j++], true);
    else push('before', left[i++], true);
  }
  return parts;
}

function fillChangedText(element, change, side = 'after') {
  const value = change[side] ?? '';
  element.replaceChildren();
  const parts = changedTextParts(change.before, change.after)[side];
  for (const part of parts) element.append(part.changed ? node('mark', side === 'before' ? 'change-removed-text' : 'change-added-text', part.text) : part.text);
  // Never add a label inside the selectable source text.
  if (element.textContent !== value) element.textContent = value;
}

function decorateChangedItem(container, text, item) {
  const change = changeForItem(item);
  if (!change || change.kind === 'removed') return;
  container.dataset.changeKind = change.kind;
  container.dataset.changeId = change.id;
  if (change.after === item.text && !text.querySelector('a')) fillChangedText(text, change);
  const meta = node('div', 'item-change-meta');
  meta.append(node('span', 'change-tag', change.kind === 'added' ? '新增' : '已修改'));
  meta.append(button('核对修改', 'text-button', () => showChangeReview(change.id)));
  container.append(meta);
}

function openIssueLocations(groups) {
  const locations = new Map();
  for (const group of groups) {
    for (const item of group.items.filter(isOpen)) {
      const identity = item.canonicalItemId || item.id;
      if (!locations.has(identity) || item.id === identity) locations.set(identity, { group, item });
    }
  }
  return [...locations.values()];
}

function revealAnchor() {
  if (!/^#(?:group|item)-/.test(location.hash)) return;
  const anchor = location.hash.slice(1);
  const reference = referenceTargets.get(anchor);
  if (reference) {
    byId('item-' + reference.stepId)?.scrollIntoView({ block: 'start' });
    openReferences(reference, anchor);
    return;
  }
  const target = byId(anchor);
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  if (target.dataset.itemType === 'issue') {
    const issue = target.querySelector('details');
    if (issue) issue.open = true;
  }
  target.scrollIntoView({ block: 'start' });
}

function rememberDisclosure(details, key) {
  details.dataset.disclosure = key;
  details.open = openDisclosures.has(key);
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    if (details.open) openDisclosures.add(key);
    else openDisclosures.delete(key);
  });
}

function firstReadingStep(groups) {
  const group = groups.find(candidate => candidate.items.some(item => item.type === 'node'));
  if (!group) return;
  const steps = group.items.filter(item => item.type === 'node');
  const forward = group.items.filter(item => item.relationType === 'sequence' || item.relationType === 'conditional');
  const sources = new Set(forward.map(item => item.parentId));
  const destinations = new Set(forward.map(item => item.destinationItemId));
  return (steps.find(item => sources.has(item.id) && !destinations.has(item.id)) ?? steps[0]).id;
}

function touchesGroup(comment, group) {
  return comment.groupId === group.id ||
    comment.outcome?.groupIds?.includes(group.id) ||
    (comment.itemId && group.items.some(item => item.id === comment.itemId));
}

function groupMatches(group) {
  switch (filter) {
    case 'open': return group.items.some(isOpen);
    case 'noted': return [...pendingComments(), ...drafts].some(comment => touchesGroup(comment, group));
    case 'changed': return [...contentChanges(), ...evidenceChanges()].some(change => change.locations?.some(location => location.groupId === group.id));
    default: return true;
  }
}

function render() {
  const process = isProcess();
  indexStepNumbers();
  document.documentElement.dataset.reviewLayout = process ? 'process' : 'grouped';
  document.title = review.project.title + ' · 流程审阅';
  byId('project-title').textContent = review.project.title;
  byId('project-scope').textContent = review.project.scope;
  byId('revision-label').textContent = `第 ${review.revision} 轮`;
  byId('download-flow').href = '/download/flow.md?revision=' + review.revision;
  byId('download-model').href = '/download/model.json?revision=' + review.revision;
  byId('header-exports').hidden = false;
  byId('open-step-search').hidden = !process;
  byId('review-kind').textContent = process ? '流程草稿' : '业务说明';
  byId('flow-output-label').textContent = process ? '流程文档' : '流程说明';
  byId('stage-index-title').textContent = process ? '阶段目录' : '审阅目录';
  const stages = review.groups.filter(group => !group.unplaced).length;
  byId('group-count').textContent = process ? `${stages} 个流程阶段` : `${stages} 组内容`;
  const openIssues = openIssueLocations(review.groups);
  byId('issue-count').textContent = openIssues.length ? `${openIssues.length} 处疑点待确认` : '暂无待确认疑点';
  byId('issue-count').disabled = !openIssues.length;
  byId('intro-stats').hidden = false;
  byId('work-area').hidden = false;
  const waiting = pendingCount();
  byId('show-pending').hidden = waiting === 0;
  byId('show-pending').textContent = `${waiting} 条批注待处理`;
  const results = currentResults();
  byId('show-current-results').hidden = results.length === 0;
  byId('show-current-results').textContent = `本轮处理结果 · ${results.length} 条`;
  const count = drafts.length + waiting;
  byId('feedback-count').hidden = count === 0;
  byId('feedback-count').textContent = count;
  byId('open-feedback').classList.toggle('has-feedback', count > 0);
  byId('filter-noted').hidden = process && filter !== 'noted' && !drafts.length && !waiting;
  byId('filter-changed').hidden = process && filter !== 'changed' && !contentChanges().length && !evidenceChanges().length;

  for (const control of byId('review-filters').querySelectorAll('[data-filter]')) {
    control.setAttribute('aria-pressed', control.dataset.filter === filter);
  }
  const navigation = byId('group-nav');
  const issueNavigation = byId('issue-nav');
  const list = byId('review-groups');
  for (const details of list.querySelectorAll('details[data-disclosure]')) {
    if (details.open) openDisclosures.add(details.dataset.disclosure);
    else openDisclosures.delete(details.dataset.disclosure);
  }
  navigation.replaceChildren();
  issueNavigation.replaceChildren();
  referenceSteps.clear();
  referenceTargets.clear();
  byId('margin-heading').hidden = !process || filter === 'changed';
  list.replaceChildren();
  hideSelection();
  const readingStart = process && filter === 'all' ? firstReadingStep(review.groups) : undefined;
  review.groups.forEach((group, index) => {
    if (!groupMatches(group)) return;
    const number = pad(index + 1);
    const link = node('a', 'nav-link');
    if (process && !group.unplaced) link.dataset.stageTone = String(index % 6);
    link.href = filter === 'changed' ? '#changes-' + group.id : groupAnchor(group.id);
    if (filter === 'changed') link.addEventListener('click', () => {
      for (let parent = byId('changes-' + group.id)?.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') parent.open = true;
      }
    });
    link.append(node('span', 'nav-number', group.unplaced ? '·' : number), node('span', '', group.title));
    if (group.items.some(isOpen)) {
      const dot = node('span', 'nav-dot');
      dot.setAttribute('aria-label', '有待确认疑点');
      link.append(dot);
    }
    navigation.append(link);
    if (process && filter === 'all' && !group.unplaced) {
      const shortcuts = node('div', 'nav-step-links');
      shortcuts.setAttribute('aria-label', group.title + '的步骤');
      for (const [itemId, position] of stepNumbers) {
        if (position.groupId !== group.id) continue;
        const item = group.items.find(candidate => candidate.id === itemId);
        const shortcut = node('a', 'step-number', position.number);
        shortcut.dataset.stageTone = position.tone;
        shortcut.title = `${position.number} · ${item.text}`;
        shortcut.setAttribute('aria-label', `跳转至步骤 ${position.number}：${item.text}`);
        followItem(shortcut, group.id, itemId);
        shortcuts.append(shortcut);
      }
      navigation.append(shortcuts);
    }
    if (process && filter === 'open') {
      for (const { item: issue } of openIssues.filter(location => location.group.id === group.id)) {
        const issueLink = node('a', 'nav-link nav-issue', issue.text);
        followItem(issueLink, group.id, issue.id);
        issueNavigation.append(issueLink);
      }
    }
    if (filter !== 'changed') list.append(renderGroup(group, number, readingStart));
  });
  issueNavigation.hidden = !issueNavigation.childElementCount;
  if (filter === 'changed') {
    list.append(renderChangeReview());
  }
  const empty = byId('review-empty');
  empty.hidden = list.childElementCount > 0;
  empty.textContent = {
    all: '这版稿件暂时没有审阅内容。',
    open: '当前没有待确认的疑点。',
    noted: '暂无待处理批注或未保存草稿。已处理记录可从「批注」查看。',
    changed: '这轮暂无修改。批注处理后，在这里查看变化。'
  }[filter];
  highlightNavigation();
}

function renderGroup(group, number, readingStart) {
  const process = isProcess();
  const article = node('article', process ? 'review-group process-group' : 'review-group');
  article.id = 'group-' + group.id;
  article.dataset.groupId = group.id;
  if (process && !group.unplaced) article.dataset.stageTone = String(review.groups.indexOf(group) % 6);
  const header = node('header', 'group-heading');
  const headingMain = node('div', 'group-heading-main');
  const title = node('h2', '', group.title);
  title.id = article.id + '-title';
  article.setAttribute('aria-labelledby', title.id);
  if (!group.unplaced) headingMain.append(node('span', 'group-number', process ? '阶段 ' + number : number));
  headingMain.append(title);
  const comments = [...pendingComments(), ...drafts].filter(comment => touchesGroup(comment, group));
  if (comments.length && !process) {
    headingMain.append(button(feedbackCountLabel(comments), 'label group-feedback', () => openFeedback(group)));
  }
  header.append(headingMain);
  if (process && !group.unplaced) {
    const actions = node('div', 'stage-actions');
    const annotate = button('批注本阶段', 'text-button annotation-button', () => openComposer(group));
    annotate.dataset.testid = 'comment-group';
    actions.append(annotate);
    if (comments.length) actions.append(button(feedbackCountLabel(comments), 'text-button', () => openFeedback(group)));
    header.append(actions);
  } else if (!group.unplaced) {
    const annotate = button('批注本组', 'text-button annotation-button', () => openComposer(group));
    annotate.dataset.testid = 'comment-group';
    header.append(annotate);
  }
  article.append(header);

  if (process) {
    article.append(renderProcessGroup(group, readingStart));
  } else {
    const reading = node('div', 'reading-items');
    const questions = node('div', 'issue-list');
    for (const item of group.items) {
      (item.type === 'issue' ? questions : reading).append(renderItem(group, item));
    }
    if (reading.childElementCount) article.append(reading);
    if (questions.childElementCount) article.append(questions);
  }
  return article;
}

function markItem(element, item, { anchor = true } = {}) {
  if (anchor) element.id = 'item-' + item.id;
  element.dataset.itemId = item.id;
  element.dataset.itemType = item.type;
}

function annotateItem(group, item, label) {
  const useIcon = isProcess() && ['claim', 'relation'].includes(item.type);
  const annotate = button(useIcon ? '✎' : label, useIcon ? 'text-button annotation-button annotation-icon' : 'text-button annotation-button', () => openComposer(group, item));
  if (useIcon) {
    const description = item.type === 'claim' ? '批注这句话' : label;
    annotate.setAttribute('aria-label', description);
    annotate.title = description;
  }
  annotate.dataset.testid = 'comment-item';
  return annotate;
}

function followItem(link, groupId, itemId) {
  link.href = itemAnchor(itemId);
  link.addEventListener('click', () => {
    if (drawerMode === 'references' && drawer.contains(link)) drawer.close();
    const group = findGroup(groupId);
    if (group && !groupMatches(group)) {
      filter = 'all';
      render();
    }
    if (link.hash === location.hash) revealAnchor();
  });
}

function relationLabel(item) {
  const divider = item.text.indexOf(' · ');
  const kind = divider < 0 ? '' : item.text.slice(0, divider);
  return {
    caption: item.relationType === 'sequence' ? '下一步' : kind,
    destination: divider < 0 ? item.text : item.text.slice(divider + 3),
  };
}

function followStep(link, group, relation) {
  link.href = itemAnchor(relation.destinationItemId);
  const position = stepNumbers.get(relation.destinationItemId);
  if (position) {
    link.dataset.stepNumber = position.number;
    link.dataset.stageTone = position.tone;
    link.setAttribute('aria-label', `步骤 ${position.number} · ${link.textContent}`);
  }
  link.setAttribute('aria-haspopup', 'dialog');
  link.dataset.linkedRelation = relation.id;
  link.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const targetGroup = findGroup(relation.destinationGroupId || group.id);
    const target = targetGroup?.items.find(item => item.id === relation.destinationItemId && item.type === 'node');
    const source = group.items.find(item => item.id === relation.parentId);
    if (!target || !source) return;
    event.preventDefault();

    if (drawer.open && drawerMode === 'linked-step' && drawer.contains(link)) {
      const previous = linkedReview.steps.at(-1);
      previous.scroll = byId('drawer-body').scrollTop;
      previous.via = relation.id;
    } else {
      markReadingPosition();
      linkedReview = { origin: {
        link, groupId: group.id, relationId: relation.id, stepId: source.id, title: source.text, filter,
        scroll: window.scrollY, offset: link.getBoundingClientRect().top,
      }, steps: [], visited: new Set([source.id]) };
    }
    linkedReview.steps.push({ group: targetGroup, item: target });
    linkedReview.visited.add(target.id);
    renderLinkedStep();
  });
}

function renderProcessGroup(group, readingStart) {
  const body = node('div', 'process-content');
  const children = new Map();
  for (const item of group.items) {
    const key = item.parentId ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(item);
  }

  const comments = [...pendingComments(), ...drafts];
  function collectTargets(itemId, ids = new Set()) {
    ids.add(itemId);
    for (const child of children.get(itemId) || []) collectTargets(child.id, ids);
    return ids;
  }

  function renderBranch(item, stepContext) {
    const nested = children.get(item.id) || [];
    if (item.type === 'issue') return renderProcessIssue(group, item);
    if (item.type === 'claim') return renderItem(group, item);

    const isStep = item.type === 'node';
    const isStart = item.id === readingStart;
    const branch = node('section', isStep ? 'process-step' : 'process-relation');
    if (isStart) branch.classList.add('reading-start');
    markItem(branch, item);
    const heading = node('div', 'process-item-heading');
    const title = node(isStep ? 'h3' : 'h4', 'process-item-title');
    let destinationText = item.text;
    if (!isStep && item.destinationItemId) {
      const { caption, destination: name } = relationLabel(item);
      destinationText = name;
      const destination = node('a', 'process-destination', destinationText);
      if (caption) title.append(node('span', 'relation-label', caption), ' ');
      followStep(destination, group, item);
      title.append(destination);
    } else {
      title.textContent = item.text;
    }
    title.dataset.testid = 'item-text';
    // Keep the display number outside the selectable business title.
    const headingTitle = isStep ? node('div', 'numbered-step-heading') : title;
    if (isStep) headingTitle.append(stepNumberBadge(item.id), title);
    if (isStart) {
      const start = node('div', 'reading-start-title');
      start.append(node('span', 'reading-start-label', '从这里开始'), headingTitle);
      heading.append(start);
    } else {
      heading.append(headingTitle);
    }
    if (!isStep) heading.append(annotateItem(group, item, '批注此流转'));
    if (!isStep && item.relationType) branch.dataset.relationType = item.relationType;
    decorateChangedItem(heading, title, item);

    const prose = isStep ? node('div', 'step-prose') : branch;
    prose.append(heading);
    const content = node('div', 'process-item-content');
    const relations = node('div', 'process-outgoing');
    const questions = node('div', 'process-item-questions');
    const extra = node('div', 'process-item-content');
    const claims = nested.filter(child => child.type === 'claim');
    const claimIn = field => claims.find(claim => claim.fieldLabel === field);
    const action = claimIn('动作');
    const context = claimIn('触发条件') ?? claimIn('角色');
    const primary = isStep
      ? [action ?? context ?? claims[0], claimIn('产出') ?? (action ? context : undefined)]
      : item.relationType === 'conditional' ? claims.filter(claim => claim.fieldLabel === '条件')
        : item.relationType === 'return' ? claims.slice(0, 1) : [];
    const references = isStep ? node('div', 'reference-body') : stepContext.references;
    // Node and relation placements of a claim have different feedback IDs, but share the claim ID suffix.
    const bodyClaims = isStep
      ? new Map(primary.filter(Boolean).map(claim => [claim.id.split('.claim.').at(-1), claim]))
      : stepContext.bodyClaims;
    for (const child of nested) {
      if (child.type === 'claim') {
        const visible = primary.includes(child);
        const original = !isStep && !visible && bodyClaims.get(child.id.split('.claim.').at(-1));
        const hasResult = allComments().some(comment => comment.resultChanges?.some(change => change.locations?.some(location => location.itemId === child.id)));
        if (original && original.text === child.text && !changeForItem(child) && !hasResult) {
          const row = node('div', 'reference-reuse');
          markItem(row, child);
          const link = node('a', '', '与正文相同，查看原句');
          followItem(link, group.id, original.id);
          row.append(link, annotateItem(group, child, '批注这句话'));
          extra.append(row);
        } else {
          (visible ? content : extra).append(renderItem(group, child, { compact: visible, showField: isStep }));
        }
      } else if (child.type === 'relation') {
        relations.append(renderBranch(child, { questions, references, bodyClaims }));
      }
      else questions.append(renderBranch(child));
    }
    if (content.childElementCount) prose.append(content);
    if (relations.childElementCount) prose.append(relations);
    if (extra.childElementCount) {
      const section = node('section', 'reference-section');
      section.append(node('h4', 'reference-heading', isStep ? '步骤细节' : '流转依据 · ' + destinationText), extra);
      if (isStep) references.prepend(section);
      else references.append(section);
    }
    if (isStep) {
      const layout = node('div', 'step-layout');
      const margin = node('aside', 'step-margin');
      margin.setAttribute('aria-label', item.text + '的疑点与批注');
      const actions = node('div', 'margin-actions');
      actions.append(annotateItem(group, item, '批注此步'));
      const ids = collectTargets(item.id);
      const notes = comments.filter(comment => ids.has(comment.itemId));
      if (notes.length) {
        actions.append(button(feedbackCountLabel(notes), 'text-button margin-note', () => openFeedback(group, { title: item.text, ids })));
      }
      if (questions.childElementCount) margin.append(questions);
      if (references.childElementCount) {
        const reference = { stepId: item.id, title: item.text, content: references };
        references.dataset.groupId = group.id;
        referenceSteps.set(item.id, reference);
        for (const target of references.querySelectorAll('[data-item-id]')) referenceTargets.set(target.id, reference);
        const inspect = button('细节与依据', 'text-button step-reference', () => openReferences(reference));
        inspect.setAttribute('aria-haspopup', 'dialog');
        margin.append(inspect);
        const hiddenChanges = contentChanges().filter(change => change.locations?.some(location => location.stepId === item.id && referenceTargets.has('item-' + location.itemId)));
        if (hiddenChanges.length) {
          const updates = node('div', 'step-change-summary');
          updates.append(node('span', 'change-tag', `细节有 ${hiddenChanges.length} 处修改`));
          for (const change of hiddenChanges) {
            const location = change.locations.find(location => location.stepId === item.id && referenceTargets.has('item-' + location.itemId));
            const target = group.items.find(candidate => candidate.id === location.itemId);
            updates.append(changeLocationLink(change, location, `${change.kind === 'added' ? '新增' : '已修改'} · ${target?.fieldLabel || '细节'}：${change.after ?? change.before}`));
          }
          margin.append(updates);
        }
      }
      margin.append(actions);
      layout.append(prose, margin);
      branch.append(layout);
    } else if (questions.childElementCount) {
      const context = node('div', 'margin-issue-context');
      context.append(node('p', 'margin-context', item.text), questions);
      stepContext.questions.append(context);
    }
    return branch;
  }

  const roots = children.get(null) || [];
  const start = roots.find(item => item.id === readingStart);
  if (start) body.append(renderBranch(start));
  for (const item of roots) if (item !== start) body.append(renderBranch(item));
  return body;
}

function renderProcessIssue(group, item) {
  const issue = node('aside', 'process-issue ' + item.status);
  markItem(issue, item);
  const details = node('details', 'process-issue-disclosure');
  rememberDisclosure(details, item.id);
  const summary = node('summary', 'process-issue-summary');
  summary.dataset.testid = 'evidence-toggle';
  const text = node('span', 'process-issue-text', item.text);
  text.dataset.testid = 'item-text';
  const resolved = item.status === 'resolved';
  const flag = status(resolved ? '已澄清' : '待确认', resolved ? 'applied' : 'pending');
  summary.append(flag, text);
  details.append(summary);
  const body = node('div', 'process-issue-detail');
  body.dataset.testid = 'evidence';
  if (item.impact && !resolved) body.append(node('p', 'issue-impact', item.impact));
  for (const resolution of item.resolutions ?? []) {
    const result = node('p', 'issue-resolution', resolution.text);
    result.dataset.testid = 'issue-resolution';
    if (resolution.origin) result.append(' ', node('span', 'origin ' + resolution.origin, origins[resolution.origin]));
    appendLocations(result, resolution.evidence);
    body.append(result);
  }
  appendRecords(body, '原文口径与相关记录', item.records, { locationsOnly: true });
  const excerpts = [
    ...item.evidence,
    ...(item.records ?? []).flatMap(record => record.evidence),
    ...(item.resolutions ?? []).flatMap(record => record.evidence),
  ];
  if (excerpts.length) {
    const citations = node('details', 'process-issue-citations');
    rememberDisclosure(citations, 'original-' + item.id);
    const unique = new Map(excerpts.map(excerpt => [JSON.stringify(excerpt), excerpt]));
    citations.append(node('summary', '', `查看原文摘录 · ${unique.size} 处`));
    const quotes = node('div', 'evidence');
    appendEvidence(quotes, unique.values());
    citations.append(quotes);
    body.append(citations);
  }
  details.append(body);
  issue.append(details, annotateItem(group, item, resolved ? '批注疑点' : '回答疑点'));
  decorateChangedItem(issue, text, item);
  return issue;
}

function renderItem(group, item, { compact = false, showField = true } = {}) {
  const issue = item.type === 'issue';
  const row = node('div', issue ? ('issue ' + item.status) : 'reading-item');
  if (compact) row.classList.add('compact');
  markItem(row, item);
  if (issue) row.append(status(item.status === 'resolved' ? '疑点已澄清' : '待确认', item.status === 'resolved' ? 'applied' : 'pending'));
  const line = node('div', 'reading-row');
  const text = node('p', 'reading-text', item.text);
  text.dataset.testid = 'item-text';
  const annotate = annotateItem(group, item, issue && item.status === 'open' ? '回答疑点' : '批注');
  if (annotate.textContent === '批注') annotate.setAttribute('aria-label', '批注这条内容');
  if (showField && item.fieldLabel && isProcess() && !compact) {
    const prose = node('div', 'claim-prose');
    prose.append(node('span', 'claim-field', item.fieldLabel), text);
    line.append(prose, annotate);
  } else {
    line.append(text, annotate);
  }
  row.append(line);
  decorateChangedItem(row, text, item);
  if (item.impact && item.status !== 'resolved') row.append(node('p', 'issue-impact', item.impact));
  if (item.status === 'resolved') {
    for (const resolution of item.resolutions ?? []) {
      const result = node('p', 'issue-resolution', resolution.text);
      result.dataset.testid = 'issue-resolution';
      if (resolution.origin) result.append(' ', node('span', 'origin ' + resolution.origin, origins[resolution.origin]));
      row.append(result);
    }
  }

  if (item.origin || item.evidence.length || item.rationale || item.records?.length || item.resolutions?.length) {
    const detail = node('div', 'item-details');
    if (item.origin) detail.append(node('span', 'origin ' + item.origin, origins[item.origin]));
    if (item.evidence.length || item.rationale || item.records?.length || item.resolutions?.length) detail.append(evidencePanel(item));
    row.append(detail);
  }
  return row;
}

function evidencePanel(item, { remember = true } = {}) {
  const details = node('details', 'evidence-disclosure');
  if (isProcess() && remember) rememberDisclosure(details, 'evidence-' + item.id);
  const summary = node('summary', '', item.type === 'issue' ? '查看依据与记录' : '查看依据');
  summary.dataset.testid = 'evidence-toggle';
  const body = node('div', 'evidence');
  body.dataset.testid = 'evidence';
  if (item.rationale) body.append(node('p', 'item-rationale', item.rationale));
  appendEvidence(body, item.evidence);
  appendRecords(body, '已有记录', item.records);
  appendRecords(body, '澄清结果', item.resolutions);
  details.append(summary, body);
  return details;
}

function appendEvidence(body, evidence) {
  for (const source of evidence) {
    const citation = node('figure', 'citation');
    citation.append(node('figcaption', '', evidenceLocation(source)), node('blockquote', '', source.quote));
    body.append(citation);
  }
}

function evidenceLocation(source) {
  const range = source.startLine === source.endLine ? source.startLine : `${source.startLine}–${source.endLine}`;
  return `${source.name} · 第 ${range} 行`;
}

function appendLocations(entry, evidence) {
  if (!evidence.length) return;
  const locations = [...new Set(evidence.map(evidenceLocation))];
  entry.append(node('small', 'record-locations', locations.join(' / ')));
}

function appendRecords(body, label, records = [], { locationsOnly = false } = {}) {
  if (!records.length) return;
  const list = node('ul', 'issue-records');
  for (const record of records) {
    const entry = node('li', '', record.text);
    if (record.origin) entry.append(' ', node('span', 'origin ' + record.origin, origins[record.origin]));
    if (locationsOnly) appendLocations(entry, record.evidence);
    else appendEvidence(entry, record.evidence);
    list.append(entry);
  }
  body.append(node('strong', '', label), list);
}

function rememberResultOrigin() {
  const feedback = drawer.open && isFeedbackDrawer();
  return {
    kind: 'result', revision: review.revision, filter, scroll: window.scrollY,
    title: feedback ? '批注记录' : filter === 'changed' ? '本轮修改核对' : '原阅读位置',
    focus: document.activeElement, previousReturn: readingReturn,
    feedback: feedback ? { groupId: feedbackGroupId, step: feedbackStep, scroll: byId('drawer-body').scrollTop,
      archiveOpen: !!byId('feedback-archive')?.open, linkedReview, linkedReturn } : undefined,
  };
}

function presentResultReturn(origin) {
  readingReturn = origin;
  byId('return-to-reading').textContent = '← 返回' + origin.title;
  byId('reading-origin').textContent = '';
  byId('reading-return').hidden = false;
}

function restoreResultOrigin(origin) {
  const feedback = origin.feedback;
  linkedReview = undefined;
  linkedReturn = undefined;
  if (drawer.open) drawer.close();
  filter = origin.filter;
  render();
  clearReadingReturn();
  if (origin.previousReturn) {
    readingReturn = origin.previousReturn;
    byId('reading-origin').textContent = readingReturn.title;
    byId('reading-return').hidden = false;
  }
  window.scrollTo({ top: origin.scroll, behavior: 'instant' });
  if (feedback) {
    if (origin.revision === review.revision) {
      linkedReview = feedback.linkedReview;
      linkedReturn = feedback.linkedReturn;
    }
    openFeedback(findGroup(feedback.groupId), feedback.step);
    if (byId('feedback-archive') && feedback.archiveOpen) {
      byId('feedback-archive').open = true;
      byId('feedback-archive').dispatchEvent(new Event('toggle'));
    }
    byId('drawer-body').scrollTop = feedback.scroll;
  } else if (origin.focus?.isConnected) origin.focus.focus({ preventScroll: true });
}

function highlightResultTarget(target) {
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  markReadingPosition(target);
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'center', behavior: 'instant' });
}

function openChangeLocation(change, location) {
  if ((!location?.itemId && !location?.groupId) || change.state === 'removed') return;
  const origin = rememberResultOrigin();
  selectedChangeLocations.set(change.id, location.itemId || 'group:' + location.groupId);
  linkedReview = undefined;
  linkedReturn = undefined;
  activeStepSearch = undefined;
  if (filter !== 'all') { filter = 'all'; render(); }
  const anchor = location.itemId ? 'item-' + location.itemId : 'group-' + location.groupId;
  const reference = referenceTargets.get(anchor);
  history.replaceState(null, '', '#' + anchor);
  presentResultReturn(origin);
  if (reference) {
    openReferences(reference, anchor);
    setDrawerBack('返回' + origin.title, () => restoreResultOrigin(origin));
  } else if (drawer.open) drawer.close();
  highlightResultTarget(byId(anchor));
}

function changeLocationLink(change, location, label) {
  const link = node('a', 'change-location-link', label ?? `查看正文 · ${location.stepTitle || findGroup(location.groupId)?.title || '对应条目'}`);
  link.href = location.itemId ? itemAnchor(location.itemId) : groupAnchor(location.groupId);
  link.dataset.testid = 'change-result-link';
  link.dataset.changeId = change.id;
  if (location.itemId) link.dataset.itemId = location.itemId;
  else link.dataset.groupId = location.groupId;
  if (label) link.title = label;
  if (selectedChangeLocations.get(change.id) === (location.itemId || 'group:' + location.groupId)) link.setAttribute('aria-current', 'location');
  link.addEventListener('click', event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openChangeLocation(change, location);
  });
  return link;
}

function appendChangeLocations(container, change, prefix = '查看正文') {
  const locations = change.state === 'removed' ? [] : [...new Map((change.locations ?? []).filter(location => location.itemId || location.groupId).map(location => [location.groupId + ':' + location.itemId, location])).values()];
  if (!locations.length) {
    if (change.state !== 'removed' && change.kind !== 'removed') container.append(node('p', 'dialog-note', '当前无正文位置，以上记录供核对。'));
    return;
  }
  const links = node('div', 'change-locations');
  links.setAttribute('role', 'group');
  links.setAttribute('aria-label', '选择查看位置');
  const labels = locations.map(location => {
    const group = findGroup(location.groupId);
    const item = group?.items.find(item => item.id === location.itemId);
    const parent = group?.items.find(candidate => candidate.id === item?.parentId);
    const kind = parent?.type === 'relation' || item?.type === 'relation'
      ? item?.fieldLabel === '条件' ? '流转条件' : '流转依据'
      : item?.fieldLabel === '动作' || item?.type === 'node' ? '步骤正文'
        : item?.fieldLabel || (item?.type === 'issue' ? '疑点' : location.itemId ? '步骤正文' : '阶段正文');
    return { step: location.stepTitle || group?.title || '对应条目', kind };
  });
  locations.forEach((location, index) => {
    const { step, kind } = labels[index];
    const sameKind = labels.filter(label => label.step === step && label.kind === kind).length;
    const number = sameKind > 1 ? ' ' + labels.slice(0, index + 1).filter(label => label.step === step && label.kind === kind).length : '';
    links.append(changeLocationLink(change, location, `${prefix}${locations.length > 1 ? ' · ' + kind + number : ''}：${step}`));
  });
  container.append(links);
}

function showChangeReview(changeId) {
  const origin = rememberResultOrigin();
  if (drawer.open) drawer.close();
  linkedReview = undefined;
  linkedReturn = undefined;
  filter = 'changed';
  render();
  presentResultReturn(origin);
  const target = [...byId('review-groups').querySelectorAll('[data-change-id]')].find(element => element.dataset.changeId === changeId);
  highlightResultTarget(target);
}

function renderChangeReview() {
  const section = node('section', 'change-review');
  const changes = contentChanges(), evidence = evidenceChanges();
  const heading = node('header', 'change-review-heading');
  heading.append(node('h2', '', '本轮修改核对'), node('p', 'change-baseline', review.revision > 1 ? `第 ${review.revision - 1} 轮 → 第 ${review.revision} 轮` : '第 1 轮 · 首版'),
    node('p', '', `${changes.length} 项正文变化${evidence.length ? ` · ${evidence.length} 项依据变化` : ''}`));
  section.append(heading);
  const groupAnchors = new Set();
  const addAnchors = (card, change) => {
    for (const location of change.locations ?? []) if (!groupAnchors.has(location.groupId)) {
      const anchor = node('span', 'change-group-anchor');
      anchor.id = 'changes-' + location.groupId;
      card.prepend(anchor);
      groupAnchors.add(location.groupId);
    }
  };
  for (const change of changes) {
    const card = node('article', 'content-change');
    card.dataset.testid = 'content-change';
    card.dataset.changeId = change.id;
    card.dataset.changeKind = change.kind;
    if (change.locations?.[0]) card.dataset.groupId = change.locations[0].groupId;
    const location = change.locations?.[0];
    const item = findGroup(location?.groupId)?.items.find(item => item.id === location?.itemId);
    const title = node('h3', 'change-title');
    title.append(node('span', 'change-tag', { added: '新增', modified: '已修改', removed: '已移除' }[change.kind] || '已修改'),
      location?.stepTitle || item?.fieldLabel || '条目变化');
    card.append(title);
    if (item?.fieldLabel) card.append(node('p', 'change-field', item.fieldLabel));
    const sameText = change.before === change.after;
    if (change.before !== null && change.before !== undefined && !sameText) {
      const before = node('p', 'change-copy before');
      const text = node('span');
      fillChangedText(text, change, 'before');
      before.append(node('span', 'change-copy-label', '修改前'), text);
      card.append(before);
    }
    if (change.after !== null && change.after !== undefined) {
      const after = node('p', 'change-copy after');
      const text = node('span');
      fillChangedText(text, change);
      after.append(node('span', 'change-copy-label', sameText ? '对应正文' : change.kind === 'added' ? '新增内容' : '修改后'), text);
      card.append(after);
    }
    if (change.summary) card.append(node('p', 'change-summary', change.summary));
    if (change.evidenceChanged) card.append(node('p', 'dialog-note', '这项修改的依据同时更新。'));
    if (change.kind === 'removed') card.append(node('p', 'dialog-note', '该条目已移出本轮正文，保留修改前内容供核对。'));
    appendChangeLocations(card, change);
    addAnchors(card, change);
    section.append(card);
  }
  if (!changes.length) section.append(node('p', 'empty', '本轮暂无正文内容变化。'));
  if (evidence.length) {
    const details = node('details', 'change-evidence');
    details.dataset.testid = 'evidence-changes';
    details.append(node('summary', '', `依据与归属变化 · ${evidence.length} 项`), node('p', 'drawer-description', '以下条目的依据或归属有变化，正文措辞保留。'));
    for (const change of evidence) {
      const card = node('article', 'evidence-change');
      card.dataset.changeId = change.id;
      card.append(node('p', '', change.after ?? change.before ?? '依据更新'));
      if (change.summary) card.append(node('p', 'dialog-note', change.summary));
      appendChangeLocations(card, change);
      addAnchors(card, change);
      details.append(card);
    }
    section.append(details);
  }
  return section;
}

// Retained for legacy model adapters; current rendering uses canonical changes above.
function renderChanges(changes, group) {
  const details = node('details', 'changes');
  details.open = filter === 'changed';
  details.dataset.testid = 'revision-changes';
  details.append(node('summary', '', `本轮修改 · ${changes.length} 处`));
  for (const change of changes) {
    const entry = node('div', 'change');
    if (change.kind === 'context') {
      entry.append(node('p', 'after', '依据或上下文已更新'));
      if (change.summary) entry.append(node('p', '', change.summary));
      const currentItem = findGroup(change.groupId)?.items.find(item => item.id === change.itemId);
      if (currentItem) {
        const link = node('a', '', currentItem.text);
        followItem(link, change.groupId, currentItem.id);
        const location = node('p');
        location.append(link);
        entry.append(location);
      }
      details.append(entry);
      continue;
    }
    if (change.kind === 'move') {
      const movedItem = findGroup(change.groupId)?.items.find(item => item.id === change.itemId);
      const line = node('p', 'after');
      line.append(node('strong', '', '调整归组'), `由「${change.before}」移到「${change.after}」`);
      entry.append(line);
      if (movedItem) entry.append(node('p', change.groupId === group.id ? 'after' : 'before', movedItem.text));
      details.append(entry);
      continue;
    }
    if (change.before !== null) {
      const before = node('p', 'before');
      before.append(node('strong', '', '修改前'), change.before);
      entry.append(before);
    }
    if (change.after !== null) {
      const after = node('p', 'after');
      after.append(node('strong', '', change.before === null ? '新增' : '修改后'), change.after);
      entry.append(after);
    } else {
      entry.append(node('p', 'after', '本轮移除'));
    }
    details.append(entry);
  }
  return details;
}

function highlightNavigation() {
  const groups = byId('review-groups').querySelectorAll('[data-group-id]');
  let currentGroup = groups[0];
  const readingLine = document.querySelector('.topbar').getBoundingClientRect().bottom + 42;
  for (const group of groups) {
    if (group.getBoundingClientRect().top > readingLine) break;
    currentGroup = group;
  }
  if (groups.length && window.scrollY > 0 &&
    window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
    currentGroup = groups[groups.length - 1];
  }
  const current = currentGroup ? filter === 'changed' ? '#changes-' + currentGroup.dataset.groupId : '#' + currentGroup.id : '';
  for (const link of byId('group-nav').children) {
    if (link.hash === current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
  for (const link of byId('issue-nav').children) {
    if (link.hash === location.hash) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

function scheduleNavigation() {
  if (navigationFrame) return;
  navigationFrame = requestAnimationFrame(() => {
    navigationFrame = undefined;
    highlightNavigation();
  });
}

function setDrawerBack(label, action) {
  drawerBackAction = action;
  const control = byId('drawer-back');
  control.hidden = !action;
  control.textContent = action ? '← ' + label : '';
}

function isFeedbackDrawer() {
  return drawerMode === 'feedback' || drawerMode === 'linked-feedback';
}

function displayDrawer(mode, title, kicker) {
  retainComposer?.();
  retainComposer = undefined;
  updateComposerRevision = undefined;
  hideSelection();
  drawerMode = mode;
  drawer.dataset.mode = mode;
  const linked = mode.startsWith('linked-') && !!linkedReview;
  if (linked || drawer.hasAttribute('data-linked')) announce('');
  drawer.toggleAttribute('data-linked', linked);
  (mode === 'references' || mode === 'linked-step' ? drawer : document.body).append(selectionButton);
  (linked ? drawer : document.body).append(byId('announcement'));
  const path = byId('linked-step-navigation');
  path.hidden = !linked;
  path.inert = linked && mode !== 'linked-step';
  const readingMarker = path.querySelector('.linked-step-current');
  if (readingMarker) readingMarker.textContent = path.inert ? '阅读位置' : '当前';
  byId('linked-step-actions').hidden = mode !== 'linked-step';
  byId('linked-feedback-bar').hidden = mode !== 'linked-step' || !drafts.length;
  setDrawerBack();
  byId('close-drawer').setAttribute('aria-label', linked ? '关闭预览，回到正文' : '关闭');
  byId('close-drawer').removeAttribute('title');
  byId('drawer-title').textContent = title;
  byId('drawer-kicker').textContent = kicker;
  const body = byId('drawer-body');
  body.replaceChildren();
  body.scrollTop = 0;
  if (!drawer.open) drawer.showModal();
  placeVersionNotice();
  return body;
}

function renderLinkedClaim(group, item) {
  const claim = node('div', 'linked-step-claim');
  markItem(claim, item, { anchor: false });
  if (item.fieldLabel) claim.append(node('span', 'claim-field', item.fieldLabel));
  const row = node('div', 'reading-row');
  const text = node('p', 'reading-text', item.text);
  text.dataset.testid = 'item-text';
  row.append(text, annotateItem(group, item, '批注这句话'));
  claim.append(row);
  decorateChangedItem(claim, text, item);
  const detail = node('div', 'item-details');
  if (item.origin && item.origin !== 'explicit') detail.append(node('span', 'origin ' + item.origin, origins[item.origin]));
  if (item.evidence.length || item.rationale) detail.append(evidencePanel(item, { remember: false }));
  if (detail.childElementCount) claim.append(detail);
  return claim;
}

function renderLinkedStep({ scroll = 0, via, focus } = {}) {
  const { steps, origin } = linkedReview;
  const frame = steps.at(-1);
  const { group, item } = frame;
  const depth = steps.length;
  const body = displayDrawer('linked-step', item.text, `${frame.searchSession ? '搜索进入 · ' : ''}第 ${depth} 层 · ${group.title}`);
  byId('drawer-title').prepend(stepNumberBadge(item.id), ' ');
  byId('linked-step-source').textContent = origin.title;
  byId('linked-step-origin').title = '回到正文起点 · ' + origin.title;
  byId('linked-step-back').hidden = depth < 2;
  const close = byId('close-drawer');
  const closeLabel = '关闭预览，回到正文';
  close.setAttribute('aria-label', closeLabel);
  close.title = closeLabel;
  byId('return-search-results').hidden = !steps.some(step => step.searchSession);
  byId('linked-step-feedback').textContent = `本批批注 ${drafts.length}`;
  byId('linked-draft-status').textContent = drafts.length ? `${drafts.length} 条待保存` : '';
  renderLinkedPath(steps);
  frame.content ??= buildLinkedStep(group, item);
  body.append(frame.content);
  const viaLink = via && body.querySelector(`[data-linked-relation="${CSS.escape(via)}"]`);
  const trigger = focus?.isConnected && drawer.contains(focus) && !focus.hidden && focus;
  (trigger || viaLink || byId('drawer-title')).focus({ preventScroll: true });
  body.scrollTop = scroll;
}

function renderLinkedPath(steps) {
  const path = byId('linked-step-path');
  path.replaceChildren();
  steps.forEach(({ item, searchSession }, index) => {
    const current = index === steps.length - 1;
    const entry = node('li');
    const layer = current ? node('div', 'linked-step-layer')
      : button('', 'linked-step-layer', () => returnToLinkedLayer(index));
    layer.toggleAttribute('data-search-entry', !!searchSession);
    layer.title = item.text;
    layer.append(node('span', 'linked-step-number', searchSession ? `第 ${index + 1} 层 · 搜索进入` : `第 ${index + 1} 层`), node('span', 'linked-step-name', item.text));
    if (current) {
      layer.setAttribute('aria-current', 'step');
      layer.append(node('span', 'linked-step-current', drawerMode === 'linked-step' ? '当前' : '阅读位置'));
    }
    entry.append(layer);
    path.append(entry);
  });
  revealCurrentLayer();
}

function revealCurrentLayer() {
  const path = byId('linked-step-path');
  path.scrollTo({ left: path.scrollWidth, top: path.scrollHeight, behavior: 'instant' });
}

function returnToLinkedLayer(index) {
  linkedReview.steps.length = index + 1;
  const { scroll, via } = linkedReview.steps[index];
  renderLinkedStep({ scroll, via });
}

function closeDrawerLayer() {
  if (drawerBackAction) {
    drawerBackAction();
    return;
  }
  if (linkedReturn) {
    resumeLinkedReading();
    return;
  }
  const searched = linkedReview?.steps.at(-1)?.searchSession;
  if (searched) {
    showStepSearch(searched, true);
    return;
  }
  const depth = linkedReview?.steps.length;
  if (depth > 1) returnToLinkedLayer(depth - 2);
  else drawer.close();
}

function rememberLinkedReading(focus = document.activeElement) {
  linkedReturn = { scroll: byId('drawer-body').scrollTop, focus };
}

function resumeLinkedReading() {
  const position = linkedReturn;
  linkedReturn = undefined;
  if (linkedReview) renderLinkedStep(position);
  else drawer.close();
}

function openLinkedPicker() {
  if (!review || !isProcess()) return;
  const fromReading = drawer.open && drawerMode === 'linked-step' && linkedReview;
  const trigger = fromReading ? byId('linked-step-choose') : byId('open-step-search');
  const session = {
    revision: review.revision, query: '', scroll: 0,
    reading: fromReading ? { review: linkedReview, position: { scroll: byId('drawer-body').scrollTop, focus: trigger } } : undefined,
    origin: fromReading ? linkedReview.origin : {
      kind: 'search', link: trigger, title: '查找步骤前的正文位置', filter, scroll: window.scrollY, offset: trigger.getBoundingClientRect().top,
    },
  };
  if (fromReading) linkedReview.steps.at(-1).scroll = session.reading.position.scroll;
  showStepSearch(session);
}

function returnFromSearch(session) {
  activeStepSearch = undefined;
  if (session.reading) {
    linkedReview = session.reading.review;
    renderLinkedStep(session.reading.position);
  } else {
    drawer.close();
    restoreReadingPosition(session.origin);
  }
}

function highlightedSearchText(tag, className, text, query) {
  const element = node(tag, className);
  if (!query) {
    element.textContent = text;
    return element;
  }
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    element.append(document.createTextNode(text.slice(cursor, match.index)), node('mark', '', match[0]));
    cursor = match.index + match[0].length;
  }
  element.append(document.createTextNode(text.slice(cursor)));
  return element;
}

function searchStepExcerpt(group, item, query) {
  if (stepNumbers.get(item.id)?.number === query) return { rank: -1 };
  const children = group.items.filter(child => child.parentId === item.id);
  const relations = new Set(children.filter(child => child.type === 'relation').map(child => child.id));
  if (item.text.toLocaleLowerCase().includes(query)) return { rank: 0 };
  const records = [...children.flatMap(child => [child.text, child.impact || '', ...(child.records || []).map(record => record.text)]),
    ...group.items.filter(child => relations.has(child.parentId)).map(child => child.text)];
  const hit = records.find(text => text && text.toLocaleLowerCase().includes(query));
  if (!hit) return group.title.toLocaleLowerCase().includes(query) ? { rank: 2 } : null;
  const index = hit.toLocaleLowerCase().indexOf(query);
  const start = Math.max(0, index - 32);
  const end = Math.min(hit.length, start + 120);
  return { text: (start ? '…' : '') + hit.slice(start, end) + (end < hit.length ? '…' : ''), rank: 1 };
}

function showStepSearch(session, restore = false) {
  if (session.revision !== review.revision) return drawer.close();
  activeStepSearch = session;
  linkedReturn = undefined;
  linkedReview = session.reading?.review;
  const body = displayDrawer('linked-picker', '查找步骤', '按编号、步骤、阶段或正文关键词查找');
  if (linkedReview) renderLinkedPath(linkedReview.steps);
  setDrawerBack(session.reading ? '返回原阅读' : '返回正文', () => returnFromSearch(session));
  const current = linkedReview?.steps.at(-1)?.item.id;
  const steps = review.groups.flatMap(group => group.items
    .filter(item => item.type === 'node').map(item => ({ group, item })));
  const byStep = new Map(steps.map(step => [step.item.id, step]));
  const recentIds = new Set([current, ...[...(linkedReview?.visited || [])].reverse()].filter(Boolean));
  const search = node('input', 'linked-step-search');
  search.type = 'search';
  search.id = 'linked-step-search';
  search.placeholder = '输入编号（如 1.2）或关键词';
  search.value = session.query;
  search.setAttribute('aria-controls', 'linked-picker-results');
  const label = node('label', 'form-label', '步骤编号或关键词');
  label.htmlFor = search.id;
  const results = node('div', 'linked-picker-results');
  results.id = 'linked-picker-results';
  const empty = node('p', 'drawer-description');
  empty.setAttribute('role', 'status');
  const searchBox = node('div', 'linked-picker-search');
  const inputRow = node('div', 'linked-picker-input');
  const clear = button('清空', 'text-button', () => {
    search.value = '';
    session.query = '';
    session.scroll = 0;
    updateResults();
    body.scrollTop = 0;
    search.focus({ preventScroll: true });
  });
  clear.id = 'clear-step-search';
  inputRow.append(search, clear);
  searchBox.append(label, inputRow);
  body.append(searchBox, empty, results);

  function updateResults() {
    const query = search.value.trim().toLocaleLowerCase();
    session.query = search.value;
    clear.hidden = !search.value;
    const matches = ({ group, item }) => !query || searchStepExcerpt(group, item, query) !== null;
    const recent = [...recentIds].map(id => byStep.get(id)).filter(step => step && matches(step));
    const others = steps.filter(step => !recentIds.has(step.item.id) && matches(step));
    if (query) {
      const byMatch = (left, right) => searchStepExcerpt(left.group, left.item, query).rank - searchStepExcerpt(right.group, right.item, query).rank;
      recent.sort(byMatch);
      others.sort(byMatch);
    }
    results.replaceChildren();
    for (const [title, choices] of [['本次看过', recent], [query ? '匹配步骤' : '全部步骤', others]]) {
      if (!choices.length) continue;
      const section = node('section');
      section.append(node('h3', 'drawer-section-title', title));
      for (const { group, item } of choices) {
        const choice = button('', 'linked-picker-choice', () => {
          session.scroll = body.scrollTop;
          session.focusedStepId = item.id;
          const original = session.reading?.review;
          linkedReview = {
            origin: session.origin,
            steps: [...(original?.steps || []), { group, item, searchSession: session }],
            visited: new Set([...(original?.visited || []), item.id]),
          };
          activeStepSearch = undefined;
          renderLinkedStep();
        });
        choice.dataset.stepId = item.id;
        choice.append(highlightedSearchText('strong', '', item.text, query),
          highlightedSearchText('span', '', group.title + (item.id === current ? ' · 正在查看' : ''), query));
        choice.firstElementChild.prepend(stepNumberBadge(item.id), ' ');
        if (query) {
          const match = searchStepExcerpt(group, item, query);
          if (match.text) choice.append(highlightedSearchText('span', 'linked-picker-excerpt', match.text, query));
        }
        section.append(choice);
      }
      results.append(section);
    }
    empty.textContent = recent.length || others.length ? '' : '没有匹配的步骤。可以换个关键词，或清空查看全部步骤。';
    empty.hidden = !empty.textContent;
  }
  search.addEventListener('input', () => { session.scroll = 0; updateResults(); body.scrollTop = 0; });
  updateResults();
  const previous = restore && session.focusedStepId && results.querySelector(`[data-step-id="${CSS.escape(session.focusedStepId)}"]`);
  (previous || search).focus({ preventScroll: true });
  body.scrollTop = restore ? session.scroll : 0;
}

function buildLinkedStep(group, item) {
  const children = group.items.filter(child => child.parentId === item.id);
  const claims = children.filter(child => child.type === 'claim');
  const reading = node('div', 'linked-step-body');
  reading.dataset.groupId = group.id;
  const primary = node('div');
  const extras = node('details', 'linked-step-extras');
  for (const claim of claims) {
    const section = claim.fieldLabel && claim.fieldLabel !== '规则' ? primary : extras;
    section.append(renderLinkedClaim(group, claim));
  }
  if (primary.childElementCount) reading.append(primary);

  const outgoing = children.filter(child => child.type === 'relation');
  if (outgoing.length) {
    const routes = node('section', 'linked-step-flow');
    routes.append(node('h3', 'drawer-section-title', '后续流转'));
    for (const relation of outgoing) {
      const { caption, destination } = relationLabel(relation);
      const route = node('div', 'process-relation');
      route.dataset.relationType = relation.relationType;
      const link = node('a', 'process-destination', destination);
      followStep(link, group, relation);
      route.append(node('span', 'relation-label', caption), link);
      const claims = group.items.filter(child => child.parentId === relation.id && child.type === 'claim');
      const conditions = claims.filter(claim => claim.fieldLabel === '条件');
      const visible = !conditions.length && relation.relationType === 'return' ? claims.slice(0, 1) : conditions;
      for (const claim of visible) route.append(renderLinkedClaim(group, claim));
      routes.append(route);
    }
    reading.append(routes);
  }

  const relationIds = new Set(outgoing.map(relation => relation.id));
  const issues = group.items.filter(child => isOpen(child) && (child.parentId === item.id || relationIds.has(child.parentId)));
  if (issues.length) {
    const questions = node('section');
    questions.append(node('h3', 'drawer-section-title', '待确认'));
    for (const issue of issues) {
      const question = node('div', 'linked-step-issue');
      markItem(question, issue, { anchor: false });
      question.append(node('p', 'reading-text', issue.text));
      if (issue.impact) question.append(node('p', 'issue-impact', issue.impact));
      if (issue.evidence.length || issue.records?.length) question.append(evidencePanel(issue, { remember: false }));
      question.append(annotateItem(group, issue, '回答疑点'));
      questions.append(question);
    }
    reading.append(questions);
  }
  if (extras.childElementCount) {
    extras.prepend(node('summary', '', `更多步骤细节 · ${extras.childElementCount} 条`));
    reading.append(extras);
  }
  return reading;
}

function markReadingPosition(element) {
  markedReadingPosition?.removeAttribute('data-reading-position');
  element?.setAttribute('data-reading-position', '');
  markedReadingPosition = element;
}

function restoreReadingPosition(origin) {
  if (origin.kind === 'search') {
    const trigger = origin.link?.isConnected ? origin.link : byId('open-step-search');
    trigger?.focus({ preventScroll: true });
    window.scrollTo({ top: origin.scroll, behavior: 'instant' });
    return;
  }
  const relation = byId('item-' + origin.relationId);
  const link = origin.link.isConnected ? origin.link : relation?.querySelector('.process-destination');
  if (link) {
    markReadingPosition(relation);
    link.focus({ preventScroll: true });
    window.scrollBy({ top: link.getBoundingClientRect().top - origin.offset, behavior: 'instant' });
  } else {
    const step = byId('item-' + origin.stepId) ?? byId('group-' + origin.groupId);
    if (step) {
      markReadingPosition(step);
      step.tabIndex = -1;
      step.focus({ preventScroll: true });
      step.scrollIntoView({ block: 'start', behavior: 'instant' });
    } else window.scrollTo({ top: origin.scroll, behavior: 'instant' });
  }
}

function locateLinkedStep() {
  const { group, item } = linkedReview.steps.at(-1);
  readingReturn ??= linkedReview.origin;
  linkedReview = undefined;
  drawer.close();
  if (!groupMatches(group)) {
    filter = 'all';
    render();
  }
  byId('reading-origin').textContent = readingReturn.title;
  byId('reading-return').hidden = false;
  const target = byId('item-' + item.id);
  markReadingPosition(target);
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
  const start = target === target.parentElement.firstElementChild ? target.closest('.process-group') : target;
  start.scrollIntoView({ block: 'start', behavior: 'instant' });
}

function clearReadingReturn() {
  readingReturn = undefined;
  byId('reading-return').hidden = true;
  byId('return-to-reading').textContent = '← 返回原处';
}

function openReferences(reference, anchor, previousScroll) {
  if (!reference) return;
  activeReference = reference;
  const body = displayDrawer('references', '细节与依据', reference.title);
  body.append(reference.content);
  const target = anchor && byId(anchor);
  if (target) {
    body.scrollTop = previousScroll ?? target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 12;
    target.querySelector('[data-testid="comment-item"]')?.focus({ preventScroll: true });
  } else {
    byId('close-drawer').focus({ preventScroll: true });
  }
}

function openComposer(group, item, selection, editing) {
  if (saving) {
    announce('正在保存这一批批注，请稍候。');
    return;
  }
  const returnStep = drawer.open && drawerMode === 'references' ? activeReference?.stepId : undefined;
  const returnScroll = returnStep ? byId('drawer-body').scrollTop : undefined;
  const feedbackReturn = drawer.open && isFeedbackDrawer() ? {
    group: findGroup(feedbackGroupId), step: feedbackStep, scroll: byId('drawer-body').scrollTop,
  } : undefined;
  const linked = drawer.open && drawerMode.startsWith('linked-') && !!linkedReview;
  if (linked && !linkedReturn) {
    const target = selection && byId('drawer-body').querySelector(`[data-item-id="${CSS.escape(item.id)}"]`);
    rememberLinkedReading(target ? target.querySelector('[data-testid="comment-item"]') : undefined);
  }
  const composerRevision = review.revision;
  const scratchKey = JSON.stringify([review.project.id, composerRevision, group.id, item?.id, selection?.start, selection?.end, editing?.id]);
  const kinds = { issue: '疑点', node: '步骤', relation: '流转', claim: '这句话' };
  const kind = item ? (selection ? '所选文字' : kinds[item.type]) : (isProcess() && !group.unplaced ? '本阶段' : '整组');
  const parent = item && group.items.find(candidate => candidate.id === item.parentId);
  const step = item?.type === 'node' ? item : parent?.type === 'node' ? parent
    : group.items.find(candidate => candidate.type === 'node' && candidate.id === parent?.parentId);
  const title = linked ? '批注 · ' + ((step ?? item)?.text ?? group.title) : editing ? '修改批注' : '批注' + kind;
  const kicker = linked ? (item?.type === 'node' ? '整步批注' : '批注' + kind) : `第 ${review.revision} 轮`;
  const body = displayDrawer(linked ? 'linked-composer' : 'composer', title, kicker + ' · ' + group.title);
  const goBack = () => {
    if (composerRevision !== review.revision) return openFeedback();
    if (feedbackReturn) {
      openFeedback(feedbackReturn.group, feedbackReturn.step);
      byId('drawer-body').scrollTop = feedbackReturn.scroll;
      return;
    }
    if (linked) return resumeLinkedReading();
    const reference = referenceSteps.get(returnStep);
    if (reference) return openReferences(reference, 'item-' + item.id, returnScroll);
    drawer.close();
  };
  setDrawerBack(feedbackReturn ? '返回批注列表' : linked ? '返回阅读' : returnStep ? '返回细节' : '返回正文', goBack);
  const retained = composerScratch.get(scratchKey);
  const preview = node('div', 'target-preview');
  if (!linked) preview.append(node('strong', '', group.title));
  if (item) {
    if (parent && !(linked && parent === step)) preview.append(node('div', 'item-rationale', parent.text));
    const quote = selection?.text ?? item.text;
    if (quote.length > 180 || quote.split('\n').length > 3) {
      const excerpt = node('details', 'target-excerpt');
      excerpt.append(node('summary', '', '查看完整引用'), node('blockquote', '', quote));
      preview.append(node('p', 'quote-preview', quote), excerpt);
    } else {
      preview.append(node('blockquote', '', quote));
    }
  } else {
    preview.append(node('div', '', isProcess() && !group.unplaced ? '这条批注针对本阶段。' : '这条批注针对整组内容。'));
  }
  if (!linked || item?.type !== 'node') body.append(preview);

  const form = node('form', 'composer-form');
  const tags = new Set(retained?.tags ?? editing?.tags ?? []);
  const tagSet = node('div', 'tag-set');
  tagSet.setAttribute('role', 'group');
  tagSet.setAttribute('aria-label', '反馈类型，可多选');
  for (const [value, label] of Object.entries(tagLabels)) {
    const toggle = button(label, 'tag', () => {
      if (tags.has(value)) tags.delete(value);
      else tags.add(value);
      toggle.setAttribute('aria-pressed', String(tags.has(value)));
      error.hidden = true;
    });
    toggle.dataset.tag = value;
    toggle.setAttribute('aria-pressed', String(tags.has(value)));
    tagSet.append(toggle);
  }
  const label = node('label', 'form-label', '你的反馈');
  label.htmlFor = 'comment-text';
  const textarea = node('textarea');
  textarea.id = 'comment-text';
  textarea.maxLength = 6000;
  textarea.placeholder = item?.type === 'issue' ? '如果你知道现行做法，可以直接写在这里。' : '哪里需要调整？也可以只选上面的标记。';
  textarea.value = retained?.text ?? editing?.text ?? '';
  textarea.addEventListener('input', () => { error.hidden = true; });
  const error = node('p', 'notice');
  error.hidden = true;
  error.setAttribute('role', 'alert');
  const revisionNotice = node('p', 'notice');
  revisionNotice.hidden = true;
  const footer = node('div', 'composer-footer');
  const actions = node('div', 'form-actions');
  const add = node('button', 'button primary', editing ? '更新本条' : '加入本批');
  add.id = 'add-comment';
  add.type = 'submit';
  const back = button(feedbackReturn ? '返回批注列表' : linked ? '返回阅读' : returnStep ? '返回细节' : '返回正文', 'button secondary', goBack);
  actions.append(add, back);
  footer.append(actions, node('p', 'dialog-note', retained
    ? '已恢复未加入本批的输入。'
    : '加入本批后仍待保存，可从「本批批注」统一保存。'));
  form.append(revisionNotice, tagSet, label, textarea, error, footer);
  body.append(form);
  retainComposer = () => {
    if (textarea.value || tags.size || editing) composerScratch.set(scratchKey, {
      revision: composerRevision, group, item, selection, editing, text: textarea.value, tags: [...tags],
    });
    else composerScratch.delete(scratchKey);
  };
  updateComposerRevision = () => {
    const stale = composerRevision !== review.revision;
    add.disabled = stale;
    revisionNotice.hidden = !stale;
    if (stale) {
      revisionNotice.textContent = `这份输入针对第 ${composerRevision} 轮，文字与标记已保留。请复制需要的内容，在新版对应位置重新批注。`;
      back.textContent = '返回批注列表';
      byId('drawer-kicker').textContent = `第 ${composerRevision} 轮 · ${group.title}`;
    }
  };
  textarea.focus();
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (composerRevision !== review.revision) {
      retainComposer?.();
      updateComposerRevision?.();
      return;
    }
    const text = textarea.value.trim();
    if (!text && tags.size === 0) {
      error.textContent = '请写下反馈，或选一个标记。';
      error.hidden = false;
      return;
    }
    if (drafts.length && draftRevision !== review.revision) {
      error.textContent = `当前批注草稿针对第 ${draftRevision} 轮。请先到批注列表核对旧稿。`;
      error.hidden = false;
      return;
    }
    const comment = { id: editing?.id ?? crypto.randomUUID(), groupId: group.id, groupTitle: group.title, tags: [...tags], text };
    if (item) Object.assign(comment, { itemId: item.id, itemText: item.text });
    if (selection) comment.selection = selection;
    if (editing) drafts = drafts.map(draft => draft.id === editing.id ? comment : draft);
    else drafts.push(comment);
    batchId = undefined;
    draftRevision = review.revision;
    saveError = '';
    retainComposer = undefined;
    composerScratch.delete(scratchKey);
    const scroll = window.scrollY;
    if (!returnStep && !linked && !feedbackReturn) drawer.close();
    render();
    if (feedbackReturn) {
      openFeedback(feedbackReturn.group, feedbackReturn.step);
      byId('drawer-body').scrollTop = feedbackReturn.scroll;
      announce(editing ? '已更新本条批注，仍待保存' : `已加入本批 · ${drafts.length} 条待保存`);
      return;
    }
    if (linked) {
      window.scrollTo({ top: scroll, behavior: 'instant' });
      resumeLinkedReading();
      announce(`已将「${(step ?? item).text}」的批注加入本批，待保存`);
      return;
    }
    if (returnStep) {
      openReferences(referenceSteps.get(returnStep), 'item-' + item.id, returnScroll);
      announce(editing ? '已更新本条批注草稿' : `已加入本批 · ${drafts.length} 条待保存`);
      return;
    }
    const article = byId('group-' + group.id);
    const target = item && article && [...article.querySelectorAll('[data-item-id]')].find(element => element.dataset.itemId === item.id);
    (target?.querySelector('[data-testid="comment-item"]') || article?.querySelector('[data-testid="comment-group"]'))?.focus({ preventScroll: true });
    announce(editing ? '已更新本条批注草稿' : `已加入本批 · ${drafts.length} 条待保存`);
  });
}

function openFeedback(group, step) {
  if (!review) return;
  if (drawer.open && drawerMode === 'linked-step' && linkedReview && !linkedReturn) {
    rememberLinkedReading(byId('linked-step-feedback'));
  }
  feedbackGroupId = group?.id;
  feedbackStep = step;
  displayDrawer(linkedReturn && linkedReview ? 'linked-feedback' : 'feedback', '批注与处理结果', `当前稿件 · 第 ${review.revision} 轮`);
  if (linkedReturn && linkedReview) setDrawerBack('返回阅读', resumeLinkedReading);
  renderFeedback();
}

function renderFeedback() {
  const body = byId('drawer-body');
  body.replaceChildren();
  const scratches = [...composerScratch].filter(([, scratch]) => !feedbackGroupId || scratch.group.id === feedbackGroupId);
  if (scratches.length) {
    const section = node('section', 'drafts-section');
    section.append(node('h3', 'drawer-section-title', '尚未加入本批的输入'));
    const list = node('div', 'draft-list');
    for (const [key, scratch] of scratches) {
      const card = node('div', 'draft-card');
      card.dataset.scratchRevision = scratch.revision;
      const row = node('div', 'history-comment');
      row.append(node('p', 'comment-title', `第 ${scratch.revision} 轮 · ${scratch.group.title}`));
      const quote = scratch.selection?.text ?? scratch.item?.text;
      if (quote) row.append(node('blockquote', '', quote));
      if (scratch.tags.length) row.append(node('p', 'item-rationale', scratch.tags.map(tag => tagLabels[tag]).join(' · ')));
      if (scratch.text) {
        const retainedInput = node('div', 'batch-handoff');
        const copy = node('textarea');
        copy.value = scratch.text;
        copy.readOnly = true;
        copy.rows = 3;
        copy.setAttribute('aria-label', `第 ${scratch.revision} 轮保留的批注输入`);
        retainedInput.append(copy);
        row.append(retainedInput);
      }
      const actions = node('div', 'comment-actions');
      if (scratch.revision === review.revision) actions.append(button('继续填写', 'text-button', () => openComposer(scratch.group, scratch.item, scratch.selection, scratch.editing)));
      else row.append(node('p', 'dialog-note', '旧版输入仅供复制参考，请在新版定位后重新批注。'));
      actions.append(button('移除', 'text-button', () => { composerScratch.delete(key); renderFeedback(); }));
      row.append(actions);
      card.append(row);
      list.append(card);
    }
    section.append(list);
    body.append(section);
  }
  const shownDrafts = feedbackStep ? drafts.filter(comment => feedbackStep.ids.has(comment.itemId)) : drafts;
  if (shownDrafts.length) {
    const section = node('section', scratches.length ? 'drafts-section history-section' : 'drafts-section');
    section.append(node('h3', 'drawer-section-title', `待保存 · ${shownDrafts.length} 条`));
    const list = node('div', 'draft-list');
    for (const draft of shownDrafts) {
      const card = node('div', 'draft-card');
      const row = commentSummary(draft, false);
      const actions = node('div', 'comment-actions');
      const group = findGroup(draft.groupId);
      const item = group?.items.find(candidate => candidate.id === draft.itemId);
      if (group && draftRevision === review.revision) {
        const edit = button('修改', 'text-button', () => openComposer(group, item, draft.selection, draft));
        edit.disabled = saving;
        actions.append(edit);
      }
      const remove = button('移除', 'text-button', () => {
        drafts = drafts.filter(comment => comment.id !== draft.id);
        batchId = undefined;
        saveError = '';
        render();
        renderFeedback();
      });
      remove.disabled = saving;
      actions.append(remove);
      row.append(actions);
      card.append(row);
      list.append(card);
    }
    section.append(list);
    const actions = node('div', 'form-actions');
    if (feedbackStep) {
      actions.append(button('查看本批全部', 'button secondary', () => openFeedback()));
    } else {
      const save = button(saving ? '正在保存…' : '保存本批批注', 'button primary', saveBatch);
      save.id = 'save-batch';
      save.disabled = saving || draftRevision !== review.revision;
      actions.append(save);
    }
    actions.append(button(linkedReturn ? '返回阅读' : '继续审阅', 'button secondary', () => linkedReturn ? resumeLinkedReading() : drawer.close()));
    section.append(actions);
    if (draftRevision !== review.revision) {
      section.append(node('p', 'notice', `这些草稿针对第 ${draftRevision} 轮。请保留需要的文字，在当前稿件定位后重新批注。`));
    } else if (saveError) {
      const error = node('p', 'notice', saveError);
      error.setAttribute('role', 'alert');
      section.append(error);
    }
    body.append(section);
  }

  const history = node('section', 'history-section');
  history.id = 'feedback-history';
  const group = findGroup(feedbackGroupId);
  if (group) {
    const scope = node('div', 'history-scope');
    scope.append(node('span', 'label', feedbackStep?.title ?? group.title), button('查看全部批注', 'text-button', () => openFeedback()));
    history.append(scope);
  }
  const batches = [...(review.batches ?? [])].sort((a, b) => b.savedAt.localeCompare(a.savedAt)).map(batch => ({
    ...batch, comments: group ? batch.comments.filter(comment => feedbackStep ? feedbackStep.ids.has(comment.itemId) : touchesGroup(comment, group)) : batch.comments,
  }));
  const comments = batches.flatMap(batch => batch.comments);
  const recent = comment => !isPendingComment(comment) && comment.outcome.revision === review.revision;
  const archived = comment => !isPendingComment(comment) && !recent(comment);
  const renderBatches = (container, predicate, allowHandoff = false) => {
    for (const batch of batches) {
      const selected = batch.comments.filter(predicate);
      if (!selected.length) continue;
      const entry = node('article', 'history-batch');
      entry.dataset.batchId = batch.id;
      const title = node('h4', '', `批注于第 ${batch.revision} 轮 · ${selected.length} 条`);
      const savedAt = new Date(batch.savedAt);
      if (!Number.isNaN(savedAt.getTime())) title.append(node('span', 'batch-meta', savedAt.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
      entry.append(title);
      if (allowHandoff && batch.handoff) entry.append(batchHandoff(batch));
      for (const comment of selected) entry.append(commentSummary(comment, true));
      container.append(entry);
    }
  };
  const pending = node('section', 'feedback-section');
  pending.id = 'feedback-pending';
  const waiting = comments.filter(isPendingComment).length;
  pending.append(node('h3', 'drawer-section-title', `待处理 · ${waiting} 条`));
  if (waiting) {
    pending.append(node('p', 'drawer-description', '复制待处理批次的引用，粘贴到原来的 Codex 对话并发送。'));
    renderBatches(pending, isPendingComment, true);
  } else pending.append(node('p', 'drawer-description', '暂无待处理批注。'));
  history.append(pending);
  const current = node('section', 'feedback-section');
  current.id = 'feedback-current-results';
  const count = comments.filter(recent).length;
  current.append(node('h3', 'drawer-section-title', `本轮处理结果 · ${count} 条`));
  if (count) {
    current.append(node('p', 'drawer-description', `以下批注在第 ${review.revision} 轮处理，可逐条查看修改结果。`));
    renderBatches(current, recent);
  } else current.append(node('p', 'drawer-description', '本轮暂无处理结果。'));
  history.append(current);
  const archive = node('details', 'feedback-archive');
  archive.id = 'feedback-archive';
  archive.dataset.testid = 'feedback-archive';
  archive.append(node('summary', '', `已处理历史 · ${comments.filter(archived).length} 条`));
  const archiveBody = node('div', 'feedback-archive-body');
  archive.append(archiveBody);
  archive.addEventListener('toggle', () => {
    if (archive.open && !archiveBody.childElementCount) {
      renderBatches(archiveBody, archived);
      if (!archiveBody.childElementCount) archiveBody.append(node('p', 'drawer-description', '暂无更早的已处理记录。'));
    } else if (!archive.open) archiveBody.replaceChildren();
  });
  history.append(archive);
  body.append(history);
}

function batchHandoff(batch) {
  const panel = node('div', 'batch-handoff');
  const hint = node('p', 'drawer-description');
  hint.setAttribute('role', 'status');
  hint.hidden = true;
  const fallback = node('textarea');
  fallback.readOnly = true;
  fallback.rows = 4;
  fallback.hidden = true;
  fallback.setAttribute('aria-label', '可复制到 Codex 对话的批次引用');
  const copy = button('复制整批到对话', 'button primary', async () => {
    try {
      await navigator.clipboard.writeText(batch.handoff);
      fallback.hidden = true;
      hint.textContent = '已复制。请粘贴到原来的 Codex 对话并发送。';
    } catch {
      fallback.value = batch.handoff;
      fallback.hidden = false;
      fallback.focus();
      fallback.select();
      hint.textContent = '请复制已选中的引用，粘贴到原来的 Codex 对话并发送。';
    }
    hint.hidden = false;
  });
  copy.dataset.testid = 'copy-batch';
  panel.append(copy, hint, fallback);
  return panel;
}

function commentSummary(comment, saved) {
  const row = node('div', 'history-comment');
  row.dataset.commentId = comment.id;
  const label = comment.outcome?.status || 'pending';
  if (saved) row.dataset.status = label;
  row.append(node('p', 'comment-title', comment.groupTitle));
  if (saved) row.append(status(statusLabels[label], label));
  const anchor = comment.selection?.text ?? comment.itemText;
  if (anchor) row.append(node('blockquote', '', anchor));
  if (comment.tags.length) row.append(node('p', 'item-rationale', comment.tags.map(tag => tagLabels[tag]).join(' · ')));
  if (comment.text) row.append(node('p', 'comment-text', comment.text));
  if (comment.outcome) {
    if (comment.outcome.revision) row.append(node('p', 'outcome-revision', `处理于第 ${comment.outcome.revision} 轮`));
    row.append(node('p', 'comment-outcome', comment.outcome.summary));
    const results = uniqueChanges(comment.resultChanges);
    for (const change of results) {
      const result = node('section', 'comment-result-change');
      result.dataset.testid = 'comment-result-change';
      result.dataset.changeId = change.id;
      result.dataset.resultState = change.state ?? 'current';
      const evidenceOnly = change.category === 'evidence';
      result.append(node('p', 'result-kind', evidenceOnly ? '依据更新' : { added: '新增内容', modified: '修改结果', removed: '移除内容' }[change.kind] || '修改结果'));
      const sameText = change.before === change.after;
      if (change.before !== null && change.before !== undefined && !evidenceOnly && !sameText) {
        const before = node('p', 'result-copy before');
        const text = node('span');
        text.dataset.testid = 'result-before';
        fillChangedText(text, change, 'before');
        before.append(node('span', 'change-copy-label', '修改前'), text);
        result.append(before);
      }
      if (change.after !== null && change.after !== undefined) {
        const after = node('p', 'result-copy after');
        const text = node('span');
        text.dataset.testid = 'result-after';
        if (evidenceOnly) text.textContent = change.after;
        else fillChangedText(text, change);
        after.append(node('span', 'change-copy-label', evidenceOnly || sameText ? '对应原句' : change.kind === 'added' ? '新增' : '修改后'), text);
        result.append(after);
      }
      if (change.state === 'changed') result.append(node('p', 'result-state-note', '此处后来又有修改。以上保留处理当轮结果，链接指向当前正文。'));
      if (change.state === 'removed') result.append(node('p', 'result-state-note', '这处内容已移除，保留处理当轮结果供核对。'));
      if (change.summary) result.append(node('p', 'dialog-note', change.summary));
      appendChangeLocations(result, change, change.state === 'changed' ? '查看当前位置' : '查看修改结果');
      row.append(result);
    }
    if (comment.outcome.noChangeReason) row.append(node('p', 'dialog-note', '未修改正文：' + comment.outcome.noChangeReason));
    else if (!results.length && comment.outcome.mappingSource === 'unavailable') row.append(node('p', 'dialog-note result-unmapped', '此条历史处理未能关联到具体修改，请按处理说明核对。'));
    if (comment.outcome.mappingIncomplete && comment.outcome.mappingNote) row.append(node('p', 'dialog-note', comment.outcome.mappingNote));
  }
  if (saved && comment.itemId) {
    const group = review.groups.find(group => group.items.some(item => item.id === comment.itemId));
    if (group) {
      const original = changeLocationLink({ id: 'original-comment:' + comment.id }, { groupId: group.id, itemId: comment.itemId }, '原批注位置');
      original.dataset.testid = 'comment-origin-link';
      original.classList.add('original-comment-link');
      const actions = node('div', 'outcome-links');
      actions.append(original);
      row.append(actions);
    }
  }
  return row;
}

async function saveBatch() {
  if (!drafts.length || saving || draftRevision !== review.revision) return;
  batchId ??= crypto.randomUUID();
  const comments = drafts.map(({ groupTitle, itemText, ...payload }) => payload);
  let savedBatchId;
  saving = true;
  saveError = '';
  renderFeedback();
  try {
    const response = await fetch('/api/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: batchId, revision: draftRevision, comments })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.id !== batchId) {
      throw new Error(result.error || '暂时无法确认保存结果。批注草稿已保留，可以重试。');
    }
    savedBatchId = result.id;
    drafts = [];
    batchId = undefined;
    draftRevision = undefined;
    const loaded = await refresh();
    if (loaded) announce('已保存。现在可以复制整批批注到对话。');
    else {
      render();
      announce('批注已保存。暂时未能读回批注记录。');
    }
  } catch (error) {
    saveError = error.message;
  } finally {
    saving = false;
    if (drawer.open && isFeedbackDrawer()) {
      renderFeedback();
      if (savedBatchId) {
        const entry = [...byId('feedback-history').children].find(item => item.dataset.batchId === savedBatchId);
        entry?.querySelector('[data-testid="copy-batch"]')?.focus();
      }
    }
  }
}

function textElement(boundary) {
  return (boundary.nodeType === Node.TEXT_NODE ? boundary.parentElement : boundary)?.closest?.('[data-testid="item-text"]');
}

function updateSelection() {
  const selection = window.getSelection();
  if (!review || (drawer.open && !['references', 'linked-step'].includes(drawerMode)) ||
    !selection?.rangeCount || selection.isCollapsed) return hideSelection();
  const range = selection.getRangeAt(0);
  const element = textElement(range.startContainer);
  if (!element || textElement(range.endContainer) !== element) return hideSelection();
  if (drawer.open && !drawer.contains(element)) return hideSelection();
  const target = element.closest('[data-item-id][data-item-type="claim"]');
  if (!target) return hideSelection();
  const group = findGroup(target.closest('[data-group-id]').dataset.groupId);
  const item = group.items.find(candidate => candidate.id === target.dataset.itemId);
  const prefix = document.createRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(range.startContainer, range.startOffset);
  const selected = range.toString();
  const text = selected.trim();
  if (!text) return hideSelection();
  const start = prefix.toString().length + selected.length - selected.trimStart().length;
  const end = start + text.length;
  if (item.text.slice(start, end) !== text) return hideSelection();
  const rect = range.getBoundingClientRect();
  const viewport = drawer.open ? byId('drawer-body').getBoundingClientRect() : { top: 65, bottom: window.innerHeight };
  if (rect.bottom < viewport.top || rect.top > viewport.bottom) return hideSelection();
  chosenSelection = { group, item, selection: { start, end, text } };
  selectionButton.hidden = false;
  const minLeft = drawer.open ? drawer.getBoundingClientRect().left + 8 : 8;
  const left = Math.max(minLeft, Math.min(rect.right - selectionButton.offsetWidth, window.innerWidth - selectionButton.offsetWidth - 8));
  const top = rect.bottom + selectionButton.offsetHeight + 14 < viewport.bottom ? rect.bottom + 6 : rect.top - selectionButton.offsetHeight - 6;
  selectionButton.style.left = left + 'px';
  selectionButton.style.top = Math.max(viewport.top, top) + 'px';
}

function hideSelection() {
  chosenSelection = undefined;
  selectionButton.hidden = true;
}

selectionButton.addEventListener('mousedown', event => event.preventDefault());
selectionButton.addEventListener('click', () => {
  if (!chosenSelection) return;
  const { group, item, selection } = chosenSelection;
  openComposer(group, item, selection);
  window.getSelection()?.removeAllRanges();
});
document.addEventListener('selectionchange', updateSelection);
window.addEventListener('scroll', updateSelection, { passive: true });
window.addEventListener('scroll', scheduleNavigation, { passive: true });
byId('drawer-body').addEventListener('scroll', updateSelection, { passive: true });
window.addEventListener('resize', updateSelection);
window.addEventListener('resize', scheduleNavigation);
window.addEventListener('resize', () => {
  if (drawer.open && drawerMode === 'linked-step') revealCurrentLayer();
});
window.addEventListener('hashchange', () => {
  revealAnchor();
  highlightNavigation();
});
byId('refresh-review').addEventListener('click', () => refresh({ announceResult: true }));
byId('read-available-version').addEventListener('click', () => refresh({ announceResult: true }));
window.addEventListener('focus', checkForReviewUpdate);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForReviewUpdate(); });
byId('open-step-search').addEventListener('click', openLinkedPicker);
byId('open-feedback').addEventListener('click', () => openFeedback());
byId('show-pending').addEventListener('click', () => openFeedback());
byId('show-current-results').addEventListener('click', () => {
  openFeedback();
  byId('feedback-current-results')?.scrollIntoView({ block: 'start' });
});
byId('issue-count').addEventListener('click', () => {
  byId('filter-open').click();
  byId('review-filters').scrollIntoView();
});
byId('close-drawer').addEventListener('click', () => drawer.close());
byId('drawer-back').addEventListener('click', () => drawerBackAction?.());
byId('linked-step-back').addEventListener('click', closeDrawerLayer);
byId('linked-step-origin').addEventListener('click', () => drawer.close());
byId('linked-step-locate').addEventListener('click', locateLinkedStep);
byId('linked-step-choose').addEventListener('click', openLinkedPicker);
byId('return-search-results').addEventListener('click', () => {
  const session = linkedReview?.steps.findLast(step => step.searchSession)?.searchSession;
  if (session) showStepSearch(session, true);
});
byId('linked-step-feedback').addEventListener('click', () => openFeedback());
byId('linked-step-annotate').addEventListener('click', () => {
  const { group, item } = linkedReview.steps.at(-1);
  openComposer(group, item);
});
byId('return-to-reading').addEventListener('click', () => {
  const origin = readingReturn;
  if (origin?.kind === 'result') return restoreResultOrigin(origin);
  clearReadingReturn();
  if (origin.filter !== filter) {
    filter = origin.filter;
    render();
  }
  restoreReadingPosition(origin);
});
byId('dismiss-reading-return').addEventListener('click', clearReadingReturn);
function isBackdrop(event) {
  if (event.target !== drawer) return false;
  const bounds = drawer.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX >= bounds.right ||
    event.clientY < bounds.top || event.clientY >= bounds.bottom;
}

let backdropPressed = false;
drawer.addEventListener('pointerdown', event => { backdropPressed = isBackdrop(event); });
drawer.addEventListener('click', event => {
  if (backdropPressed && isBackdrop(event)) closeDrawerLayer();
  backdropPressed = false;
});
drawer.addEventListener('cancel', event => {
  event.preventDefault();
  closeDrawerLayer();
});
drawer.addEventListener('close', () => {
  if (drawer.open) return;
  const searchOrigin = activeStepSearch?.origin;
  retainComposer?.();
  retainComposer = undefined;
  updateComposerRevision = undefined;
  hideSelection();
  document.body.append(selectionButton);
  if (drawer.hasAttribute('data-linked')) announce('');
  document.body.append(byId('announcement'));
  linkedReturn = undefined;
  activeStepSearch = undefined;
  drawerBackAction = undefined;
  if (linkedReview) {
    const { origin } = linkedReview;
    linkedReview = undefined;
    restoreReadingPosition(origin);
  } else if (searchOrigin) restoreReadingPosition(searchOrigin);
  placeVersionNotice();
});
byId('review-filters').addEventListener('click', event => {
  if (!review || !event.target.dataset.filter) return;
  filter = event.target.dataset.filter;
  render();
});
refresh();
setInterval(checkForReviewUpdate, 4000);
