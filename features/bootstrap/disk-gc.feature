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

  Rule: Stores that only grow are kept under the limits of the Ubuntu policy

    Scenario Outline: An agent worktree last used <days> days ago with <work> is <verdict>
      A worktree goes only when Git can vouch for everything in it: nothing
      uncommitted or untracked, and every commit on a remote. Its branch is
      kept either way.
      Given the checkout has a remote that holds its commits
      And an agent worktree "fix-login" of the checkout under ".t3/worktrees/project" with <work>
      And the worktree was last used <days> days ago
      When the disk GC runs with these limits:
        | --worktree-root      | .t3/worktrees |
        | --worktree-idle-days | 30            |
      Then the worktree is <verdict>

      Examples:
        | days | work                     | verdict |
        | 40   | nothing unsaved          | removed |
        | 10   | nothing unsaved          | kept    |
        | 40   | a commit no remote holds | kept    |
        | 40   | an uncommitted edit      | kept    |
        | 40   | an untracked file        | kept    |
        | 40   | a process running in it  | kept    |

    Scenario: A cache past its cap loses its oldest files until it fits
      Given the cache ".bun/install/cache" holds 6 files of 1 MiB, written an hour apart
      When the disk GC runs with these limits:
        | --cache-cap | .bun/install/cache=3 |
      Then the cache ".bun/install/cache" holds 3 MiB or less
      And the newest file of the cache is still there
      And the run reports at least 3 MiB reclaimed

    Scenario: Only the current and the previous downloaded T3 package are kept
      Given the directory "packages" holds these downloads, oldest first:
        | t3-1.deb |
        | t3-2.deb |
        | t3-3.deb |
        | t3-4.deb |
      When the disk GC runs with these limits:
        | --keep-newest | packages=2 |
      Then the directory "packages" holds exactly:
        | t3-3.deb |
        | t3-4.deb |

    Scenario: A worker with containers prunes Docker's old images and build cache
      This is a dry run, so nothing is pruned.
      When the disk GC dry-runs on the whole machine, with a docker command on its path
      Then the run would prune these Docker steps:
        | docker_images      |
        | docker_build_cache |

    Scenario: A worker without containers has no Docker to prune
      A worker whose containers feature is off is given --no-docker.
      When the disk GC dry-runs on the whole machine without containers, with a docker command on its path
      Then the run would prune these Docker steps:
        | (none) |

    Scenario: Tool versions no configuration uses are pruned by mise
      Given a stand-in for mise that records how it is run
      When the disk GC runs with the stand-in for mise
      Then the stand-in for mise was run with "prune --yes"
