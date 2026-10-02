import assert from 'node:assert/strict';
import {ojs34Rows} from '../../src/readers/ojs_rows.mjs';

const author = {number: ' 123 ', title_en: ' Example manuscript ', raw_status: ' Review ',
  author_url: 'https://example.test/index.php/journal/authorDashboard/submission/123',
  last_activity: '2026-10-02'};
const editorial = {...author, number: '456',
  author_url: 'https://example.test/index.php/journal/workflow/index/456/1'};
assert.deepEqual(ojs34Rows([author, editorial]), {recognized: true, rows: [{number: '123',
  title_en: 'Example manuscript', raw_status: 'Review', submitted_at: '', status_date: ''}]});
assert.deepEqual(ojs34Rows([]), {recognized: true, rows: []});
assert.deepEqual(ojs34Rows([{...author, number: '999'}]), {recognized: false, rows: []});
assert.deepEqual(ojs34Rows([{...author, raw_status: ''}]), {recognized: false, rows: []});
assert.equal(ojs34Rows([{...author, notice: 'Revisions requested'}]).rows[0].raw_status, 'Revisions requested');
console.log('OJS 3.4 author roles, manuscript fields and date provenance passed.');
