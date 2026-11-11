# ␊ stands for a line break.
Feature: Secrets are read by purpose
  Fleet code asks for a secret by what it is for. Where each one is kept is
  the fleet's own choice, declared under "secrets" in its fleet configuration.
  A secret is never passed to a command as an argument, and one that cannot be
  read is not available rather than empty.

  Rule: A fleet may keep its secrets in the environment

    Background:
      Given a fleet whose secrets block is:
        """
        { "provider": "env" }
        """
      And the environment variable "DEVFLEET_SECRET_PROXY_CLIENT_KEY" holds " value␊"

    Scenario: Each secret has an environment variable of its own
      Then the secret "proxy-client-key" is kept in the environment variable "DEVFLEET_SECRET_PROXY_CLIENT_KEY"

    Scenario: A secret in the environment is read without the white space around it
      When the secret "proxy-client-key" is read
      Then the secret read is "value"

    Scenario: A secret whose variable is not set is not available
      When the secret "monitoring-tunnel-token" is read
      Then the secret is not available

  Rule: A fleet may keep each secret in a private file

    Background:
      Given a fleet that keeps its secrets as files in a directory of its own
      And the file "proxy-client-key" in that directory holds "from-file␊"

    Scenario: A secret is the content of the file named after it
      When the secret "proxy-client-key" is read
      Then the secret read is "from-file"

    Scenario: A secret with no file is not available
      When the secret "monitoring-account-password" is read
      Then the secret is not available

  Rule: A fleet may keep its secrets in a sops document

    Scenario: sops is asked for the one key of the encrypted document
      Given a fleet whose secrets block is:
        """
        { "provider": "sops", "file": "/x/secrets.yaml" }
        """
      And every command prints "secret␊"
      When the secret "proxy-client-key" is read
      Then the secret read is "secret"
      And the only command run was:
        | sops | --decrypt | --extract | ["proxy-client-key"] | /x/secrets.yaml |

  Rule: A fleet may keep its secrets in Vault

    Background:
      Given a fleet whose secrets block is:
        """
        {
          "provider": "vault",
          "address": "https://vault.example.org",
          "mount": "secret",
          "locations": {
            "proxy-client-key": { "path": "team/prd", "field": "KEY" },
            "monitoring-account-password": { "path": "team/prd", "field": "KEY" },
            "monitoring-tunnel-token": { "path": "missing", "field": "TOKEN" },
            "proxy-tunnel-token": { "path": "team/prd", "field": "KEY" }
          }
        }
        """
      And every command prints "secret␊"

    Scenario: Vault is asked for the one field the fleet configuration names
      When the secret "proxy-client-key" is read
      Then the secret read is "secret"
      And the only command run was:
        | vault | kv | get | -address=https://vault.example.org | -mount=secret | -field=KEY | team/prd |

    Scenario: A secret Vault does not hold is not available
      Given the command "vault kv get -address=https://vault.example.org -mount=secret -field=TOKEN missing" fails
      When the secret "monitoring-tunnel-token" is read
      Then the secret is not available

  Rule: The secrets block says where every secret is kept, or it is rejected

    Scenario: The example fleet keeps its secrets in Vault
      Then the fleet configuration in use keeps its secrets in "vault"

    Scenario Outline: The block <block> is taken as written
      When the secrets block <block> is read
      Then it is accepted as <block>

      Examples:
        | block               |
        | {"provider":"env"}  |
        | {"provider":"file"} |

    Scenario: A fleet configuration with no secrets block is rejected
      When no secrets block is read
      Then the secrets block is rejected

    Scenario Outline: A block with <fault> is rejected, never guessed
      When the secrets block <block> is read
      Then the secrets block is rejected

      Examples:
        | fault                                  | block                                                                                  |
        | a provider nobody knows                | {"provider":"keychain"}                                                                |
        | a field its provider does not have     | {"provider":"env","extra":1}                                                           |
        | sops and no document                   | {"provider":"sops"}                                                                    |
        | a Vault address that is not HTTPS      | {"provider":"vault","address":"http://plain","mount":"secret","locations":{}}          |
        | Vault and no location for every secret | {"provider":"vault","address":"https://v.example.org","mount":"secret","locations":{}} |
