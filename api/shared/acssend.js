// ACS send wrapper. Two problems it solves, both about VISIBILITY of failures:
//  1. The ACS SDK retries a bad key / unreachable endpoint several times with backoff, which can blow
//     past the request timeout — the function then returns a blank non-JSON 500 and the UI can only say
//     "couldn't send". We cut retries down so a real error (401, bad sender, domain not linked) comes
//     back fast and legibly.
//  2. As a hard backstop, we race the send against a timeout, so even a true network hang becomes a
//     clear, actionable error string instead of a mystery timeout.
const DEFAULT_TIMEOUT_MS = 15000;

function makeEmailClient(EmailClient, conn) {
  // Fail fast: one quick retry at most, so the underlying ACS error surfaces instead of being buried
  // under the SDK's default backoff. Unknown options are ignored by the SDK, which is harmless.
  try { return new EmailClient(conn, { retryOptions: { maxRetries: 1, maxRetryDelayInMs: 2000 } }); }
  catch { return new EmailClient(conn); }
}

function sendEmailWithTimeout(client, message, ms) {
  const budget = ms || DEFAULT_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      "The email service (ACS) didn't respond within " + Math.round(budget / 1000) + "s. This usually means " +
      "ACS_EMAIL_CONNECTION_STRING is missing/wrong or points to a different resource, or DASHBOARD_EMAIL_FROM's " +
      "sender domain isn't connected to that ACS resource. Check both in the Static Web App's environment variables."
    )), budget);
  });
  const send = Promise.resolve().then(() => client.beginSend(message));
  return Promise.race([send, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { makeEmailClient, sendEmailWithTimeout, DEFAULT_TIMEOUT_MS };
