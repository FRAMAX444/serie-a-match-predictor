import {
  ADMINS_COLLECTION,
  FIREBASE_CONFIG,
  FIREBASE_SDK_VERSION,
  SETTINGS_COLLECTION,
  SETTINGS_DOCUMENT,
  isFirebaseConfigured,
} from "./firebase-config.js";

let corePromise;
let authPromise;

function sdkUrl(service) {
  return `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-${service}.js`;
}

async function loadCore() {
  if (!isFirebaseConfigured()) {
    throw new Error("Firebase non è ancora configurato in firebase-config.js.");
  }
  if (!corePromise) {
    corePromise = Promise.all([
      import(sdkUrl("app")),
      import(sdkUrl("firestore")),
    ]).then(([appApi, firestoreApi]) => {
      const app = appApi.getApps().length ? appApi.getApp() : appApi.initializeApp(FIREBASE_CONFIG);
      return { app, db: firestoreApi.getFirestore(app), appApi, firestoreApi };
    });
  }
  return corePromise;
}

async function loadAuth(app) {
  if (!authPromise) {
    authPromise = import(sdkUrl("auth")).then((authApi) => ({
      authApi,
      auth: authApi.getAuth(app),
    }));
  }
  return authPromise;
}

export async function getFirebaseServices({ includeAuth = false } = {}) {
  const core = await loadCore();
  if (!includeAuth) return core;
  return { ...core, ...(await loadAuth(core.app)) };
}

export const firebasePaths = Object.freeze({
  adminsCollection: ADMINS_COLLECTION,
  settingsCollection: SETTINGS_COLLECTION,
  settingsDocument: SETTINGS_DOCUMENT,
});
