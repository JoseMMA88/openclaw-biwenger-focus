import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function reportAlert({ token, repository, key, state, message, runUrl, assignee, issueNumber, fetcher = fetch }) {
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
  if (issueNumber !== undefined) {
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error('Invalid GitHub alert configuration');
    issue = await request(`/issues/${issueNumber}`);
    if (issue.pull_request || issue.title !== title || !issue.body?.includes(marker)) {
      throw new Error('Unexpected GitHub issues response');
    }
  }
  for (let page = 1; !issue; page++) {
    const issues = await request(`/issues?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(issues)) throw new Error('Unexpected GitHub issues response');
    issue = issues.find((entry) => !entry.pull_request && entry.title === title
      && typeof entry.body === 'string' && entry.body.includes(marker));
    if (issue || issues.length < 100) break;
  }
  if (state === 'recovered') {
    if (!issue || issue.state === 'closed') return { status: 'unchanged', issueNumber: issue?.number };
    await request(`/issues/${issue.number}/comments`, 'POST', { body: `Recuperado: ${message}\n\n[Ejecucion](${runUrl})` });
    await request(`/issues/${issue.number}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
    return { status: 'resolved', issueNumber: issue.number };
  }
  if (issue?.body.includes(fingerprint)) return { status: 'unchanged', issueNumber: issue.number };
  const body = `${marker}\n${fingerprint}\n${message}\n\n[Ejecucion con los logs](${runUrl})\n\nIncidencia gestionada automaticamente; se cerrara cuando se confirme la recuperacion.`;
  if (issue) {
    await request(`/issues/${issue.number}`, 'PATCH', { body });
    return { status: 'updated', issueNumber: issue.number };
  }
  const created = await request('/issues', 'POST', { title, body, ...(assignee ? { assignees: [assignee] } : {}) });
  return { status: 'created', issueNumber: created.number };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let message = process.env.AUCTION_ALERT_MESSAGE ?? 'La automatizacion de subastas ha fallado. Revisar los logs antes del siguiente ciclo de Biwenger.';
    if (process.env.AUCTION_ALERT_MESSAGE_FILE) {
      try { message = await readFile(process.env.AUCTION_ALERT_MESSAGE_FILE, 'utf8'); } catch { /* Keep fallback if setup failed. */ }
    }
    const options = {
      token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
      repository: process.env.GITHUB_REPOSITORY,
      key: process.env.AUCTION_ALERT_KEY,
      state: process.env.AUCTION_ALERT_STATE,
      message,
      assignee: process.env.AUCTION_ALERT_ASSIGNEE,
      runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    };
    if (process.argv[2] === 'self-test') {
      const created = await reportAlert({ ...options, state: 'failure' });
      console.log(`GitHub auction alert test: ${created.status}`);
      if (!created.issueNumber) throw new Error('Unexpected GitHub issues response');
      const closed = await reportAlert({ ...options, state: 'recovered', issueNumber: created.issueNumber });
      if (closed.status !== 'resolved') throw new Error('GitHub alert test did not confirm recovery');
      console.log('GitHub auction alert test: resolved');
    } else {
      const result = await reportAlert(options);
      console.log(`GitHub auction alert: ${result.status}`);
    }
  } catch (error) {
    console.error(error instanceof Error && /^GitHub alert request failed|^Invalid GitHub alert configuration|^Unexpected GitHub issues response/.test(error.message)
      ? error.message : 'GitHub auction alert delivery failed');
    process.exitCode = 1;
  }
}
