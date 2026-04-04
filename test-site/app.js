async function init() {
  const webidEl = document.getElementById('webid');
  const fetchResultEl = document.getElementById('fetch-result');
  const statusEl = document.getElementById('status');

  // Wait for the solid extension to be available and authenticated
  function waitForSolid() {
    return new Promise((resolve) => {
      // Check immediately
      if (window.solid && window.solid.webId) {
        return resolve(window.solid);
      }
      // Poll every 200ms
      const interval = setInterval(() => {
        if (window.solid && window.solid.webId) {
          clearInterval(interval);
          resolve(window.solid);
        }
      }, 200);
    });
  }

  if (!window.solid) {
    statusEl.textContent = 'Solid extension not detected';
    statusEl.className = 'error';
    return;
  }

  statusEl.textContent = 'Extension detected, waiting for authentication...';

  const solid = await waitForSolid();
  webidEl.textContent = solid.webId;
  webidEl.className = '';
  statusEl.textContent = 'Authenticated! Fetching profile...';

  try {
    // Fetch the user's profile card using authenticated fetch
    const response = await solid.fetch(solid.webId);
    if (response.ok) {
      const text = await response.text();
      fetchResultEl.textContent = text;
      fetchResultEl.className = '';
      statusEl.textContent = 'Profile fetched successfully!';
    } else {
      fetchResultEl.textContent = `HTTP ${response.status}: ${response.statusText}`;
      fetchResultEl.className = 'error';
      statusEl.textContent = 'Fetch failed';
      statusEl.className = 'error';
    }
  } catch (err) {
    fetchResultEl.textContent = err.message;
    fetchResultEl.className = 'error';
    statusEl.textContent = 'Fetch error';
    statusEl.className = 'error';
  }
}

init();
