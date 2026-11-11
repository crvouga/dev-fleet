"""This fleet's own configuration, as the proxy scripts need it.

Nothing here is a default: the endpoint, the Vault address, its paths and the
login all come from the fleet configuration every machine keeps at
~/.config/dev-fleet/fleet.json (or DEVFLEET_CONFIG).
"""
import json
import os
import pathlib


def path():
    return pathlib.Path(os.environ.get('DEVFLEET_CONFIG')
                        or pathlib.Path.home() / '.config/dev-fleet/fleet.json')


def load():
    try:
        return json.loads(path().read_text())
    except (OSError, ValueError):
        raise ValueError('Fleet configuration unavailable: ' + str(path())) from None


def endpoint():
    """Public HTTPS origin of the proxy."""
    return load()['services']['proxy']['endpoint']


def vault():
    """The proxy's backup, recovery and connector credentials live in Vault."""
    config = load()
    secrets = config['secrets']
    if secrets.get('provider') != 'vault':
        raise ValueError('The proxy service operations need the vault secrets provider')
    locations = secrets['locations']
    return {
        'address': secrets['address'],
        # KV v2 API paths: <mount>/data/<path>.
        'shared': secrets['mount'] + '/data/' + locations['proxy-client-key']['path'],
        'tunnel': secrets['mount'] + '/data/' + locations['proxy-tunnel-token']['path'],
        'tunnel_field': locations['proxy-tunnel-token']['field'],
        'user': config['worker']['vaultUser'],
    }
