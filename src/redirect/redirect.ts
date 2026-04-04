const params = new URLSearchParams(window.location.search);
const code = params.get('code');
const state = params.get('state');
const iss = params.get('iss');
const statusEl = document.getElementById('status')!;
const errorEl = document.getElementById('error')!;
const spinnerEl = document.getElementById('spinner')!;

if (code && state && iss) {
  chrome.runtime.sendMessage(
    {
      type: 'SOLID_HANDLE_REDIRECT',
      code,
      state,
      iss,
    },
    (response) => {
      spinnerEl.style.display = 'none';
      if (response?.error) {
        statusEl.textContent = 'Login failed';
        errorEl.textContent = response.error;
        errorEl.hidden = false;
      } else {
        statusEl.textContent = 'Logged in successfully!';
        statusEl.className = 'success';
        // Close this tab after a brief delay
        setTimeout(() => window.close(), 1500);
      }
    }
  );
} else {
  spinnerEl.style.display = 'none';
  statusEl.textContent = 'Invalid redirect';
  errorEl.textContent = 'Missing required parameters (code, state, or iss).';
  errorEl.hidden = false;
}
