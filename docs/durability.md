# What survives the loss of a machine

This is the one place that says what dev-fleet keeps when a machine is lost.

| Lost        | Kept                                                                                                                                                                                                                                                                      | Lost with it                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A worker    | Everything `fleet-sync` rebuilds from Git and secrets. Work in agent worktrees (`~/.t3/worktrees`) up to the last run of the work-in-progress guard, every 15 minutes, in `refs/recovery/<node>/<branch>` of each worktree's remote. The T3 environment ID in the roster. | Up to 15 minutes of uncommitted work; T3 threads and their transcripts on that worker.                   |
| The manager | The fleet state, from the bucket ([state](state.md)). The T3 profile, provider instances and policy, from `fleet.json` and Git.                                                                                                                                           | T3's own data on the manager: its linked environments and its threads. They are not in a backup set yet. |

## Recovering work from a lost worker

The guard pushes the files of each worktree as they were (changed and new
files, not ignored ones) as one commit on top of its `HEAD`, without touching
the worktree, its index or its branches:

```sh
git fetch origin 'refs/recovery/*:refs/recovery/*'
git log refs/recovery/<node>/<branch>
git switch -c recovered refs/recovery/<node>/<branch>
```

A worktree whose work is already on a branch of its remote pushes nothing.
The guard is `ansible/ubuntu/wip-guard.py`, run by the user timer
`personal-worker-wip-guard.timer` that `ansible/ubuntu/tasks/recovery.yml`
installs. It pushes with the worker's own Git credentials, so a worktree
whose remote the worker cannot write to is reported and skipped.
