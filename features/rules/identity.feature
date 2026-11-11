Feature: No fleet's identity is in this repository
  dev-fleet is for anyone's machines. A fleet's own accounts, hostnames,
  tailnet and repository belong in that fleet's fleet.json, never here.

  Scenario: The tracked files name no real email address
    When every tracked text file is searched for email addresses
    Then each one found is a tool version such as "name@1.2.3", or is at one of these placeholder domains:
      | example.com              |
      | example.org              |
      | example.test             |
      | example.invalid          |
      | b.c                      |
      | home.ts.net              |
      | github.com               |
      | users.noreply.github.com |
      | 127.0.0.1                |

  Scenario: The tracked files name no real tailnet
    When every tracked text file is searched for tailnet names
    Then each one found is one of these placeholders:
      | example.ts.net    |
      | fixture.ts.net    |
      | home.ts.net       |
      | second.ts.net     |
      | tailnet.ts.net    |
      | tail0a1b2c.ts.net |

  Scenario: The tracked files name no real home directory
    When every tracked text file is searched for home directories
    Then each one found belongs to one of these placeholder users:
      | dev       |
      | developer |
      | someone   |
      | x         |
      | fixture   |
      | fleettest |
      | me        |
      | name      |
      | profile   |

  # A consumer can assert its own names never leak into a fork or a patch:
  #   DEVFLEET_FORBIDDEN='my-host,mydomain.dev' bun test features/rules
  Scenario: Names listed in DEVFLEET_FORBIDDEN appear nowhere
    When every tracked text file is searched for the names in DEVFLEET_FORBIDDEN
    Then none is found
