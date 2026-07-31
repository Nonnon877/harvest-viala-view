const ORIGIN = 'https://nonnon877.github.io';

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-headers': 'content-type,x-refresh-key',
      'access-control-allow-methods': 'POST,OPTIONS',
      'cache-control': 'no-store'
    }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return reply({ ok: true });
    if (request.method !== 'POST') return reply({ error: 'Not found' }, 404);
    if (request.headers.get('x-refresh-key') !== env.REFRESH_KEY) {
      return reply({ error: '認証に失敗しました。' }, 401);
    }

    const response = await fetch('https://api.github.com/repos/Nonnon877/harvest-viala-watch/actions/workflows/probe.yml/dispatches', {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.GH_ACCESS}`,
        'content-type': 'application/json',
        'user-agent': 'harvest-viala-refresh',
        'x-github-api-version': '2022-11-28'
      },
      body: JSON.stringify({ ref: 'main' })
    });

    if (!response.ok) return reply({ error: `GitHub API ${response.status}` }, 502);
    return reply({ ok: true, message: '取得を開始しました。' });
  }
};
