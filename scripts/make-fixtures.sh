#!/bin/sh
# Build the checkouts the mock harness lists.
#
# The session list's middle level is read from git — the working tree a session's
# directory sits in, and the branch checked out there — so exercising it needs
# real repositories rather than a table of pretend answers. Three projects, each
# with a second *linked* worktree (`git worktree add`), because that is the shape
# the feature exists for: one repository, two directories, two branches.
#
#   sh scripts/make-fixtures.sh    then: npm run mock
#
# Safe to re-run: the tree is rebuilt from scratch. Everything lands in
# .fixtures/, which is git-ignored.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixtures="$root/.fixtures"

rm -rf "$fixtures"
mkdir -p "$fixtures"
cd "$fixtures"

# Identity for the fixture commits only; never touches the caller's config.
export GIT_AUTHOR_NAME=fixtures GIT_AUTHOR_EMAIL=fixtures@example.invalid
export GIT_COMMITTER_NAME=fixtures GIT_COMMITTER_EMAIL=fixtures@example.invalid

# A repository with one commit, on a named starting branch.
# One project: a directory holding a bare repository and a worktree directory
# per branch, each named after the branch it holds. This mirrors the layout on
# the real box (`language-boss-and-choc/` holding `language-boss` bare plus
# `develop/`, `student-error-insights/`, …), which matters because the session
# list names a worktree after its directory — so the fixtures must be built the
# way the real checkouts are, or they would prove the wrong thing.
#
#   project <name> <branch>...
project() {
  name=$1
  shift
  mkdir -p "$name"
  git init -q --bare "$name/$name.git"

  # A first commit has to come from somewhere: a scratch clone, removed after.
  git clone -q "$name/$name.git" "$name/.seed" 2>/dev/null
  (
    cd "$name/.seed"
    echo "$name" > README.md
    git add README.md
    git commit -qm 'Initial commit'
    git branch -M "$1"
    git push -q origin "$1"
  )
  rm -rf "$name/.seed"

  # The first branch already exists (the seed pushed it), so its worktree checks
  # it out; every later one is created by the worktree that will hold it.
  first=$1
  for branch in "$@"; do
    if [ "$branch" = "$first" ]; then
      git -C "$name/$name.git" worktree add -q "../$branch" "$branch"
    else
      git -C "$name/$name.git" worktree add -q -b "$branch" "../$branch" "$first"
    fi
  done
}

# Branch names carry no slash, matching the real box: a worktree directory is
# named after its branch, and `feature/x` would nest a directory rather than
# name one.
# Four checkouts, because the session list shuts a worktree only where a
# workspace has more than three of them — the crowding rule needs a workspace
# that actually crowds. The real box runs eight.
project language-boss-and-choc develop pre-term-sign-in student-error-insights lesson-resource-attachments
project dsh-mobile-web-gui main session-list-view
# `haptic-feedback` deliberately gets no session: an empty checkout must still
# show its heading, because the list describes the project rather than only the
# work that happens to have started.
project my-android-keyboard main swipe-typing haptic-feedback

echo "Fixtures ready in $fixtures"
for name in language-boss-and-choc dsh-mobile-web-gui my-android-keyboard; do
  git -C "$name/$name.git" worktree list
done
