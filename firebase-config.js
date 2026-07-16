/**
 * Configurazione pubblica Firebase della web app.
 * Questi valori non sono password: l'accesso ai dati è protetto da
 * Firebase Authentication e dalle regole in firestore.rules.
 */
export const FIREBASE_CONFIG = Object.freeze({
  apiKey: "",
  authDomain: "",
  projectId: "",
  appId: "",
});

export const FIREBASE_SDK_VERSION = "12.16.0";
export const SETTINGS_COLLECTION = "public";
export const SETTINGS_DOCUMENT = "settings";
export const ADMINS_COLLECTION = "admins";

export function isFirebaseConfigured() {
  return ["apiKey", "authDomain", "projectId", "appId"].every((key) => Boolean(FIREBASE_CONFIG[key]));
}
