import { apiError, text } from './domain.js';

function addresses(value) {
  return [...new Set(String(value || '').split(/[;,\s]+/).map(item => item.trim().toLowerCase()).filter(item => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)))];
}

export function createMailer() {
  const apiKey = text(process.env.RESEND_API_KEY, 500);
  const from = text(process.env.EMAIL_FROM || 'AAXI Closing <closing@example.com>', 320);
  const defaultRecipients = addresses(process.env.CLOSING_EMAIL_RECIPIENTS);

  return {
    configured: Boolean(apiKey && from),
    recipients(fallback = '') {
      const values = defaultRecipients.length ? defaultRecipients : addresses(fallback);
      if (!values.length) throw apiError(503, 'EMAIL_RECIPIENTS_MISSING', 'Closing email recipients are not configured.');
      return values;
    },
    async send({ to, subject, html, textBody, attachments = [], idempotencyKey }) {
      if (!apiKey) throw apiError(503, 'EMAIL_NOT_CONFIGURED', 'The email service is not configured.');
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': text(idempotencyKey, 256) } : {})
        },
        body: JSON.stringify({ from, to, subject, html, text: textBody, attachments })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw apiError(response.status >= 500 ? 503 : 400, 'EMAIL_SEND_FAILED', body?.message || 'Email could not be sent.');
      }
      return body || { id: '' };
    }
  };
}
