# ␊ stands for a line break.
Feature: A worker proves it can do what agents do on it
  A version number and an answering daemon are not proof. The worker starts a
  container, builds an image, launches a headless browser and authenticates a
  Git remote the way an agent would, in the agent's own session. Each check
  reports a code and a remedy, never what a command printed.

  Rule: worker:docker-run starts a pinned container and builds an image, offline

    Scenario: A container that runs and an image that builds pass
      Given every command prints ""
      When the worker's Docker is tried
      Then the check "worker:docker-run" passes
      And the first "docker" command run was:
        | docker | run | --rm | --network | none | --pull | never | busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec | true |
      And the command "docker build" was given "FROM busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec␊RUN true␊" on standard input

    Scenario Outline: A container that cannot start because <cause> fails with <code>
      Given the command "docker run" fails with the error "<error>"
      When the worker's Docker is tried
      Then the check "worker:docker-run" fails
      And the summary of the check "worker:docker-run" mentions "<code>"
      And the remedy of the check "worker:docker-run" mentions "<remedy>"
      And nothing reported contains "PRIVATE_SENTINEL"

      Examples:
        | cause                                    | error                                                                                                          | code                        | remedy           |
        | the user lacks access to the socket      | permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock PRIVATE_SENTINEL | DOCKER_SOCKET_ACCESS_DENIED | docker group     |
        | the engine is down                       | Cannot connect to the Docker daemon at unix:///var/run/docker.sock. PRIVATE_SENTINEL                           | DOCKER_DAEMON_UNREACHABLE   | docker.service   |
        | the image was never cached               | Unable to find image 'busybox' locally: No such image PRIVATE_SENTINEL                                         | DOCKER_SMOKE_IMAGE_MISSING  | works offline    |
        | the image store is full                  | write /var/lib/docker/tmp: no space left on device PRIVATE_SENTINEL                                            | DOCKER_DISK_FULL            | /var/lib/docker  |
        | of anything else                         | OCI runtime create failed: cgroup PRIVATE_SENTINEL                                                             | DOCKER_RUN_FAILED           | cgroups          |

    Scenario: A container that runs while an image does not build fails with DOCKER_BUILD_FAILED
      Given every command prints ""
      And the command "docker build" fails with the error "ERROR: failed to solve PRIVATE_SENTINEL"
      When the worker's Docker is tried
      Then the check "worker:docker-run" fails
      And the summary of the check "worker:docker-run" mentions "DOCKER_BUILD_FAILED"
      And nothing reported contains "PRIVATE_SENTINEL"

    Scenario: A session older than the docker group runs the check in a fresh session
      fleet-sync adds the worker's user to the docker group, but the session
      that runs the check started before the grant. The group database lists
      the user in docker while the session does not hold the group, so the
      check runs again in a fresh session of the group, and the first sync of
      a new worker is green.
      Given these commands print:
        | command     | prints              |
        | id -un      | dev                 |
        | id -Gn      | dev sudo            |
        | id -Gn dev  | dev sudo docker     |
        | sg docker   |                     |
      And the command "docker run" fails with the error "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock PRIVATE_SENTINEL"
      When the worker's Docker is tried
      Then the check "worker:docker-run" passes
      And the summary of the check "worker:docker-run" mentions "fresh session"
      And the first "sg" command run was:
        | sg | docker | -c | 'docker' 'run' '--rm' '--network' 'none' '--pull' 'never' 'busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec' 'true' |
      And 2 commands ran in a fresh session of the docker group
      And the image was built in a fresh session of the docker group from "FROM busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec␊RUN true␊"
      And nothing reported contains "PRIVATE_SENTINEL"

    Scenario Outline: A refused socket is not retried when <why>
      Given these commands print:
        | command     | prints     |
        | id -un      | dev        |
        | id -Gn      | <held>     |
        | id -Gn dev  | <listed>   |
      And the command "sg docker" fails with the error "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock PRIVATE_SENTINEL"
      And the command "docker run" fails with the error "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock PRIVATE_SENTINEL"
      When the worker's Docker is tried
      Then the check "worker:docker-run" fails
      And the summary of the check "worker:docker-run" mentions "DOCKER_SOCKET_ACCESS_DENIED"
      And <fresh> commands ran in a fresh session of the docker group
      And nothing reported contains "PRIVATE_SENTINEL"

      Examples:
        | why                                                | held            | listed          | fresh |
        | the user is not in the docker group at all         | dev sudo        | dev sudo        | 0     |
        | the session already holds the docker group         | dev sudo docker | dev sudo docker | 0     |
        | a fresh session of the docker group is refused too | dev sudo        | dev sudo docker | 1     |

  Rule: worker:browser launches the pinned headless Chromium on workers with the web profile

    Scenario: A worker without the web profile has no browser to check
      When the worker's browser is tried without the web profile
      Then the check "worker:browser" is skipped
      And exactly 0 commands were run

    Scenario Outline: The headless shell of <arch> loads a blank page
      Given every command prints "<html><head></head><body></body></html>"
      When the worker's browser is tried with the web profile on "<arch>"
      Then the check "worker:browser" passes
      And the first "<executable>" command run was:
        | <executable> | --headless | --no-sandbox | --disable-gpu | --dump-dom | about:blank |

      Examples:
        | arch  | executable                                                                                  |
        | x64   | /opt/personal-fleet/browser/158.0.8127.18/chrome-headless-shell-linux64/chrome-headless-shell     |
        | arm64 | /opt/personal-fleet/browser/158.0.8127.18/chrome-headless-shell-linux-arm64/chrome-headless-shell |

    Scenario Outline: A browser that <how> fails with <code>
      Given <situation>
      When the worker's browser is tried with the web profile on "x64"
      Then the check "worker:browser" fails
      And the summary of the check "worker:browser" mentions "<code>"
      And the remedy of the check "worker:browser" mentions "fleet-sync"
      And nothing reported contains "PRIVATE_SENTINEL"

      Examples:
        | how                      | situation                                                                                                                  | code                    |
        | is not installed         | every command could not be started                                                                                         | BROWSER_NOT_INSTALLED   |
        | lacks a system library   | every command fails with the error "error while loading shared libraries: libnss3.so: cannot open PRIVATE_SENTINEL"         | BROWSER_LIBRARY_MISSING |
        | never exits              | every command ran out of time                                                                                              | BROWSER_LAUNCH_TIMEOUT  |
        | crashes                  | every command fails with the error "Trace/breakpoint trap PRIVATE_SENTINEL"                                                | BROWSER_LAUNCH_FAILED   |

  Rule: A worker commits as the declared identity and pushes through git, not through gh

    Background:
      Given the fleet declares the Git identity "Example User" <example-user@users.noreply.github.com>

    Scenario: The declared identity and a credential for github.com pass both checks
      Given these commands print:
        | command                                    | prints                                                    |
        | git config --global --get-all user.name    | Example User                                              |
        | git config --global --get-all user.email   | example-user@users.noreply.github.com                     |
        | git credential fill                        | protocol=https␊host=github.com␊username=x␊password=PRIVATE_SENTINEL␊ |
      When the worker's Git is checked
      Then the check "worker:git-identity" passes
      And the check "worker:git-push-auth" passes
      And the command "git credential fill" was given "protocol=https␊host=github.com␊␊" on standard input
      And no "gh" command was run
      And nothing reported contains "PRIVATE_SENTINEL"

    Scenario: Removing the credential helper fails worker:git-push-auth
      Git with prompts off fails at once when no helper answers.
      Given these commands print:
        | command                                    | prints                                |
        | git config --global --get-all user.name    | Example User                          |
        | git config --global --get-all user.email   | example-user@users.noreply.github.com |
      And the command "git credential fill" fails with the error "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
      When the worker's Git is checked
      Then the check "worker:git-push-auth" fails
      And the summary of the check "worker:git-push-auth" mentions "GIT_CREDENTIAL_HELPER_MISSING"
      And the remedy of the check "worker:git-push-auth" mentions "fleet-sync"
      And every "git" command ran with git's prompts turned off

    Scenario Outline: An identity that is <how> fails worker:git-identity with <code>
      Given these commands print:
        | command                                    | prints   |
        | git config --global --get-all user.name    | <name>   |
        | git config --global --get-all user.email   | <email>  |
        | git credential fill                        | password=PRIVATE_SENTINEL |
      When the worker's Git is checked
      Then the check "worker:git-identity" fails
      And the summary of the check "worker:git-identity" mentions "<code>"
      And the remedy of the check "worker:git-identity" mentions "~/.gitconfig"

      Examples:
        | how                         | name          | email                                   | code                  |
        | missing                     |               |                                         | GIT_IDENTITY_MISSING  |
        | overridden by another file  | Someone Else  | example-user@users.noreply.github.com   | GIT_IDENTITY_MISMATCH |

    Scenario: A declared repository is listed through git with the node's own credentials
      Given the fleet declares that pushes are proven against "https://github.com/example-user/private-check"
      And these commands print:
        | command                                    | prints                                |
        | git config --global --get-all user.name    | Example User                          |
        | git config --global --get-all user.email   | example-user@users.noreply.github.com |
        | git credential fill                        | password=PRIVATE_SENTINEL             |
      And the command "git ls-remote" fails with the error "remote: Repository not found. PRIVATE_SENTINEL"
      When the worker's Git is checked
      Then the check "worker:git-push-auth" fails
      And the summary of the check "worker:git-push-auth" mentions "GIT_REMOTE_REFUSED"
      And the first "git" command run was:
        | git | config | --global | --get-all | user.name |
      And nothing reported contains "PRIVATE_SENTINEL"

    Scenario: Without signing declared, there is no signing check
      Given these commands print:
        | command                                    | prints                                |
        | git config --global --get-all user.name    | Example User                          |
        | git config --global --get-all user.email   | example-user@users.noreply.github.com |
        | git credential fill                        | password=PRIVATE_SENTINEL             |
      When the worker's Git is checked
      Then there is no check "worker:git-signing"
      And no "ssh-keygen" command was run

  Rule: With signing declared, every commit is signed with the node's own SSH key

    Background:
      Given the fleet declares the Git identity "Example User" <example-user@users.noreply.github.com>, signing commits with SSH
      And the worker's home is "/home/dev"

    Scenario: Git signs with the node's own key, and the key really signs
      The probe signs a fixed text on standard input: no file of the node's
      is signed, and the signature is not reported.
      Given these commands print:
        | command                                    | prints                                                        |
        | git config --global --get-all user.name    | Example User                                                  |
        | git config --global --get-all user.email   | example-user@users.noreply.github.com                         |
        | git credential fill                        | password=PRIVATE_SENTINEL                                     |
        | git config --global --get-all gpg.format   | ssh                                                           |
        | git config --global --get-all user.signingkey | /home/dev/.ssh/dev-fleet-git-signing.pub                   |
        | git config --global --get-all commit.gpgsign  | true                                                       |
        | ssh-keygen -Y sign -n git -f /home/dev/.ssh/dev-fleet-git-signing | -----BEGIN SSH SIGNATURE-----␊PRIVATE_SENTINEL␊-----END SSH SIGNATURE----- |
      When the worker's Git is checked
      Then the check "worker:git-signing" passes
      And the summary of the check "worker:git-signing" mentions "signing key of the account"
      And the command "ssh-keygen -Y sign" was given "dev-fleet signing probe␊" on standard input
      And nothing reported contains "PRIVATE_SENTINEL"

    Scenario Outline: Signing that is <how> fails worker:git-signing with <code>
      Given these commands print:
        | command                                       | prints     |
        | git config --global --get-all user.name       | Example User |
        | git config --global --get-all user.email      | example-user@users.noreply.github.com |
        | git credential fill                           | password=PRIVATE_SENTINEL |
        | git config --global --get-all gpg.format      | <format>   |
        | git config --global --get-all user.signingkey | <key>      |
        | git config --global --get-all commit.gpgsign  | <always>   |
      And the command "ssh-keygen -Y sign" fails with the error "Load key: No such file or directory PRIVATE_SENTINEL"
      When the worker's Git is checked
      Then the check "worker:git-signing" fails
      And the summary of the check "worker:git-signing" mentions "<code>"
      And the remedy of the check "worker:git-signing" mentions "fleet-sync"
      And nothing reported contains "PRIVATE_SENTINEL"

      Examples:
        | how                          | format  | key                                      | always | code                     |
        | not configured               |         |                                          |        | GIT_SIGNING_MISSING      |
        | overridden by another file   | openpgp | /home/dev/.ssh/dev-fleet-git-signing.pub | true   | GIT_SIGNING_OVERRIDDEN   |
        | turned off for commits       | ssh     | /home/dev/.ssh/dev-fleet-git-signing.pub | false  | GIT_SIGNING_OVERRIDDEN   |
        | configured, without its key  | ssh     | /home/dev/.ssh/dev-fleet-git-signing.pub | true   | GIT_SIGNING_FAILED |

  Rule: Without a declared identity

    Scenario: Without a declared identity the fleet is warned, not blocked
      Given the fleet declares no Git identity
      And every command prints "password=PRIVATE_SENTINEL"
      When the worker's Git is checked
      Then the check "worker:git-identity" warns
      And the summary of the check "worker:git-identity" mentions "GIT_IDENTITY_UNDECLARED"
