import { accounts } from './accounts';
import { native } from './native';
import { profiles } from './profiles';
import { providers } from './providers';
import { proxyKeys } from './proxy-key';
import { AgentsWorld, common } from './world';

export { AgentsWorld };
/** Every step of this area. */
export const agents = [
  common,
  accounts,
  profiles,
  native,
  providers,
  proxyKeys,
];
