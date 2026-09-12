/**
 * Login: email/password via Mongo (/api/auth-password);
 * social via Firebase. Same email → same Mongo user_id.
 */
import { authClient } from './store.js';
import { getEnabledSocialProviders, signInWithSocialProvider, waitForBootAuthSession } from './socialAuth.js';
import { goToApp, takeAuthFlash } from './authRedirect.js';
import {
    resetAuthInit,
    setMongoSession,
    clearMongoSession,
    firebaseAuth,
} from '@auth/authClient.js';

const card = document.getElementById('login-card');
const form = document.getElementById('auth-form');
const emailEl = document.getElementById('auth-email');
const passEl = document.getElementById('auth-password');
const errorBox = document.getElementById('auth-error');
const errorText = document.getElementById('auth-error-text');
const loginBtn = document.getElementById('auth-login-btn');
const signupBtn = document.getElementById('auth-signup-btn');
const togglePassBtn = document.getElementById('auth-toggle-password');

let isSignUp = false;
let busy = false;

const isTrivialFlash = (msg) => {
  const t = String(msg || '').trim().toLowerCase();
  return !t || t === 'signed out.' || t === 'signed out';
};

const setError = (msg = '', { ok = false } = {}) => {
  if (!errorBox || !errorText) return;
  if (!msg || isTrivialFlash(msg)) {
    errorBox.classList.remove('is-visible', 'login-alert--ok');
    errorText.textContent = '';
    return;
  }
  errorText.textContent = msg;
  errorBox.classList.add('is-visible');
  errorBox.classList.toggle('login-alert--ok', !!ok);
};

const setBusy = (on) => {
  busy = !!on;
  [loginBtn, signupBtn, emailEl, passEl].forEach((el) => {
    if (el) el.disabled = !!on;
  });
  document.querySelectorAll('.login-social-btn').forEach((el) => {
    el.disabled = !!on;
  });
  if (!loginBtn) return;
  if (on) {
    loginBtn.textContent = isSignUp ? 'Creating…' : 'Signing in…';
  } else {
    loginBtn.innerHTML = '<span class="login-submit-label-signin">Sign in</span><span class="login-submit-label-signup">Create account</span>';
  }
};

const setMode = (signUp) => {
  isSignUp = !!signUp;
  card?.classList.toggle('login-mode-signin', !isSignUp);
  card?.classList.toggle('login-mode-signup', isSignUp);
  setError('');
};

const renderSocialAuthButtons = () => {
  const section = document.getElementById('auth-social-section');
  const container = document.getElementById('auth-social-buttons');
  if (!section || !container) return;

  const providers = firebaseAuth ? getEnabledSocialProviders() : [];
  container.replaceChildren();
  if (!providers.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  providers.forEach((provider) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'login-social-btn';
    btn.dataset.provider = provider.id;
    btn.setAttribute('aria-label', `Continue with ${provider.label}`);
    btn.innerHTML = `<i class="${provider.iconClass}" aria-hidden="true"></i><span>${provider.label}</span>`;
    btn.addEventListener('click', async () => {
      if (busy) return;
      setBusy(true);
      setError('');
      try {
        clearMongoSession();
        const { data, error } = await signInWithSocialProvider(authClient, provider.id);
        if (error) setError(error.message);
        else if (data?.session) await enterApp(data.session);
      } catch (err) {
        setError(err?.message || 'Social sign-in failed.');
      } finally {
        setBusy(false);
      }
    });
    container.appendChild(btn);
  });
};

const LOGIN_REDIRECT_GUARD_KEY = 'ch_login_redirect_guard';
let enteringApp = false;

