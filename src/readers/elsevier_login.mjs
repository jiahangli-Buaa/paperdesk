// Advance the existing Elsevier account login only on its official identity site.
// Registration, verification codes, and account linking remain in the visible login window.
export async function advanceElsevierLogin(page, credentials, progress) {
  if (new URL(page.url()).origin !== 'https://id.elsevier.com') return;
  const text = await page.locator('body').innerText();
  if (/incorrect (?:email|password)|invalid (?:email or password|credentials)|(?:邮箱|密码).{0,12}(?:不正确|错误)/i.test(text)) {
    throw new Error('elsevier_credentials_rejected');
  }
  const primary = page.locator('#bdd-elsPrimaryBtn');
  const email = page.locator('#bdd-email');
  const password = page.locator('input[type="password"]');
  if (await password.isVisible()) {
    if (progress.passwordSubmitted) return;
    if (!credentials.password) throw new Error('sso_login_required');
    if (!/^(?:sign in|log in|login|登录|登入)$/i.test((await primary.innerText()).trim())) {
      throw new Error('elsevier_action_required');
    }
    await password.fill(credentials.password);
    await primary.click();
    credentials.password = '';
    progress.passwordSubmitted = true;
  } else if (!progress.emailSubmitted && await email.isVisible()) {
    if (!/^(?:continue|next|继续|下一步)$/i.test((await primary.innerText()).trim())) {
      throw new Error('elsevier_action_required');
    }
    await email.fill(credentials.username);
    await primary.click();
    progress.emailSubmitted = true;
  } else {
    const individualLogin = page.locator('#bdd-elsSecondaryBtn-tryAnotherWay');
    if (!progress.selectedIndividual && await individualLogin.isVisible()) {
      await individualLogin.click();
      progress.selectedIndividual = true;
    }
  }
}
