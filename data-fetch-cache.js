const nativeFetch = globalThis.fetch.bind(globalThis);
let matchPayloadPromise = null;

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url || "";
}

function isMatchPayloadRequest(input) {
  try {
    const base = globalThis.location?.href || "https://local.invalid/";
    const url = new URL(requestUrl(input), base);
    return url.pathname.endsWith("/data/matches.json");
  } catch {
    return false;
  }
}

function loadMatchPayload(input, init = {}) {
  if (!matchPayloadPromise) {
    matchPayloadPromise = nativeFetch(input, { ...init, cache: "no-cache" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .catch((error) => {
        matchPayloadPromise = null;
        throw error;
      });
  }
  return matchPayloadPromise;
}

globalThis.fetch = (input, init = {}) => {
  if (!isMatchPayloadRequest(input)) return nativeFetch(input, init);
  const payload = loadMatchPayload(input, init);
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => payload,
  });
};
