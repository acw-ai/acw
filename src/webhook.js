import { config } from './config.js';

export async function dispatchWebhook(event, payload) {
  if (!config.webhook.url) return;

  const body = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    data: payload,
  });

  try {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'ACW-Webhook/1.0',
    };
    if (config.webhook.secret) {
      headers['X-ACW-Signature'] = config.webhook.secret;
    }

    const res = await fetch(config.webhook.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[webhook] failed with status ${res.status} from ${config.webhook.url}`);
    }
  } catch (err) {
    console.warn(`[webhook] error sending ${event} to ${config.webhook.url}:`, err.message);
  }
}
