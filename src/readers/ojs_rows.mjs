// OJS 3.4 author-list extraction, checked against the PKP public demo.
const clean = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();

export function ojs34Rows(entries) {
  const rows = [];
  for (const entry of entries) {
    // Users with several roles can also see editorial assignments in the list.
    const match = String(entry.author_url || '').match(/\/authorDashboard\/submission\/(\d+)(?:[/?#]|$)/);
    if (!match) continue;
    const number = clean(entry.number), title = clean(entry.title_en);
    const status = clean(entry.notice) || clean(entry.raw_status);
    if (number !== match[1] || !title || !status) return {recognized: false, rows: []};
    rows.push({number, title_en: title, raw_status: status, submitted_at: '', status_date: ''});
  }
  return {recognized: true, rows};
}

export async function readOjs34List(scope) {
  if (!await scope.locator('.listPanel--submissions').count()) return {recognized: false, rows: []};
  const entries = await scope.locator('.listPanel__item--submission').evaluateAll(items => items.map(item => {
    const stage = item.querySelector('.listPanel__item--submission__stage');
    return {
      number: item.querySelector('.listPanel__item--submission__id')?.textContent,
      // OJS puts the author name in itemTitle and the manuscript title in itemSubtitle.
      title_en: item.querySelector('.listPanel__itemSubtitle')?.textContent,
      // Author revision requests appear in this notice while the stage stays Review.
      notice: item.querySelector('.listPanel__item--submission__notice')?.textContent,
      raw_status: stage ? [...stage.childNodes].filter(node => node.nodeType === 3)
        .map(node => node.textContent).join(' ') : '',
      author_url: item.querySelector('a[href*="/authorDashboard/submission/"]')?.getAttribute('href') || ''
    };
  }));
  // The expanded card's last-activity date is not a submission or status date.
  return ojs34Rows(entries);
}
