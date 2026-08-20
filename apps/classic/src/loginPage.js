/**
 * Dedicated /login page — email/password + social providers.
 * On success, redirects into the main app shell.
 */
import { supabase } from './store.js';
import { getEnabledSocialProviders, signInWithSocialProvider } from './socialAuth.js';
import { goToApp, takeAuthFlash } from './authRedirect.js';
import { ensureAuthInitialized } from '@auth/authClient.js';

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

  const providers = supabase ? getEnabledSocialProviders() : [];
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
        const { error } = await signInWithSocialProvider(supabase, provider.id);
        if (error) setError(error.message);
      } catch (err) {
        setError(err?.message || 'Social sign-in failed.');
      } finally {
        setBusy(false);
      }
    });
    container.appendChild(btn);
  });
};

const syncBackendSession = async (session) => {
  const accessToken = session?.access_token;
  if (!accessToken) return;
  try {
    await fetch('/api/auth-session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    /* main app will retry */
  }
};

const enterApp = async (session) => {
  await syncBackendSession(session);
  goToApp();
};

const signIn = async () => {
  if (!supabase) return setError('Supabase is not configured.');
  const email = (emailEl?.value || '').trim();
  const password = (passEl?.value || '').trim();
  if (!email || !password) return setError('Email and password required.');
  setBusy(true);
  setError('');
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return setError(error.message);
    await enterApp(data.session);
  } catch (err) {
    setError(err?.message || 'Sign-in failed.');
  } finally {
    setBusy(false);
  }
};

const signUp = async () => {
  if (!supabase) return setError('Supabase is not configured.');
  const email = (emailEl?.value || '').trim();
  const password = (passEl?.value || '').trim();
  if (!email || !password) return setError('Email and password required.');
  setBusy(true);
  setError('');
  try {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return setError(error.message);
    if (!data.session) {
      setMode(false);
      return setError('Account created. Please verify your email, then sign in.', { ok: true });
    }
    await enterApp(data.session);
  } catch (err) {
    setError(err?.message || 'Could not create account.');
  } finally {
    setBusy(false);
  }
};

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
if (flash) setError(flash);

(async () => {
  if (!supabase) {
    setError('Supabase is not configured.');
    return;
  }
  try {
    const primed = await ensureAuthInitialized();
    if (primed?.session) {
      await enterApp(primed.session);
      return;
    }
    const { data } = await supabase.auth.getSession();
    if (data?.session) await enterApp(data.session);
  } catch (err) {
    console.warn('[login] session check failed:', err?.message || err);
  }
})();
