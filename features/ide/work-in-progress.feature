Feature: A lost worker loses at most one interval of work in progress
  Workers are disposable, so the work in their agent worktrees is pushed on a
  timer to a recovery ref of each worktree's own remote. The worktree, its
  index and its branches are never touched.

  Background:
    Given an agent worktree on the branch "feature" whose remote holds its first commit

  @posix
  Scenario: Changed and new files are saved to the recovery ref of the worker
    Given the worktree has a changed file "README.md" and a new file "notes.txt"
    When the work-in-progress guard runs for the worker "worker-one"
    Then the remote holds "refs/recovery/worker-one/feature"
    And that ref holds "README.md" as changed and "notes.txt"
    And the worktree still shows "README.md" as changed and "notes.txt" as new
    And the branch "feature" did not move

  @posix
  Scenario: A worktree whose work is already on its remote pushes nothing
    When the work-in-progress guard runs for the worker "worker-one"
    Then the remote holds no recovery ref

  @posix
  Scenario: Committed work that was never pushed is saved
    Given the worktree has a commit that was never pushed
    When the work-in-progress guard runs for the worker "worker-one"
    Then the remote holds "refs/recovery/worker-one/feature" at the branch "feature"

  Scenario: The guard is a timer of every worker, declared in its role
    When the worker recovery tasks are read
    Then they install the timer "personal-worker-wip-guard.timer" that runs "ansible/ubuntu/wip-guard.py" every "15min"
