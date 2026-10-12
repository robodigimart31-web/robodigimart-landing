(() => {
  'use strict';

  const idleLimitMs = 30 * 60 * 1000;
  const activityPrefix = 'helix:portal:last-activity:';
  const logoutKey = 'helix:portal:idle-logout';
  const loginUrl = '/vip/login?reason=idle';
  const supabaseUrl = 'https://wouwoefzghecuiknznvs.supabase.co';
  const publishableKey = 'sb_publishable_FDLLBcmYFGiS9PDbyvgDtQ_UWUB8fUc';
  if (!location.pathname.startsWith('/vip/') || location.pathname.startsWith('/vip/login')) return;
  if (!window.supabase?.createClient) return;

  const client = window.supabase.createClient(supabaseUrl, publishableKey);
  let userId = null;
  let activityKey = null;
  let lastWrite = 0;
  let signedOut = false;

  function lastActivity() {
    const value = Number(localStorage.getItem(activityKey));
    return Number.isFinite(value) && value > 0 ? value : Date.now();
  }

  async function endIdleSession() {
    if (signedOut || !userId) return;
    signedOut = true;
    localStorage.setItem(logoutKey, JSON.stringify({ userId, at: Date.now() }));
    try { await client.auth.signOut({ scope: 'local' }); } catch { /* Continue to the login screen. */ }
    location.replace(loginUrl);
  }

  function checkIdle() {
    if (userId && Date.now() - lastActivity() >= idleLimitMs) void endIdleSession();
  }

  function recordActivity() {
    if (!userId || signedOut || document.visibilityState === 'hidden') return;
    checkIdle();
    if (signedOut) return;
    const now = Date.now();
    if (now - lastWrite < 5_000) return;
    lastWrite = now;
    localStorage.setItem(activityKey, String(now));
  }

  window.addEventListener('storage', event => {
    if (activityKey && event.key === activityKey) checkIdle();
    if (event.key === logoutKey && event.newValue) {
      try {
        const logout = JSON.parse(event.newValue);
        if (logout.userId === userId && Date.now() - logout.at < 60_000) location.replace(loginUrl);
      } catch { /* Ignore malformed cross-tab state. */ }
    }
  });

  for (const eventName of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'mousemove']) {
    window.addEventListener(eventName, recordActivity, { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recordActivity();
  });
  window.addEventListener('focus', recordActivity);
  window.addEventListener('pageshow', checkIdle);
  window.setInterval(checkIdle, 5_000);

  client.auth.getSession().then(({ data: { session } }) => {
    if (!session?.user?.id || signedOut) return;
    userId = session.user.id;
    activityKey = `${activityPrefix}${userId}`;
    if (!localStorage.getItem(activityKey)) localStorage.setItem(activityKey, String(Date.now()));
    checkIdle();
  }).catch(() => {});
})();
