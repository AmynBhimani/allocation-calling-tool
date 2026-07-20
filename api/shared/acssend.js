// ACS send wrapper. The earlier version cut retries to near-zero to make a network HANG visible while we
// diagnosed a wrong-resource connection string. That's resolved — the failure now is ACS rate-limiting,
// which the SDK is designed to ride through with its normal retry/backoff. So we go back to the default
// retry policy and keep only a generous timeout as a last-resort backstop against a true hang (well under
// the platform request limit), which won't interfere with normal throttle retries.
const DEFAULT_TIMEOUT_MS = 60000;

function makeEmailClient(EmailClient, conn) {
  // Default retry policy: retries transient failures and 429 throttling with backoff, honoring Retry-After.
  return new EmailClient(conn);
}

function sendEmailWithTimeout(client, message, ms) {
  const budget = ms || DEFAULT_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      "The email service (ACS) didn't respond within " + Math.round(budget / 1000) + "s. It may be rate-limiting " +
      "or temporarily unavailable — wait a minute and try again. If it persists, the resource's sending limit may need raising."
    )), budget);
  });
  const send = Promise.resolve().then(() => client.beginSend(message));
  return Promise.race([send, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { makeEmailClient, sendEmailWithTimeout, DEFAULT_TIMEOUT_MS };
