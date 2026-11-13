// The course player in the browser. It signs in through the learning account that is already
// here (a provisional Interego guest, or an existing owner) and then asks this bridge to launch
// the course named on the page. No course is named in this file.
import { guestFreshCredential, guestLearningSignIn, guestPossessionProof, learningGuestSignIn } from '/learn/guest.js';

const page = document.body;
const courseId = page.dataset.courseId;
const auId = page.dataset.auId || '';
const status = document.getElementById('status');
const consent = document.getElementById('consent');
const start = document.getElementById('start');
const signin = document.getElementById('signin');
const claim = document.getElementById('claim');
let provision = null;

const say = (text) => { status.textContent = text; };
const session = async () => {
  const response = await fetch('/i2idlx/learning/session', { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('sign-in is not available');
  return response.json();
};

function identityOrigin(config) {
  try { return new URL(config.bootstrap_url).origin; } catch { return ''; }
}

function showAccount(current) {
  signin.replaceChildren();
  if (!current.authenticated && current.sign_in_url) {
    const link = document.createElement('a');
    link.className = 'btn';
    const next = location.pathname + location.search;
    link.href = current.sign_in_url + (current.sign_in_url.includes('?') ? '&' : '?') + 'next=' + encodeURIComponent(next);
    link.textContent = 'Sign in with an existing Interego account';
    signin.append(link);
  }
  claim.replaceChildren();
  if (current.authenticated && current.guest && current.guest_sign_in) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Keep this guest — add a passkey, wallet or DID';
    button.addEventListener('click', () => { void keepGuest(current); });
    claim.append(button, ' ');
  }
  if (current.authenticated && !current.guest && current.guest_sign_in) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Link the guest this browser kept';
    button.addEventListener('click', () => { void linkGuest(current); });
    claim.append(button, ' ');
  }
  if (current.authenticated) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Delete guest recording';
    button.addEventListener('click', () => { void forget(current); });
    claim.append(button);
  }
}

async function launch(current) {
  if (!consent.checked) { say('Agree to the recording first.'); return; }
  const body = { course_id: courseId, tracking_consent: true };
  if (auId) body.au_id = auId;
  const response = await fetch('/learn/launch', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-I2IDLX-Learning-CSRF': current.csrf },
    body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) { say(typeof value.error === 'string' ? value.error : 'The course could not be started.'); return; }
  if (typeof value.launchUrl === 'string') location.assign(value.launchUrl);
}

async function keepGuest(current) {
  const config = learningGuestSignIn(current.guest_sign_in, location.origin);
  const created = await guestFreshCredential(config, { confirmTerms: (terms) => confirm(terms) });
  const origin = identityOrigin(current.guest_sign_in);
  if (!origin || !created.token) { say('This guest could not be opened for a passkey or wallet just now.'); return; }
  location.assign(origin + '/connect?claim=' + encodeURIComponent(created.token));
}

async function linkGuest(current) {
  const config = learningGuestSignIn(current.guest_sign_in, location.origin);
  const proof = await guestPossessionProof(config);
  if (!proof) { say('This browser is not keeping a guest.'); return; }
  const response = await fetch('/learn/link', {
    method: 'POST', credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-I2IDLX-Learning-CSRF': current.csrf },
    body: JSON.stringify(proof),
  });
  const value = await response.json().catch(() => ({}));
  say(response.ok ? 'Linked. The original statements are unchanged.' : (typeof value.error === 'string' ? value.error : 'The link was not recorded.'));
}

async function forget(current) {
  let token = provision && provision.token;
  if (!token && current.guest && current.guest_sign_in) {
    try {
      const created = await guestFreshCredential(learningGuestSignIn(current.guest_sign_in, location.origin), { confirmTerms: (terms) => confirm(terms) });
      token = created.token;
    } catch { token = ''; }
  }
  const response = await fetch('/learn/forget', {
    method: 'POST', credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-I2IDLX-Learning-CSRF': current.csrf },
    body: '{}',
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) { say(typeof value.error === 'string' ? value.error : 'The recording could not be deleted.'); return; }
  if (token && value.identityDelete && typeof value.identityDelete.url === 'string') {
    await fetch(value.identityDelete.url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}', credentials: 'omit' }).catch(() => undefined);
  }
  say(token ? 'The recording was deleted, and the guest account was asked to close.' : 'The recording was deleted. The guest account itself could not be closed just now.');
}

start.addEventListener('click', () => {
  void (async () => {
    start.disabled = true;
    try {
      let current = await session();
      if (!current.authenticated) {
        if (!current.guest_sign_in) { say(current.sign_in_url ? 'Sign in with an existing account. Guest start is not turned on here.' : 'Sign-in is not turned on here.'); showAccount(current); return; }
        if (!consent.checked) { say('Agree to the recording first.'); return; }
        const config = learningGuestSignIn(current.guest_sign_in, location.origin);
        await guestLearningSignIn(config, {
          confirmTerms: (terms) => confirm(terms),
          onProvisioned: (value) => { provision = value; },
        });
        current = await session();
      }
      showAccount(current);
      await launch(current);
    } catch (error) {
      say(error && error.message ? error.message : 'The course could not be started.');
    } finally { start.disabled = false; }
  })();
});

function confirm(terms) {
  const statement = terms && typeof terms.statement === 'string' ? terms.statement : '';
  const termsUrl = terms && typeof terms.termsUrl === 'string' ? terms.termsUrl : '';
  const text = statement || ('This guest account needs agreement to the hosted terms.' + (termsUrl ? '\n' + termsUrl : ''));
  return Promise.resolve(window.confirm(text));
}

void session().then(showAccount).catch(() => say('Sign-in is not available right now.'));
