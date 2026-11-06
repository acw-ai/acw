import { createPbxClient } from '../pbx3cx.js';
import { createAsteriskClient } from './asterisk.js';
import { createFreeSwitchClient } from './freeswitch.js';
import { createWebhookTelephonyAdapter } from './webhook.js';

export function createTelephonyDriver({ config, tracker, repo, directory, enforcer, log }) {
  const driver = (config.telephony?.driver || 'webhook').toLowerCase();

  switch (driver) {
    case '3cx': {
      log.info(`[telephony] initialized 3CX driver (${config.pbx.baseUrl})`);
      return createPbxClient(config.pbx, log);
    }

    case 'asterisk': {
      log.info(`[telephony] initialized Asterisk ARI driver (${config.telephony.asterisk.url})`);
      return createAsteriskClient(config.telephony.asterisk, log);
    }

    case 'freeswitch': {
      log.info(`[telephony] initialized FreeSWITCH ESL driver (${config.telephony.freeswitch.host}:${config.telephony.freeswitch.port})`);
      return createFreeSwitchClient(config.telephony.freeswitch, log);
    }

    case 'webhook':
    default: {
      log.info('[telephony] initialized Universal Inbound Webhook driver');
      return createWebhookTelephonyAdapter({ config, tracker, repo, directory, enforcer, log });
    }
  }
}