const syncBackendSession = async (session) => {
  const accessToken = session?.access_token;
  if (!accessToken) {
    const err = new Error('No access token.');
    err.status = 401;
    throw err;
  }
  const res = await fetch('/api/auth-session', {
    method: 'POST',
    credentials: 'include',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error || `Could not establish session (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return json;
};

const enterApp = async (session) => {
  if (enteringApp) return;
  enteringApp = true;
  try {
    try {
      const n = Number(sessionStorage.getItem(LOGIN_REDIRECT_GUARD_KEY) || '0');
      if (n >= 3) {
        sessionStorage.removeItem(LOGIN_REDIRECT_GUARD_KEY);
        setError(
          'Sign-in loop stopped. Could not establish an app session. '
          + 'Check AUTH_SESSION_SECRET / Firebase Admin env (see docs/FIREBASE_AUTH.md).',
        );
        return;
      }
      sessionStorage.setItem(LOGIN_REDIRECT_GUARD_KEY, String(n + 1));
    } catch { /* ignore */ }

    await syncBackendSession(session);
    try {
      const {
        clearWorkspaceSessionCaches,
        hydrateWorkspaceSession,
      } = await import('@new/appShell/workspaceBoot.js');
      clearWorkspaceSessionCaches();
      await hydrateWorkspaceSession({ force: true });
    } catch (err) {
      console.warn('[login] workspace hydrate failed:', err?.message || err);
    }
    try {
      sessionStorage.removeItem(LOGIN_REDIRECT_GUARD_KEY);
    } catch { /* ignore */ }
    goToApp();
  } catch (err) {
    enteringApp = false;
    setError(err?.message || 'Signed in, but the app session failed.');
  }
};

async function passwordAuth(action) {
  const email = (emailEl?.value || '').trim();
  const password = (passEl?.value || '').trim();
  if (!email || !password) return setError('Email and password required.');
  setBusy(true);
  setError('');
  try {
    const res = await fetch('/api/auth-password', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, email, password }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error || 'Authentication failed.');
      return;
    }
    setMongoSession({
      access_token: json.access_token,
      user: json.user,
    });
    // Prefer Mongo session over any leftover Firebase client session.
    if (firebaseAuth?.currentUser) {
      try {
        const { signOut: fbSignOut } = await import('firebase/auth');
        await fbSignOut(firebaseAuth);
      } catch { /* ignore */ }
    }
    await enterApp({
      access_token: json.access_token,
      user: {
        id: json.user.id,
        email: json.user.email,
      },
    });
  } catch (err) {
    setError(err?.message || (action === 'signup' ? 'Could not create account.' : 'Sign-in failed.'));
  } finally {
    setBusy(false);
  }
}

const signIn = () => passwordAuth('login');
const signUp = () => passwordAuth('signup');

form?.addEventListener('submit', (e) => {
  e.preventDefault();
  void (isSignUp ? signUp() : signIn());
});

signupBtn?.addEventListener('click', () => {
  setMode(true);
  emailEl?.focus();
});

document.getElementById('auth-switch-signup')?.addEventListener('click', () => setMode(true));
document.getElementById('auth-switch-signin')?.addEventListener('click', () => setMode(false));

togglePassBtn?.addEventListener('click', () => {
  if (!passEl) return;
  const show = passEl.type === 'password';
  passEl.type = show ? 'text' : 'password';
  togglePassBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  const icon = togglePassBtn.querySelector('i');
  if (icon) icon.className = show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
});

window.addEventListener('auth-flash', (e) => {
  const msg = e?.detail?.message;
  if (msg) setError(msg);
});

renderSocialAuthButtons();
setMode(false);

const flash = takeAuthFlash();
const oauthParams = new URLSearchParams(window.location.search);
const hasOAuthCallback = !!oauthParams.get('code')
    || oauthParams.get('error')
    || window.location.hash.includes('access_token=');
const justSignedOut = /signed out/i.test(String(flash || '')) && !hasOAuthCallback;
if (flash && !justSignedOut && !hasOAuthCallback) setError(flash);
if (hasOAuthCallback && oauthParams.get('error')) {
    setError(oauthParams.get('error_description') || oauthParams.get('error') || 'Social sign-in failed.');
}

(async () => {
  if (justSignedOut) return;
  if (hasOAuthCallback) resetAuthInit();
  try {
    const { session, error } = await waitForBootAuthSession(authClient);
    if (error?.message) setError(error.message);
    if (session) await enterApp(session);
  } catch (err) {
    console.warn('[login] session check failed:', err?.message || err);
  }
})();
