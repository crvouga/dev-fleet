Feature: The disk GC removes only what a worker can rebuild
  Every hour a worker removes ignored build output and caches from checkouts
  nobody has used for a while. It never removes a tracked file, and it leaves
  alone a checkout that was used recently, holds a recent uncommitted edit or
  has a process running in it. These scenarios run the collector on a
  temporary home directory only, never on the machine's own Docker or apt
  cache.

  Background:
    Given a home directory with one checkout that ignores:
      | node_modules/ |
      | .cache/       |
    And the checkout holds these files, all committed except the ignored ones:
      | node_modules/pkg/index.js |
      | .cache/scratch/blob       |
      | dist/keep.js              |
      | src/main.ts               |

  Scenario: An idle checkout loses only ignored build output
    "dist" is tracked in this checkout, so it is source, not build output.
    Given the checkout was last used 30 days ago
    When the disk GC runs
    Then these are gone from the checkout:
      | node_modules |
      | .cache       |
    But these are still in the checkout:
      | dist/keep.js |
      | src/main.ts  |

  Scenario: A recently used checkout is left alone
    Given the checkout was last used 1 day ago
    When the disk GC runs
    Then these are still in the checkout:
      | node_modules |

  Scenario: A recent uncommitted edit keeps an otherwise idle checkout
    Given the checkout was last used 30 days ago
    But "src/main.ts" was edited just now and not committed
    When the disk GC runs
    Then these are still in the checkout:
      | node_modules |

  Scenario: A checkout a process is running in is left alone
    Given the checkout was last used 30 days ago
    But a process is running in "src" of the checkout
    When the disk GC runs
    Then these are still in the checkout:
      | node_modules |

  Scenario: A dry run reports without deleting
    Given the checkout was last used 30 days ago
    When the disk GC runs as a dry run
    Then these are still in the checkout:
      | node_modules |
    And it reports a removal marked as a dry run

  Scenario Outline: Pressure shortens the idle window to hours, when <short>
    A filesystem with free bytes and no free inodes fails every write as
    surely as a full one.
    Given the checkout was last used 1 day ago
    And the disk is <short>, where 12 hours without use is idle
    When the disk GC runs
    Then these are gone from the checkout:
      | node_modules |
    But these are still in the checkout:
      | src/main.ts |

    Examples:
      | short            |
      | under pressure   |
      | short of inodes  |
