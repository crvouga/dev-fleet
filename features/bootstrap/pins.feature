Feature: A pin that carries digests moves with them
  Renovate bumps a version but cannot compute the checksums written beside
  it. bootstrap/pins.ts moves mise and T3 Code to their newest upstream
  release, digests included, and the Pins workflow opens the pull request.
  Nothing here contacts GitHub: upstream is a stand-in.

  Scenario: A newer mise release moves the version and the digest of each archive
    Given mise.toml pins mise "2026.10.24"
    And jdx/mise has the releases "v2026.11.7", "v2026.11.6"
    And the SHASUMS256.txt of "v2026.11.7" lists:
      | digest | archive                            |
      | 1      | ./mise-v2026.11.7-linux-x64.tar.gz |
      | 2      | ./mise-v2026.11.7-linux-arm64.tar.gz |
      | 3      | ./mise-v2026.11.7-macos-x64.tar.gz |
      | 4      | ./mise-v2026.11.7-macos-arm64.tar.gz |
      | 5      | ./mise-v2026.11.7-linux-x64-musl.tar.gz |
    When the "mise" pin is updated
    Then the pin moved from "2026.10.24" to "2026.11.7"
    And mise.toml now reads:
      | name                    | value     |
      | min_version             | 2026.11.7 |
      | mise_linux_x64_sha256   | 1         |
      | mise_linux_arm64_sha256 | 2         |
      | mise_macos_x64_sha256   | 3         |
      | mise_macos_arm64_sha256 | 4         |

  Scenario: The newest T3 Code nightly is pinned with a digest of every artifact it installs
    Previews and stable releases are not nightlies; the workers run the
    nightly channel. The manager installs the same release, so its archive
    is one of them: a pin moved without it stops every sync on the manager.
    Given mise.toml pins T3 Code "0.1.8-nightly.20261106.4262"
    And pingdotgg/t3code has the releases "v0.1.10-preview.20261112.4552", "v0.1.10-nightly.20261111.4544", "v0.1.9"
    And these release files hash to:
      | file                                                      | digest |
      | v0.1.10-nightly.20261111.4544/t3-0.1.10-nightly.20261111.4544-linux-x64.tar.gz   | 1      |
      | v0.1.10-nightly.20261111.4544/t3-0.1.10-nightly.20261111.4544-linux-arm64.tar.gz | 2      |
      | v0.1.10-nightly.20261111.4544/t3-0.1.10-nightly.20261111.4544-darwin-arm64.tar.gz | 5      |
      | v0.1.10-nightly.20261111.4544/T3-Code-0.1.10-nightly.20261111.4544-amd64.deb     | 3      |
      | v0.1.10-nightly.20261111.4544/T3-Code-0.1.10-nightly.20261111.4544-arm64.deb     | 4      |
    When the "t3" pin is updated
    Then the pin moved from "0.1.8-nightly.20261106.4262" to "0.1.10-nightly.20261111.4544"
    And mise.toml now reads:
      | name                    | value                        |
      | t3_version              | 0.1.10-nightly.20261111.4544 |
      | t3_linux_x64_sha256     | 1                            |
      | t3_linux_arm64_sha256   | 2                            |
      | t3_darwin_arm64_sha256  | 5                            |
      | t3_desktop_amd64_sha256 | 3                            |
      | t3_desktop_arm64_sha256 | 4                            |

  Scenario: A pin already at the newest release is left as it is
    Given mise.toml pins mise "2026.11.7"
    And jdx/mise has the releases "v2026.11.7"
    When the "mise" pin is updated
    Then the pin is current at "2026.11.7"
    And mise.toml is unchanged

  Scenario: A release without a digest for an archive is refused
    A pin is never written without the digest every machine checks.
    Given mise.toml pins mise "2026.10.24"
    And jdx/mise has the releases "v2026.11.7"
    And the SHASUMS256.txt of "v2026.11.7" lists:
      | digest | archive                            |
      | 1      | ./mise-v2026.11.7-linux-x64.tar.gz |
    When the "mise" pin is updated
    Then it is refused with "no SHA-256 for mise-v2026.11.7-linux-arm64.tar.gz"

  Scenario: A pin the updater does not know is refused
    When the "docker-desktop" pin is updated
    Then it is refused with "Unknown pin docker-desktop"
