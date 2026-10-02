// Editorial Manager allows journals to reorder their author-queue columns.
const clean = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const label = value => clean(value).toLowerCase().replace(/[:*]/g, '').trim();
const fields = {
  number: /^(?:manuscript|submission)\s*(?:number|no\.?|id|#)$/,
  title_en: /^(?:(?:manuscript|submission|article)\s+)?title$/,
  raw_status: /^(?:(?:current|manuscript|submission)\s+)?status$/,
  submitted_at: /^(?:initial date submitted|initial submission date|original submission date|date submitted|submission date|submitted)$/,
  status_date: /^(?:status date|date of status|date status changed)$/
};
const revisionQueues = new Set(['Submissions Needing Revision', 'Incomplete Revisions', 'Incomplete Submissions Being Revised']);

export function editorialManagerRows(tables, queueName = '') {
  const rows = [];
  let recognized = false;
  for (const table of tables) {
    const headerIndex = table.findIndex(row => row.some(cell => fields.number.test(label(cell))) &&
      row.some(cell => fields.title_en.test(label(cell))));
    if (headerIndex < 0) continue;
    const headings = table[headerIndex].map(label);
    const indices = Object.fromEntries(Object.entries(fields).map(([field, pattern]) =>
      [field, headings.findIndex(heading => pattern.test(heading))]));
    if (indices.raw_status < 0 && !revisionQueues.has(queueName)) continue;
    recognized = true;
    for (const cells of table.slice(headerIndex + 1)) {
      const row = Object.fromEntries(Object.entries(indices).map(([field, index]) =>
        [field, index < 0 ? '' : clean(cells[index])]));
      if (!row.raw_status && revisionQueues.has(queueName)) row.raw_status = queueName;
      if (row.number && row.title_en && !fields.number.test(label(row.number))) rows.push(row);
    }
  }
  return {recognized, rows};
}

export async function readEditorialManagerTable(scope, queueName = '') {
  const table = scope.locator('#datatable');
  const cells = await table.evaluate(element => [...element.rows].map(row =>
    [...row.cells].map(cell => cell.innerText || cell.textContent)));
  const result = editorialManagerRows([cells], queueName);
  if (!result.recognized) throw new Error('unrecognized_table');
  return result.rows;
}

export async function expandEditorialManagerPage(scope) {
  const size = scope.locator('#size1');
  if (!await size.isVisible()) return;
  const values = await size.locator('option').evaluateAll(options => options.map(option => option.value)
    .filter(value => /^\d+$/.test(value) && Number(value) > 0));
  if (!values.length) return;
  await size.selectOption(values.sort((a, b) => Number(b) - Number(a))[0]);
  await scope.locator('#datatable').waitFor({state: 'visible'});
}
