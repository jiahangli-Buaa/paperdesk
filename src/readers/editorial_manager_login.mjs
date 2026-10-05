// Recognize the login form and author pages across EM's top page and content frame.
export async function ensureEditorialManagerLogin(page, input, {
  dismissCookies = async () => {}, onStage = () => {}, timeout = input.interactive ? 120000 : 20000
} = {}) {
  let deadline = Date.now() + timeout, submitted = false, openedLogin = false;
  try {
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error('login_incomplete');
      await dismissCookies();
      const frames = page.frames();
      for (const frame of frames) {
        if (await frame.locator('#logoutLink').isVisible().catch(() => false) ||
            await frame.getByRole('heading', {name: 'Author Main Menu', exact: true}).first().isVisible().catch(() => false) ||
            await frame.locator('#datatable').isVisible().catch(() => false)) return;
      }
      if (!submitted) {
        let formFound = false;
        for (const frame of frames) {
          const password = frame.locator('input[type="password"]:visible').first();
          const username = frame.locator('input[name="username" i]:visible, input[id="username" i]:visible').first();
          const authorLogin = frame.getByRole('button', {name: /^Author Login$/i}).first();
          if (!await password.isVisible().catch(() => false) || !await username.isVisible().catch(() => false) ||
              !await authorLogin.isVisible().catch(() => false)) continue;
          formFound = true;
          // With an interactive window, the user can finish login themselves.
          if (!input.username || !input.password) break;
          onStage('credentials');
          await username.fill(input.username);
          await password.fill(input.password);
          input.password = '';
          await authorLogin.click();
          submitted = true;
          onStage('signed-in');
          deadline = Date.now() + (input.interactive ? 120000 : 60000);
          break;
        }
        if (!formFound && !openedLogin) {
          for (const frame of frames) {
            const login = frame.getByRole('link', {name: /^Login$/i}).first();
            if (await login.isVisible().catch(() => false)) {
              await login.click();
              openedLogin = true;
              break;
            }
          }
        }
      }
      await page.waitForTimeout(250);
    }
    throw new Error('login_incomplete');
  } finally {
    input.password = '';
  }
}
