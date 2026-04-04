const loginView = document.getElementById('login-view')!;
const loadingView = document.getElementById('loading-view')!;
const loggedInView = document.getElementById('logged-in-view')!;
const loginForm = document.getElementById('login-form') as HTMLFormElement;
const webidInput = document.getElementById('webid-input') as HTMLInputElement;
const webidFormContainer = document.getElementById('webid-form-container')!;
const loginError = document.getElementById('login-error')!;
const logoutBtn = document.getElementById('logout-btn')!;
const profilePhoto = document.getElementById('profile-photo') as HTMLImageElement;
const profileInitials = document.getElementById('profile-initials')!;
const profileName = document.getElementById('profile-name')!;
const pastProfilesContainer = document.getElementById('past-profiles')!;

interface PastProfile {
  webId: string;
  name: string | null;
  photoUrl: string | null;
}

function showView(view: 'login' | 'loading' | 'logged-in') {
  loginView.hidden = view !== 'login';
  loadingView.hidden = view !== 'loading';
  loggedInView.hidden = view !== 'logged-in';
}

function getInitials(name: string | null): string {
  if (name) {
    return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  }
  return 'S';
}

function renderAvatar(
  photoEl: HTMLImageElement,
  initialsEl: HTMLElement,
  name: string | null,
  photoUrl: string | null,
) {
  if (photoUrl) {
    photoEl.src = photoUrl;
    photoEl.alt = name || '';
    photoEl.hidden = false;
    initialsEl.hidden = true;
  } else {
    photoEl.hidden = true;
    initialsEl.hidden = false;
    initialsEl.textContent = getInitials(name);
  }
}

function showLoggedInProfile(name: string | null, photoUrl: string | null) {
  profileName.textContent = name || 'Solid User';
  renderAvatar(profilePhoto, profileInitials, name, photoUrl);
  showView('logged-in');
}

function renderPastProfiles(profiles: PastProfile[]) {
  pastProfilesContainer.innerHTML = '';

  if (profiles.length === 0) {
    // No past profiles — show the WebID form directly
    webidFormContainer.hidden = false;
    return;
  }

  // Hide the form by default when there are past profiles
  webidFormContainer.hidden = true;

  const label = document.createElement('div');
  label.className = 'past-profiles-label';
  label.textContent = 'Recent accounts';
  pastProfilesContainer.appendChild(label);

  for (const p of profiles) {
    const btn = document.createElement('button');
    btn.className = 'past-profile-item';
    btn.type = 'button';

    const displayName = p.name || 'Solid User';
    const initials = getInitials(p.name);

    if (p.photoUrl) {
      btn.innerHTML = `
        <img class="past-profile-photo" src="${escapeHtml(p.photoUrl)}" alt="" />
        <div class="past-profile-name">${escapeHtml(displayName)}</div>`;
    } else {
      btn.innerHTML = `
        <div class="past-profile-initials">${escapeHtml(initials)}</div>
        <div class="past-profile-name">${escapeHtml(displayName)}</div>`;
    }

    btn.addEventListener('click', () => {
      doLogin(p.webId);
    });

    pastProfilesContainer.appendChild(btn);
  }

  // "Add account" button
  const addBtn = document.createElement('button');
  addBtn.className = 'past-profile-item add-account-btn';
  addBtn.type = 'button';
  addBtn.innerHTML = `
    <div class="past-profile-initials add-account-icon">+</div>
    <div class="past-profile-name">Add account</div>`;
  addBtn.addEventListener('click', () => {
    webidFormContainer.hidden = false;
    webidInput.focus();
  });
  pastProfilesContainer.appendChild(addBtn);
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function doLogin(webId: string) {
  loginError.hidden = true;
  showView('loading');

  chrome.runtime.sendMessage(
    { type: 'SOLID_LOGIN', webId },
    (response) => {
      if (response?.error) {
        loginError.textContent = response.error;
        loginError.hidden = false;
        showView('login');
      }
    }
  );
}

// Check current session state on popup open
chrome.runtime.sendMessage({ type: 'SOLID_GET_STATE' }, (response) => {
  if (response?.webId) {
    showLoggedInProfile(response.profileName, response.profilePhotoUrl);
  } else {
    renderPastProfiles(response?.pastProfiles ?? []);
    showView('login');
  }
});

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const webId = webidInput.value.trim();
  if (!webId) return;
  doLogin(webId);
});

logoutBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SOLID_LOGOUT' }, () => {
    chrome.runtime.sendMessage({ type: 'SOLID_GET_STATE' }, (response) => {
      renderPastProfiles(response?.pastProfiles ?? []);
      showView('login');
    });
  });
});

// Listen for state changes while popup is open
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SOLID_STATE_CHANGED') {
    if (message.webId) {
      chrome.runtime.sendMessage({ type: 'SOLID_GET_STATE' }, (response) => {
        showLoggedInProfile(response.profileName, response.profilePhotoUrl);
      });
    } else {
      chrome.runtime.sendMessage({ type: 'SOLID_GET_STATE' }, (response) => {
        renderPastProfiles(response?.pastProfiles ?? []);
        showView('login');
      });
    }
  }
});
