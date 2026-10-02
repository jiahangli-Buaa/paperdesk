// Extract explicitly labeled columns; unknown page layouts remain unverified.
export function paperceptRows(tables) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const norm = value => clean(value).toLowerCase().replace(/[:*]/g, '');
  const fields = {
    number:/^(?:(?:submission|paper|manuscript)\s*(?:number|no\.?|id|#)|number|id)$/,
    title_en:/^(?:(?:submission|paper|manuscript)\s+)?title$/,
    raw_status:/^(?:(?:current|submission|paper|manuscript)\s+)?status$/,
    submitted_at:/^(?:date (?:submitted|received|first received)|(?:submission|submitted|received|initial submission) date|submitted|received)$/,
    status_date:/^(?:status date|date of (?:status|decision)|decision date)$/
  };
  const rows=[];
  let recognized=false;
  for(const table of tables) {
    const headerIndex=table.findIndex(row=>row.some(cell=>fields.title_en.test(norm(cell))) && row.some(cell=>fields.raw_status.test(norm(cell))));
    if(headerIndex<0)continue;
    const headings=table[headerIndex].map(norm);
    const indices=Object.fromEntries(Object.entries(fields).map(([field,pattern])=>[field,headings.findIndex(h=>pattern.test(h))]));
    if(indices.number<0)continue;
    recognized=true;
    for(const cells of table.slice(headerIndex+1)) {
      const row=Object.fromEntries(Object.entries(indices).map(([field,index])=>[field,index<0?'':clean(cells[index])]));
      if(row.number && row.title_en && row.raw_status && !fields.title_en.test(norm(row.title_en)))rows.push(row);
    }
  }
  return {recognized,rows};
}
