import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function reportAlert({ token, repository, key, state, message, runUrl, assignee, fetcher = fetch }) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[a-z-]+$/.test(key ?? '')
    || !['failure', 'recovered'].includes(state)) throw new Error('Invalid GitHub alert configuration');
  const title = `[Biwenger auctions] ${key}`;
  const marker = `<!-- biwenger-auction-alert:${key} -->`;
  const fingerprint = `<!-- status:${createHash('sha256').update(message).digest('hex')} -->`;
  const request = async (path, method = 'GET', body) => {
    let response;
    try {
      response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
    } catch { throw new Error('GitHub alert request failed or timed out'); }
    if (!response.ok) throw new Error(`GitHub alert request failed with HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  let issue;
  for (let page = 1; ; page++) {
    const issues = await request(`/issues?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(issues)) throw new Error('Unexpected GitHub issues response');
    issue = issues.find((entry) => !entry.pull_request && entry.title === title
      && typeof entry.body === 'string' && entry.body.includes(marker));
    if (issue || issues.length < 100) break;
  }
  if (state === 'recovered') {
    if (!issue) return 'unchanged';
    await request(`/issues/${issue.number}/comments`, 'POST', { body: `Recuperado: ${message}\n\n[Ejecucion](${runUrl})` });
    await request(`/issues/${issue.number}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
    return 'resolved';
  }
  if (issue?.body.includes(fingerprint)) return 'unchanged';
  const body = `${marker}\n${fingerprint}\n${message}\n\n[Ejecucion con los logs](${runUrl})\n\nIncidencia gestionada automaticamente; se cerrara cuando se confirme la recuperacion.`;
  if (issue) {
    await request(`/issues/${issue.number}`, 'PATCH', { body });
    return 'updated';
  }
  await request('/issues', 'POST', { title, body, ...(assignee ? { assignees: [assignee] } : {}) });
  return 'created';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let message = process.env.AUCTION_ALERT_MESSAGE ?? 'La automatizacion de subastas ha fallado. Revisar los logs antes del siguiente ciclo de Biwenger.';
    if (process.env.AUCTION_ALERT_MESSAGE_FILE) {
      try { message = await readFile(process.env.AUCTION_ALERT_MESSAGE_FILE, 'utf8'); } catch { /* Keep fallback if setup failed. */ }
    }
    const result = await reportAlert({
      token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
      repository: process.env.GITHUB_REPOSITORY,
      key: process.env.AUCTION_ALERT_KEY,
      state: process.env.AUCTION_ALERT_STATE,
      message,
      assignee: process.env.AUCTION_ALERT_ASSIGNEE,
      runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    });
    console.log(`GitHub auction alert: ${result}`);
  } catch (error) {
    console.error(error instanceof Error && /^GitHub alert request failed|^Invalid GitHub alert configuration|^Unexpected GitHub issues response/.test(error.message)
      ? error.message : 'GitHub auction alert delivery failed');
    process.exitCode = 1;
  }
}
