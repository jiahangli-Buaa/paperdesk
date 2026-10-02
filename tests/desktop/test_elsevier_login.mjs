import assert from 'node:assert/strict';
import {advanceElsevierLogin} from '../../src/readers/elsevier_login.mjs';
import {isEditorialManagerUrl} from '../../src/readers/portal_urls.mjs';

assert.equal(isEditorialManagerUrl('https://www.editorialmanager.com/aescte/'),true);
assert.equal(isEditorialManagerUrl('https://www.editorialmanager.com/aescte/default.aspx'),true);
assert.equal(isEditorialManagerUrl('https://example.test/aescte'),false);

const operations=[];
let phase='email';
const page={
  url:()=> 'https://id.elsevier.com/as/authorization.oauth2',
  locator:selector=>({
    isVisible:async()=>selector==='#bdd-email'?phase==='email':selector==='input[type="password"]'?phase==='password':false,
    innerText:async()=>selector==='body'?'Existing account sign-in':phase==='email'?'继续':'Sign in',
    fill:async value=>operations.push([selector,value]),
    click:async()=>{operations.push([selector,'click']);phase='password';}
  })
};
const credentials={username:'test@example.test',password:'synthetic-secret'};
const progress={};
await advanceElsevierLogin(page,credentials,progress);
await advanceElsevierLogin(page,credentials,progress);
await advanceElsevierLogin(page,credentials,progress);
assert.deepEqual(operations,[['#bdd-email','test@example.test'],['#bdd-elsPrimaryBtn','click'],
  ['input[type="password"]','synthetic-secret'],['#bdd-elsPrimaryBtn','click']]);
assert.equal(credentials.password,'');
assert.equal(progress.passwordSubmitted,true);

// A registration screen must remain for the user to handle.
const registration={...page,locator:selector=>({...page.locator(selector),innerText:async()=>selector==='body'?'Create an account':'Register'})};
await assert.rejects(()=>advanceElsevierLogin(registration,{username:'test@example.test',password:'synthetic-secret'},{}),/elsevier_action_required/);
const otherOrigin={...page,url:()=> 'https://example.test/login'};
await advanceElsevierLogin(otherOrigin,{username:'test@example.test',password:'synthetic-secret'},{});
assert.equal(operations.length,4);
console.log('Elsevier staged login passed');
