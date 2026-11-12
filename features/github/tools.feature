Feature: Every tool on a node takes its GitHub credential from gh
  gh holds the node's token. git asks gh for it at every use, so a replaced
  token reaches git with no change to git and no second copy of the token on
  disk. ansible/github/git.yml, which writes the declared Git identity, owns
  the helper on the manager and every worker.

  Background:
    Given the fleet login is "example-user"
    And GitHub knows the token "TOKEN_A_PRIVATE_0001" as "example-user"
    And "worker-one" is signed in with "TOKEN_A_PRIVATE_0001"

  Scenario: git that asks gh passes
    Given git on "worker-one" has these GitHub credential helpers:
      |                                                       |
      | !'/home/dev/.local/share/mise/shims/gh' auth git-credential |
    When the GitHub checks run on "worker-one"
    Then the check "github:git-credential" passes

  Scenario: git with a credential store of its own fails
    Given git on "worker-one" has these GitHub credential helpers:
      | store |
    When the GitHub checks run on "worker-one"
    Then the check "github:git-credential" fails
    And the check "github:git-credential" says "GITHUB_GIT_CREDENTIAL_MISSING"

  Scenario: One playbook sets gh as git's only helper, and the sign-in writes no token
    When the GitHub tasks of the playbooks are read
    Then only "ansible/github/git.yml" sets git's GitHub credential helper
    And it clears every earlier helper before naming gh
    And the GitHub sign-in tasks write no file but its job and timer
