Feature: A worker installs only what its profile declares and keeps its own credentials
  A worker installs a declared subset of the tools, every version still coming
  from the locked pins. It renews its own Vault session and takes its GitHub
  service token from that session; no login directory is ever copied to it.

  Rule: The worker tool profile selects pinned tools only

    Background:
      Given these tools are each pinned at version "1.2.3":
        | bun        |
        | node       |
        | gh         |
        | python     |
        | uv         |
        | docker-cli |
        | vault      |
        | aws        |

    Scenario: The minimal worker profile keeps exactly its tools
      When a worker's profile selects "bun,node,gh,python,uv,docker-cli,vault"
      Then the worker installs exactly these tools, in this order:
        | bun        |
        | node       |
        | gh         |
        | python     |
        | uv         |
        | docker-cli |
        | vault      |

    Scenario: A profile that names a tool without a pin is refused
      When a worker's profile selects these tools:
        | bun        |
        | node       |
        | gh         |
        | python     |
        | uv         |
        | docker-cli |
        | vault      |
        | unmanaged  |
      Then the profile is refused

    Scenario: A profile that leaves out a required tool is refused
      When a worker's profile selects these tools:
        | bun |
      Then the profile is refused

  Rule: A worker's Vault session counts as renewed only on a successful answer with a finite lease

    Scenario Outline: <case>
      Given Vault answers the renewal with exit status <status> and:
        """
        <answer>
        """
      When the worker renews its Vault session
      Then the session is <result>

      Examples:
        | case                                           | status | answer                                                              | result      |
        | A successful answer with a lease is a renewal  | 0      | {"auth":{"client_token":"PRIVATE_SENTINEL","lease_duration":86400}} | renewed     |
        | A failed renewal is not one                    | 1      | PRIVATE_SENTINEL                                                    | not renewed |
        | An answer without a lease is not a renewal     | 0      | {}                                                                  | not renewed |

  Rule: The GitHub service token comes from the worker's own Vault session

    Scenario: The declared account is validated before the token from Vault is stored
      Given the worker is not signed in to GitHub
      And Vault holds the GitHub service token "PRIVATE_SENTINEL_TOKEN"
      And GitHub says a token belongs to "example-user"
      And GitHub accepts a login with a token
      When the worker signs in to GitHub
      Then the worker is signed in
      And the GitHub token appears in no command line
      And the last command was given "PRIVATE_SENTINEL_TOKEN" and a new line on standard input
