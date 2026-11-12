/** The step definitions of this area, by what they describe. Each file adds
 * its steps to the one registry `world.ts` holds.
 */
import './commands';
import './configuration';
import './secrets';
import './tailnet';
import './t3';
import './checks';
import './ssh';
import './sync';
import './running';
import './reports';
import './tools';
import './capabilities';
import './health';
import './activity';

export { CoreWorld, core } from './world';
