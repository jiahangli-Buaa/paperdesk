import assert from 'node:assert/strict';
import {paperceptRows} from '../../src/readers/papercept_rows.mjs';
const parsed=paperceptRows([[['Submission number','Title','Status','Date received'],
  ['26-1234','Tracked paper','Under review','2026-09-01']]]);
assert.deepEqual(parsed,{recognized:true,rows:[{number:'26-1234',title_en:'Tracked paper',
  raw_status:'Under review',submitted_at:'2026-09-01',status_date:''}]});
assert.deepEqual(paperceptRows([[['Title','Action'],['Paper','Submit']]]),{recognized:false,rows:[]});
// PaperCept's first column is a row index; the journal number is a separate column.
const authorPage=paperceptRows([[['Author submissions'],['#','Required action by the corresponding author',
  'Submission number','Version','Type of submission','Status','Title','Authors','Date first received',
  'Date of latest action or decision','Hide'],['1','None','26-1234','1','Full Paper','Under review',
  'Tracked paper','Test Author','August 14, 2026','August 19, 2026','']]]);
assert.equal(authorPage.rows[0].number,'26-1234');
assert.equal(authorPage.rows[0].submitted_at,'August 14, 2026');
assert.equal(authorPage.rows[0].status_date,'');
console.log('PaperCept labeled rows and unknown layout checks passed');
