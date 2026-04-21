var PRIVATE_URL_TEMPLATE = function (webId) {
  return webId.split('/profile/')[0] + '/private/notes';
};

var ICONS = {
  idle: '–',
  spinner: '', // rendered as a CSS-spin div
  check: '\u2713',
  cross: '\u2717',
};

var clientIdEl = document.getElementById('client-id-display');
var webidEl = document.getElementById('webid');
var accessBtn = document.getElementById('access-btn');
var statusIconEl = document.getElementById('status-icon');
var statusTextEl = document.getElementById('status-text');
var fetchResultEl = document.getElementById('fetch-result');

function setStatus(state, text) {
  statusIconEl.className = 'status-icon ' + (state === 'loading' ? 'idle' : state);
  if (state === 'loading') {
    statusIconEl.innerHTML = '';
    var spin = document.createElement('div');
    spin.className = 'spinner';
    statusIconEl.appendChild(spin);
  } else if (state === 'success') {
    statusIconEl.textContent = ICONS.check;
  } else if (state === 'error') {
    statusIconEl.textContent = ICONS.cross;
  } else {
    statusIconEl.textContent = ICONS.idle;
  }
  statusTextEl.textContent = text;
  statusTextEl.className = 'status-text ' + (state === 'error' ? 'error' : 'muted');
}

async function fetchPrivateResource() {
  var webId = window.solid && window.solid.webId;
  if (!webId) {
    setStatus('error', 'Not signed in to the extension. Open the extension popup to sign in.');
    return;
  }

  accessBtn.disabled = true;
  setStatus('loading', 'Signing into the application…');
  fetchResultEl.textContent = '';
  fetchResultEl.className = 'waiting';

  var url = PRIVATE_URL_TEMPLATE(webId);

  async function performFetch() {
    var response = await window.solid.fetch(url);
    if (response.ok) {
      var text = await response.text();
      setStatus('success', 'Signed in. Private resource fetched.');
      fetchResultEl.textContent = text;
      fetchResultEl.className = '';
    } else {
      setStatus('error', 'Fetch denied: HTTP ' + response.status + ' ' + response.statusText);
      fetchResultEl.textContent = 'HTTP ' + response.status + ': ' + response.statusText;
      fetchResultEl.className = 'error';
    }
  }

  try {
    await performFetch();
  } catch (err) {
    setStatus('error', 'Fetch error: ' + (err && err.message || err));
  } finally {
    accessBtn.disabled = false;
  }
}

async function init() {
  if (!window.solid) {
    webidEl.textContent = 'Solid extension not detected in this browser.';
    webidEl.className = 'error';
    setStatus('error', 'Install and enable the Solid extension to continue.');
    return;
  }

  try {
    var configRes = await fetch('/config.json');
    var config = await configRes.json();
    if (config.clientIdUrl) {
      window.solid.setClientId(config.clientIdUrl);
      clientIdEl.textContent = config.clientIdUrl;
      clientIdEl.className = '';
    } else {
      clientIdEl.textContent = 'Server has no clientIdUrl in config.';
      clientIdEl.className = 'error';
    }
  } catch (err) {
    clientIdEl.textContent = 'Failed to load config: ' + err.message;
    clientIdEl.className = 'error';
  }

  accessBtn.addEventListener('click', fetchPrivateResource);

  // Poll for the signed-in WebID — the extension broadcasts it once its
  // session is restored.
  var interval = setInterval(function () {
    if (!window.solid.webId) return;
    clearInterval(interval);
    webidEl.textContent = window.solid.webId;
    webidEl.className = '';
    accessBtn.disabled = false;
    setStatus('idle', 'Click the button to fetch the private note.');
  }, 200);

  // If the user is not signed in to the extension, surface a hint after a
  // short timeout so the button isn't silently disabled forever.
  setTimeout(function () {
    if (!window.solid.webId) {
      webidEl.textContent = 'Not signed in to the extension.';
      webidEl.className = 'error';
      setStatus('error', 'Open the extension popup and sign in to continue.');
    }
  }, 2000);
}

init();
