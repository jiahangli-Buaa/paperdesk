import assert from 'node:assert/strict';
import {isScholarOneUrl,isEditorialManagerUrl,isPaperCeptUrl,ojs34Entry} from '../../src/readers/portal_urls.mjs';

for (const url of ['https://mc.manuscriptcentral.com/taes',
  'https://mc03.manuscriptcentral.com/scis/', 'https://mc12.manuscriptcentral.com/future-journal']) {
  assert.equal(isScholarOneUrl(url), true);
}
for (const url of ['https://example.com/taes', 'https://mc.manuscriptcentral.com',
  'http://mc.manuscriptcentral.com/taes']) {
  assert.equal(isScholarOneUrl(url), false);
}
console.log('ScholarOne URL recognition passed');

for (const url of ['https://www.editorialmanager.com/example',
  'https://www.editorialmanager.com/another/default.aspx', 'https://www.editorialmanager.com/tim/default2.aspx']) {
  assert.equal(isEditorialManagerUrl(url), true);
}
for (const url of ['https://css.paperplaza.net/journals/tac/scripts/login.pl',
  'https://ras.papercept.net/journals/example/scripts/login.pl']) {
  assert.equal(isPaperCeptUrl(url), true);
}
for (const check of [isScholarOneUrl,isEditorialManagerUrl,isPaperCeptUrl]) {
  assert.equal(check('https://example.com/login'), false);
}
assert.equal(isEditorialManagerUrl('https://www.editorialmanager.com.example.com/journal'), false);
assert.equal(isPaperCeptUrl('https://css.paperplaza.net/conferences/scripts/start.pl'), false);
console.log('Editorial Manager and PaperCept journal entry recognition passed');

assert.deepEqual(ojs34Entry('https://ojs.example.test/index.php/journal/login'), {
  login: 'https://ojs.example.test/index.php/journal/login',
  submissions: 'https://ojs.example.test/index.php/journal/submissions'
});
assert.equal(ojs34Entry('https://ojs.example.test/index.php/journal/en/login'), null);
assert.equal(ojs34Entry('https://ojs.example.test/login'), null);
console.log('OJS 3.4 standard journal paths passed');
