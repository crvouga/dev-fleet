# ␊ stands for a line break.
Feature: What a virtual machine does not have is not applicable to it
  A worker measures its class itself with systemd-detect-virt. A virtual
  machine has no lid, no battery and no firmware its guest can read, and its
  provider restarts it after a power loss. Its checks of those say they do not
  apply, with the reason, and never fail a run, not even a strict one. The
  sleep masks stay: a guest can still be suspended by its own idle policy. On
  a physical machine nothing changes.

  Rule: Power-loss recovery is the provider's on a virtual machine

    Scenario: A KVM guest reports power-loss recovery as not applicable, with the declared note
      Given every command fails
      And the command "systemd-detect-virt" prints "kvm␊"
      When the host of a worker whose declared note is "provider restarts instances" is checked
      Then the check "worker:power-loss-recovery" is not applicable
      And the summary of the check "worker:power-loss-recovery" mentions "a virtual machine (kvm)"
      And the summary of the check "worker:power-loss-recovery" mentions "(provider restarts instances)"
      And no command line contains "fwupdmgr"
      And the printed report of the worker "rented" says:
        | NOT-APPLICABLE worker:power-loss-recovery: Not applicable: a virtual machine (kvm) |
        | not applicable                                                                     |
      And the JSON report of the worker "rented" holds the check "worker:power-loss-recovery" as "not-applicable", saying "provider restarts instances"

    Scenario: Bare metal still has its firmware read
      Given every command fails
      And the command "systemd-detect-virt" prints "none␊"
      When the host of a worker whose declared note is "provider restarts instances" is checked
      Then the check "worker:power-loss-recovery" is skipped
      And the summary of the check "worker:power-loss-recovery" mentions "not observable"

  Rule: A virtual machine has no lid; its sleep masks are still checked

    Scenario: The lid policy of a virtual machine is not applicable and never read
      Given every command fails
      When the boot policy of a virtual worker is checked
      Then the check "ubuntu:lid-policy" is not applicable
      And the summary of the check "ubuntu:lid-policy" mentions "no lid"
      And the check "ubuntu:boot-policy" fails
      And no command line contains "HandleLidSwitch"

    Scenario: A physical machine's lid policy is part of its boot policy, as before
      Given every command fails
      When the boot policy of a physical worker is checked
      Then there is no check "ubuntu:lid-policy"
      And the check "ubuntu:boot-policy" fails
      And the summary of the check "ubuntu:boot-policy" mentions "UBUNTU_SESSION_POLICY_PENDING"

    Scenario: A healthy virtual worker passes a strict run
      Given the worker "rented" has these checks:
        | id                         | status         | summary                                                     |
        | ubuntu:boot-policy         | pass           | Sleep transitions are masked                                |
        | ubuntu:lid-policy          | not-applicable | Not applicable: a virtual machine has no lid.               |
        | worker:power-loss-recovery | not-applicable | Not applicable: a virtual machine (kvm) has no firmware ... |
        | worker:capacity:disk       | pass           | 30 GB free                                                  |
      When the "fleet-status" report is made
      Then a strict run exits with 0
