async function init() {
  var webidEl = document.getElementById('webid');
  var fetchResultEl = document.getElementById('fetch-result');
  var statusEl = document.getElementById('status');

  // Wait for the solid extension to be available and authenticated
  function waitForSolid() {
    return new Promise(function (resolve) {
      if (window.solid && window.solid.webId) {
        return resolve(window.solid);
      }
      var interval = setInterval(function () {
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

  var solid = await waitForSolid();
  webidEl.textContent = solid.webId;
  webidEl.className = '';

  // Derive the pod storage root from the WebID
  // e.g. http://localhost:3000/test-pod/profile/card#me -> http://localhost:3000/test-pod/
  var podRoot = solid.webId.split('/profile/')[0] + '/';
  var privateUrl = podRoot + 'private/notes';

  statusEl.textContent = 'Authenticated! Fetching private resource...';

  try {
    var response = await solid.fetch(privateUrl);
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
}

init();
