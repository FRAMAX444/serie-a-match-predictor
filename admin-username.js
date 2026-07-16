const ADMIN_IDENTITIES = Object.freeze([
  { username: "RC25M", email: "rc25m@serie-a-predictor.invalid" },
  { username: "FraMar", email: "framar@serie-a-predictor.invalid" },
  { username: "MassGall", email: "massgall@serie-a-predictor.invalid" },
  { username: "LucSco", email: "lucsco@serie-a-predictor.invalid" },
]);

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function findIdentity(value) {
  const normalized = normalize(value);
  return ADMIN_IDENTITIES.find((identity) =>
    normalize(identity.username) === normalized || normalize(identity.email) === normalized);
}

function showLoginError(message) {
  const error = document.getElementById("login-error");
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

function initUsernameLogin() {
  const form = document.getElementById("login-form");
  const input = document.getElementById("login-email");
  if (!form || !input) return;

  form.addEventListener("submit", (event) => {
    const identity = findIdentity(input.value);
    if (!identity) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showLoginError("Username non riconosciuto oppure non abilitato.");
      input.focus();
      return;
    }

    const displayedUsername = identity.username;
    input.value = identity.email;
    queueMicrotask(() => {
      input.value = displayedUsername;
    });
  }, true);
}

function initIdentityLabel() {
  const label = document.getElementById("admin-identity");
  if (!label) return;

  const replaceTechnicalEmail = () => {
    const identity = ADMIN_IDENTITIES.find((item) => label.textContent.includes(item.email));
    if (identity) label.textContent = `Accesso effettuato come ${identity.username}`;
  };

  new MutationObserver(replaceTechnicalEmail).observe(label, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  replaceTechnicalEmail();
}

initUsernameLogin();
initIdentityLabel();
