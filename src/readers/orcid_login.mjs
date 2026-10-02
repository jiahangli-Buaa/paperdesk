// Passwords are supplied in memory by the local keychain reader.
export async function submitOrcidCredentials(page, username, password) {
  if (new URL(page.url()).origin !== 'https://orcid.org') throw new Error('orcid_login_incomplete');
  const reject = page.locator('#onetrust-reject-all-handler');
  await reject.waitFor({state:'visible',timeout:4000}).catch(error=>{if(error.name!=='TimeoutError')throw error;});
  if(await reject.isVisible()) await reject.click();
  await page.locator('#username-input').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#signin-button').click();
}
