# Effective Flow project setup

## Status

Active

## Context

This ADR holds this project's tracked Effective Flow configuration. `.effective-flow/` is a pure
runtime directory and completely gitignored.

## Configuration

| Key                                  | Value                      |
| ------------------------------------ | -------------------------- |
| review.profile                       | focused                    |
| review.autoConfirmScope              | true                       |
| review.designDecisionSources         | standard                   |
| review.validation                    | full                       |
| applyReview.defaultCommitStrategy    | worktrees                  |
| applyReview.finalValidation          | full                       |
| applyReview.stashPolicy              | interactive                |
| applyReview.worktree.baseDir         | .effective-flow/.worktrees |
| applyReview.worktree.setup           | auto                       |
| worktree.enabled                     | true                       |
| delivery.completion                  | pr                         |
| delivery.baseBranch                  | origin/main                |
| delivery.prReview                    | always                     |
| mergeGate.completion                 | merge                      |
| mergeGate.bots                       | greptile-apps              |
| mergeGate.bots.greptile-apps.trigger | @greptileai                |
| mergeGate.bots.greptile-apps.check   | Greptile Review            |
| tracker.mode                         | remote                     |
| plan.dir                             | docs/plan                  |
| concept.dir                          | docs/concept               |
| language.project                     | en                         |
