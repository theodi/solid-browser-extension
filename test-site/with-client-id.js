async function init() {
  var clientIdEl = document.getElementById('client-id-display');
  var webidInput = document.getElementById('webid-input');
  var loginBtn = document.getElementById('login-btn');
  var webidEl = document.getElementById('webid');
  var fetchResultEl = document.getElementById('fetch-result');
  var statusEl = document.getElementById('status');

  if (!window.solid) {
    statusEl.textContent = 'Solid extension not detected';
    statusEl.className = 'error';
    return;
  }

  statusEl.textContent = 'Extension detected. Loading client ID...';

  // Fetch the client ID from the server config
  try {
    var configRes = await fetch('/config.json');
    var config = await configRes.json();

    if (config.clientIdUrl) {
      window.solid.setClientId(config.clientIdUrl);
      clientIdEl.textContent = config.clientIdUrl;
      clientIdEl.className = '';
      statusEl.textContent = 'Client ID set. Enter your WebID and click Login.';
    } else {
      clientIdEl.textContent = 'No client ID configured on this server';
      clientIdEl.className = 'error';
      statusEl.textContent = 'Server has no clientIdUrl in config.';
      statusEl.className = 'error';
    }
  } catch (err) {
    clientIdEl.textContent = 'Failed to load config: ' + err.message;
    clientIdEl.className = 'error';
    statusEl.textContent = 'Config error';
    statusEl.className = 'error';
    return;
  }

  // Login button handler
  loginBtn.addEventListener('click', async function () {
    var webId = webidInput.value.trim();
    if (!webId) return;

    statusEl.textContent = 'Logging in...';
    statusEl.className = '';

    try {
      await window.solid.login(webId);
    } catch (err) {
      statusEl.textContent = 'Login error: ' + err.message;
      statusEl.className = 'error';
      return;
    }
  });

  // Poll for authentication state
  var interval = setInterval(async function () {
    if (!window.solid.webId) return;
    clearInterval(interval);

    webidEl.textContent = window.solid.webId;
    webidEl.className = '';

    var podRoot = window.solid.webId.split('/profile/')[0] + '/';
    var privateUrl = podRoot + 'private/notes';

    statusEl.textContent = 'Authenticated! Fetching private resource...';

    try {
      var response = await window.solid.fetch(privateUrl);
      if (response.ok) {
        var text = await response.text();
        fetchResultEl.textContent = text;
        fetchResultEl.className = '';
        statusEl.textContent = 'Private resource fetched successfully!';
      } else {
        fetchResultEl.textContent = 'HTTP ' + response.status + ': ' + response.statusText;
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
  }, 200);
}

init();
