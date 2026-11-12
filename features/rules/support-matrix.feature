Feature: One support matrix says which platforms dev-fleet runs on
  docs/support-matrix.md is generated from the policies the code reads: the
  macOS and Ubuntu policies name what is supported, ansible/platforms.json
  what is best effort or refused. A platform the code or the features name
  without a row is a platform nobody decided about.

  Scenario: The published support matrix is the one the policies generate
    When docs/support-matrix.md is read
    Then its table is the one the policies generate

  Scenario: Every platform the code and the features name has a row
    When the code and the features are searched for these platform names:
      | Ubuntu  |
      | Debian  |
      | macOS   |
      | Windows |
      | WSL2    |
      | Alpine  |
      | Fedora  |
      | CentOS  |
      | RHEL    |
      | FreeBSD |
    Then each name found is a platform of the support matrix

  Scenario Outline: A platform named without a row is caught
    When this text is searched for the platform names "<names>":
      """
      <text>
      """
    Then it names "<platform>", which has no row in the support matrix

    Examples:
      | names         | text                                    | platform |
      | Fedora,Ubuntu | Workers may also run Fedora 41.         | Fedora   |
      | FreeBSD       | if [ "$(uname -s)" = FreeBSD ]; then    | FreeBSD  |

  Scenario: WSL is the WSL2 row
    When this text is searched for the platform names "WSL2":
      """
      Codex proxy node sync requires macOS/Linux/WSL.
      """
    Then each name found is a platform of the support matrix
