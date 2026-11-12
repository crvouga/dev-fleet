Feature: A release is installed and run before it is published
  The Release workflow packs the package once, installs that tarball in an
  empty directory the way a fleet project does, and runs its devfleet on
  every supported Node. Only the tarball that passed is published. These
  scenarios pack a small stand-in package with npm and install it for real.

  Scenario: A package whose devfleet starts and names its release passes
    Given a packed release "1.2.3" from commit "0123456789abcdef0123456789abcdef01234567"
    When the packed release is installed and run
    Then it is accepted

  Scenario: A broken bin path fails before anything is published
    Given a packed release "1.2.3" from commit "0123456789abcdef0123456789abcdef01234567"
    But its package.json points the devfleet command at "./bin/missing.mjs"
    When the packed release is installed and run
    Then it is refused with "devfleet --version failed"

  Scenario: A package that names another version is refused
    The version is stamped into the package by the workflow; a tarball that
    says otherwise was not built from this run.
    Given a packed release "1.2.3" from commit "0123456789abcdef0123456789abcdef01234567"
    When the packed release is installed and run, expecting "1.2.4"
    Then it is refused with "not 1.2.4"

  Scenario: A package that cannot print the example configuration is refused
    Given a packed release "1.2.3" from commit "0123456789abcdef0123456789abcdef01234567"
    But its devfleet fails "fleet-state --example"
    When the packed release is installed and run
    Then it is refused with "devfleet fleet-state --example failed"
