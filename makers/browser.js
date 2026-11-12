const sessionStorageKey = 'bookshop-makers-session-v1';
let sessionId = localStorage.getItem(sessionStorageKey);
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId || '')) {
  sessionId = crypto.randomUUID();
  localStorage.setItem(sessionStorageKey, sessionId);
}

function requestBookshop(path, init = {}) {
  const data = init.body === undefined ? undefined : JSON.parse(init.body);
  return fetch('/bookshop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'makers-conversation-id': sessionId },
    body: JSON.stringify({ path, data }),
    signal: init.signal,
  });
}
