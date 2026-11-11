import * as google from './googleMail.js';
import * as microsoft from './microsoftMail.js';

// provider name → its file. V2 (Workard Mail / Stalwart) becomes one more line here.
const PROVIDERS = { google, microsoft };

export const PROVIDER_NAMES = Object.keys(PROVIDERS);
export const getProvider = (name) => PROVIDERS[name];
