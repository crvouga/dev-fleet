Feature: The bucket is the source of truth and a manager's copy is disposable
  A manager compares its copy of the fleet state with the bucket before it
  reads or changes it, and uploads every change. How the two compare is the
  copy's standing: "local-only", "unreachable", "empty", "unpublished",
  "in-sync", "local-ahead", "bucket-ahead" or "diverged".

  Managers "a" and "b" are two machines of one fleet, as after replacing a
  machine. A stand-in for Litestream keeps the bucket in a directory.

  Rule: Without a bucket the state is local only and nothing is ever run

    Background:
      Given manager "a" has no bucket

    Scenario: The copy is the only one
      When manager "a" compares its copy with the bucket
      Then it reports "local-only"
      And Litestream was never started

    Scenario: A change is kept on the manager
      When manager "a" changes the configuration to "one"
      Then it reports "local-only"
      And the fleet state of manager "a" holds the configuration "one"
      And manager "a" has nothing waiting for the bucket
      And Litestream was never started

    Scenario: A push has nowhere to go
      Given manager "a" changed the configuration to "one"
      When manager "a" pushes its changes
      Then it reports "local-only"
      And Litestream was never started

  Rule: A change is uploaded, then read back from the bucket before it counts

    Background:
      Given managers "a" and "b" replicate to one bucket

    Scenario: A fleet nobody has written to is empty
      When manager "a" compares its copy with the bucket
      Then it reports "empty"

    Scenario: A change reaches the bucket
      When manager "a" changes the configuration to "one"
      Then it reports "in-sync"
      And manager "a" has nothing waiting for the bucket
      And manager "a" stands "in-sync" with the bucket

    Scenario: An upload that reports success but stored nothing is not believed
      Given manager "a" changed the configuration to "one"
      And the bucket reports uploads as stored without storing them
      When manager "a" changes the configuration to "two"
      Then it reports "unreachable"
      And manager "a" has changes waiting for the bucket

    Scenario: A change the bucket did not take leaves the copy ahead of it
      Given manager "a" changed the configuration to "one"
      And the bucket reported uploads as stored without storing them
      And manager "a" changed the configuration to "two"
      And the bucket stored uploads again
      When manager "a" compares its copy with the bucket
      Then it reports "local-ahead"

    Scenario: A push uploads what the bucket did not take
      Given manager "a" changed the configuration to "one"
      And the bucket reported uploads as stored without storing them
      And manager "a" changed the configuration to "two"
      And the bucket stored uploads again
      When manager "a" pushes its changes
      Then it reports "in-sync"

  Rule: A new manager restores the state and a stale one is replaced before it changes anything

    Background:
      Given managers "a" and "b" replicate to one bucket
      And manager "a" changed the configuration to "from a"

    Scenario: A manager that has never seen the fleet is behind the bucket
      When manager "b" compares its copy with the bucket
      Then it reports "bucket-ahead"

    Scenario: A new manager takes the bucket's version
      Local data is disposable; the bucket is the truth.
      When manager "b" refreshes its copy
      Then the refresh reports "in-sync" and a replaced copy
      And the fleet state of manager "b" holds the configuration "from a"

    Scenario: A copy that already matches the bucket is not replaced
      Given manager "b" refreshed its copy
      When manager "b" refreshes its copy
      Then the refresh reports "in-sync" and an unchanged copy

    Scenario: A manager that did not see another's change is behind the bucket
      Given manager "b" refreshed its copy
      And manager "b" changed the configuration to "from b"
      When manager "a" compares its copy with the bucket
      Then it reports "bucket-ahead"

    Scenario: A stale manager's next change starts from the bucket's version
      Given manager "b" refreshed its copy
      And manager "b" changed the configuration to "from b"
      When manager "a" changes the roster to "a roster"
      Then the change started from a copy that stood "in-sync"
      And the change started from the configuration "from b"
      And it reports "in-sync"

    Scenario: Each manager's change survives the other's
      Given manager "b" refreshed its copy
      And manager "b" changed the configuration to "from b"
      And manager "a" changed the roster to "a roster"
      When manager "b" refreshes its copy
      Then the fleet state of manager "b" holds the roster "a roster"
      And the fleet state of manager "b" holds the configuration "from b"

  Rule: An unreachable bucket does not stop a change, and the next command uploads it

    Background:
      Given managers "a" and "b" replicate to one bucket
      And manager "a" changed the configuration to "one"
      And the bucket stopped answering

    Scenario: The copy cannot be compared
      When manager "a" compares its copy with the bucket
      Then it reports "unreachable"

    Scenario: The change is made and waits
      When manager "a" changes the configuration to "two"
      Then it reports "unreachable"
      And the fleet state of manager "a" holds the configuration "two"
      And manager "a" has changes waiting for the bucket

    Scenario: Once the bucket answers, the copy is ahead of it
      Given manager "a" changed the configuration to "two"
      And the bucket answered again
      When manager "a" compares its copy with the bucket
      Then it reports "local-ahead"

    Scenario: A refresh never replaces a copy that has changes of its own
      Given manager "a" changed the configuration to "two"
      And the bucket answered again
      When manager "a" refreshes its copy
      Then the refresh reports "local-ahead" and an unchanged copy

    Scenario: The next change uploads both
      Given manager "a" changed the configuration to "two"
      And the bucket answered again
      When manager "a" changes the roster to "r"
      Then it reports "in-sync"
      And manager "a" has nothing waiting for the bucket

  Rule: Two managers that both changed the state diverge, and only the bucket wins

    Background:
      Given managers "a" and "b" replicate to one bucket
      And manager "a" changed the configuration to "base"
      And manager "b" refreshed its copy
      And the bucket stopped answering
      And manager "b" changed the configuration to "offline on b"
      And the bucket answered again
      And manager "a" changed the configuration to "online on a"

    Scenario Outline: The diverged manager <does this> and is told it diverged
      When manager "b" <does this>
      Then it reports "diverged"

      Examples:
        | does this                          |
        | compares its copy with the bucket  |
        | pushes its changes                 |
        | refreshes its copy                 |

    Scenario: The diverged manager changes nothing more
      When manager "b" changes the configuration to "more"
      Then it is refused with "fleet-state --restore --yes"
      And the fleet state of manager "b" holds the configuration "offline on b"

    Scenario: Nothing of the diverged manager reaches the bucket
      Given manager "b" tried to push its changes
      And manager "b" tried to change the configuration to "more"
      When manager "a" refreshes its copy
      Then the fleet state of manager "a" holds the configuration "online on a"

    Scenario: Restoring gives up the manager's own changes for the bucket's
      Given manager "b" tried to push its changes
      And manager "b" tried to change the configuration to "more"
      When manager "b" restores its copy from the bucket
      Then it reports "in-sync"
      And the fleet state of manager "b" holds the configuration "online on a"
      And manager "b" has nothing waiting for the bucket

  Rule: A copy that matched another bucket does not pass for this one

    Background:
      Given managers "a" and "b" replicate to one bucket
      And manager "a" changed the configuration to "one"

    Scenario: Pointed at an empty bucket, the copy is not yet published there
      The new bucket is empty: this copy seeds it rather than counting as
      already uploaded.
      When manager "a" is pointed at another bucket that holds nothing
      Then manager "a" has changes waiting for the bucket
      And manager "a" stands "unpublished" with the bucket

    Scenario: A push seeds the new bucket
      Given manager "a" was pointed at another bucket that holds nothing
      When manager "a" pushes its changes
      Then it reports "in-sync"
      And Litestream was started for the first bucket

  Rule: Downloads never outlive the command that made them

    Scenario: Comparing, refreshing and pushing leave nothing behind
      Given managers "a" and "b" replicate to one bucket
      And manager "a" changed the configuration to "one"
      And manager "b" compared its copy with the bucket
      And manager "b" refreshed its copy
      And manager "a" compared its copy with the bucket
      When manager "a" pushes its changes
      Then manager "a" keeps no download and no lock in its state directory
      And manager "b" keeps no download and no lock in its state directory

  Rule: The bucket credentials reach Litestream through its environment only

    Scenario: A change to an S3 bucket starts Litestream with the keys in its environment
      Given manager "a" replicates to the S3 bucket "fleet-state" at "https://s3.example.com" with the keys "AKIDEXAMPLE" and "secret/example+key"
      When manager "a" changes the configuration to "one"
      Then Litestream was started more than once
      And no Litestream command line contains "secret/example+key"
      And every Litestream command is "/pinned/litestream"
      And every Litestream command line carries "-no-expand-env"
      And every Litestream command has "AWS_SECRET_ACCESS_KEY" set to "secret/example+key" in its environment

  Rule: The pinned Litestream is installed by a change, never by the read-only comparison

    Background:
      Given manager "a" replicates to the bucket
      And the pinned Litestream is not installed where manager "a" runs

    Scenario: A comparison looks for Litestream and installs nothing
      When manager "a" compares its copy with the bucket
      Then it reports "unreachable"
      And only "mise which litestream" was run

    Scenario: A change installs it
      Given manager "a" compared its copy with the bucket
      When manager "a" changes the configuration to "one"
      Then "mise install litestream" was run
