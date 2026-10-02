// Recognize journal-specific ScholarOne entries independently of the journal name.
export function isScholarOneUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /^mc\d*\.manuscriptcentral\.com$/.test(url.hostname) &&
      /^\/[A-Za-z0-9][A-Za-z0-9_-]*\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function isEditorialManagerUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.editorialmanager.com' && !url.username && !url.password &&
      /^\/[A-Za-z0-9_-]+(?:\/(?:default2?\.aspx|login\.asp))?\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function isPaperCeptUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /^[a-z0-9-]+\.(?:paperplaza\.net|papercept\.net)$/.test(url.hostname) &&
      /^\/journals\/[A-Za-z0-9_-]+\/scripts\/login\.pl\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function ojs34Entry(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.match(/^(\/index\.php\/[A-Za-z0-9_-]+)(?:\/(?:login(?:\/signIn)?|submissions))?\/?$/);
    if (url.protocol !== 'https:' || url.username || url.password || !path) return null;
    return {login: url.origin + path[1] + '/login', submissions: url.origin + path[1] + '/submissions'};
  } catch {
    return null;
  }
}
