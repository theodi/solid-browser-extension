const loginView = document.getElementById('login-view')!;
const loadingView = document.getElementById('loading-view')!;
const loggedInView = document.getElementById('logged-in-view')!;
const loginForm = document.getElementById('login-form') as HTMLFormElement;
const idpInput = document.getElementById('idp-url') as HTMLInputElement;
const loginError = document.getElementById('login-error')!;
const webidDisplay = document.getElementById('webid-display')!;
const logoutBtn = document.getElementById('logout-btn')!;

function showView(view: 'login' | 'loading' | 'logged-in') {
  loginView.hidden = view !== 'login';
  loadingView.hidden = view !== 'loading';
  loggedInView.hidden = view !== 'logged-in';
}

// Check current session state on popup open
chrome.runtime.sendMessage({ type: 'SOLID_GET_STATE' }, (response) => {
  if (response?.webId) {
    webidDisplay.textContent = response.webId;
    showView('logged-in');
  } else {
    showView('login');
  }
});

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  loginError.hidden = true;

  const idpUrl = idpInput.value.trim();
  if (!idpUrl) return;

  showView('loading');

  chrome.runtime.sendMessage(
    { type: 'SOLID_LOGIN', idpUrl },
    (response) => {
      if (response?.error) {
        loginError.textContent = response.error;
        loginError.hidden = false;
        showView('login');
      }
      // Login opens a new tab — popup will close.
      // When user returns, they'll reopen popup and see logged-in state.
    }
  );
});

logoutBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SOLID_LOGOUT' }, () => {
    showView('login');
  });
});

// Listen for state changes while popup is open
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SOLID_STATE_CHANGED') {
    if (message.webId) {
      webidDisplay.textContent = message.webId;
      showView('logged-in');
    } else {
      showView('login');
    }
  }
});
