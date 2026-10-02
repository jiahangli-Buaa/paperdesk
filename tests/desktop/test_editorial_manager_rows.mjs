import assert from 'node:assert/strict';
import {editorialManagerRows} from '../../src/readers/editorial_manager_rows.mjs';

const parsed = editorialManagerRows([[['Action', 'Manuscript Number', 'Title', 'Initial Date Submitted', 'Status Date', 'Current Status'],
  ['View Submission', 'EXAMPLE-001R1', 'Example manuscript', 'Sep 1 2026', 'Oct 2 2026', 'With Editor']]]);
assert.deepEqual(parsed, {recognized: true, rows: [{number: 'EXAMPLE-001R1', title_en: 'Example manuscript',
  submitted_at: 'Sep 1 2026', status_date: 'Oct 2 2026', raw_status: 'With Editor'}]});

const reordered = editorialManagerRows([[['Submission ID', 'Manuscript Title', 'Status', 'Submission Date'],
  ['EXAMPLE-002', 'Another manuscript', 'Under Review', '2026-09-02']]]);
assert.equal(reordered.rows[0].number, 'EXAMPLE-002');
assert.equal(reordered.rows[0].status_date, '');
assert.equal(reordered.rows[0].raw_status, 'Under Review');

const revision = [['Manuscript Number', 'Title', 'Action'], ['EXAMPLE-003', 'Revision example', 'Revise Submission']];
assert.equal(editorialManagerRows([revision], 'Submissions Needing Revision').rows[0].raw_status, 'Submissions Needing Revision');
assert.deepEqual(editorialManagerRows([revision], 'Submissions with a Decision'), {recognized: false, rows: []});
assert.deepEqual(editorialManagerRows([[['Title', 'Action'], ['Example', 'Submit']]]), {recognized: false, rows: []});
assert.deepEqual(editorialManagerRows([[['Manuscript Number', 'Title', 'Current Status']]]), {recognized: true, rows: []});
console.log('Editorial Manager reordered columns, original dates and revision queues passed.');
