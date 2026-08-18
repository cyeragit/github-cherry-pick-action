import * as core from '@actions/core'
import * as io from '@actions/io'
import {spawnSync} from 'child_process'
import * as utils from './utils'
import * as github from '@actions/github'
import {Inputs, createPullRequest} from './github-helper'
import {PullRequest} from '@octokit/webhooks-definitions/schema'

const CHERRYPICK_EMPTY =
  'The previous cherry-pick is now empty, possibly due to conflict resolution.'

// Matches any git cherry-pick conflict marker, e.g.:
//   CONFLICT (content): Merge conflict in ...
//   CONFLICT (modify/delete): ... deleted in HEAD and modified in ...
//   CONFLICT (rename/delete): ...
//   CONFLICT (add/add): ...
const CHERRYPICK_CONFLICT = /^CONFLICT \(/m

// Lockfiles are fully-generated files: their whole-file churn produces textual
// cherry-pick conflicts on unrelated dependency lines whenever the source commit
// lags the target branch, even when the real change is conflict-free. When the
// ONLY conflicted files are lockfiles AND the picked commit changed no package.json
// (so no dependency actually moved), the target branch's lockfile is authoritative
// and we can resolve by keeping it (`--ours`) instead of surfacing a conflict.
const LOCKFILE_BASENAMES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']

const basename = (p: string): string => p.split('/').pop() ?? p

const splitLines = (s: string): string[] =>
  s
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

export async function run(): Promise<void> {
  try {
    const inputs: Inputs = {
      token: core.getInput('token'),
      committer: core.getInput('committer'),
      author: core.getInput('author'),
      branch: core.getInput('branch'),
      title: core.getInput('title'),
      body: core.getInput('body'),
      force: utils.getInputAsBoolean('force'),
      labels: utils.getInputAsArray('labels'),
      inherit_labels: utils.getInputAsBoolean('inherit_labels'),
      assignees: utils.getInputAsArray('assignees'),
      reviewers: utils.getInputAsArray('reviewers'),
      teamReviewers: utils.getInputAsArray('teamReviewers'),
      cherryPickBranch: core.getInput('cherry-pick-branch')
    }

    core.info(`Cherry pick into branch ${inputs.branch}!`)

    // the value of merge_commit_sha changes depending on the status of the pull request
    // see https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request
    const githubSha = (github.context.payload.pull_request as PullRequest)
      .merge_commit_sha
    const prBranch = inputs.cherryPickBranch
      ? inputs.cherryPickBranch
      : `cherry-pick-${inputs.branch}-${githubSha}`

    // Configure the committer and author
    core.startGroup('Configuring the committer and author')
    const parsedAuthor = utils.parseDisplayNameEmail(inputs.author)
    const parsedCommitter = utils.parseDisplayNameEmail(inputs.committer)
    core.info(
      `Configured git committer as '${parsedCommitter.name} <${parsedCommitter.email}>'`
    )
    await gitExecution(['config', '--global', 'user.name', parsedAuthor.name])
    await gitExecution([
      'config',
      '--global',
      'user.email',
      parsedCommitter.email
    ])
    core.endGroup()

    // Update  branchs
    core.startGroup('Fetch all branchs')
    await gitExecution(['remote', 'update'])
    await gitExecution(['fetch', '--all'])
    core.endGroup()

    // Create branch new branch
    core.startGroup(`Create new branch ${prBranch} from ${inputs.branch}`)
    await gitExecution(['checkout', '-b', prBranch, `origin/${inputs.branch}`])
    core.endGroup()

    // Cherry pick
    core.startGroup('Cherry picking')

    const result = await gitExecution([
      'cherry-pick',
      '-X',
      'no-renames',
      '-m',
      '1',
      '--strategy=recursive',
      `${githubSha}`
    ])

    core.info(`Cherry pick finished with exit code ${result.exitCode}`)
    core.info(`Cherry pick stdout: ${result.stdout}`)
    core.info(`Cherry pick stderr: ${result.stderr}`)

    if (
      result.exitCode !== 0 &&
      (CHERRYPICK_CONFLICT.test(result.stderr) ||
        CHERRYPICK_CONFLICT.test(result.stdout))
    ) {
      const lockfileResolved = await tryResolveLockfileOnlyConflicts(githubSha)
      if (lockfileResolved) {
        core.info(
          'Resolved lockfile-only conflicts by keeping the target branch lockfile; no manual resolution needed.'
        )
      } else {
        await gitExecution(['add', '-A'])
        await gitExecution(['commit', '-m', 'Cherry picking with conflicts'])
        core.setOutput('does_pr_have_conflicts', 'true')
      }
    } else if (
      result.exitCode !== 0 &&
      !result.stderr.includes(CHERRYPICK_EMPTY)
    ) {
      throw new Error(`Unexpected error: ${result.stderr}`)
    }

    core.endGroup()

    // Push new branch
    core.startGroup('Push new branch to remote')
    if (inputs.force) {
      await gitExecution(['push', '-u', 'origin', `${prBranch}`, '--force'])
    } else {
      await gitExecution(['push', '-u', 'origin', `${prBranch}`])
    }
    core.endGroup()

    // Create pull request
    core.startGroup('Opening pull request')
    const pull = await createPullRequest(inputs, prBranch)
    core.setOutput('data', JSON.stringify(pull.data))
    core.setOutput('number', pull.data.number)
    core.setOutput('html_url', pull.data.html_url)
    core.endGroup()
  } catch (err: unknown) {
    if (err instanceof Error) {
      core.setFailed(err)
    }
  }
}

// Attempt to resolve a conflicted cherry-pick when the conflicts are confined to
// generated lockfiles. Safe only when the picked commit changed no package.json:
// in that case no dependency actually moved, the target branch's lockfile is the
// source of truth, and keeping it (`--ours`) yields a lockfile consistent with the
// merged package.json set. Any non-lockfile conflict, or a package.json change,
// bails out to the normal "commit with conflicts" path for a human to resolve.
// Returns true iff the cherry-pick was fully resolved and committed here.
async function tryResolveLockfileOnlyConflicts(
  pickedSha: string | null
): Promise<boolean> {
  if (!pickedSha) {
    return false
  }
  const unmerged = splitLines(
    (await gitExecution(['diff', '--name-only', '--diff-filter=U'])).stdout
  )
  if (unmerged.length === 0) {
    return false
  }
  if (!unmerged.every(file => LOCKFILE_BASENAMES.includes(basename(file)))) {
    return false
  }

  // Files the picked commit itself changed (its first-parent diff, matching the
  // `-m 1` mainline used for the cherry-pick). A package.json change means deps
  // moved and the lockfile must be regenerated, which this git-only path cannot do.
  const changedByPick = splitLines(
    (await gitExecution(['diff', '--name-only', `${pickedSha}^1`, pickedSha]))
      .stdout
  )
  if (changedByPick.some(file => basename(file) === 'package.json')) {
    return false
  }

  // Keep the target branch copy of each conflicted lockfile.
  for (const file of unmerged) {
    const checkout = await gitExecution(['checkout', '--ours', '--', file])
    if (checkout.exitCode !== 0) {
      return false
    }
    const add = await gitExecution(['add', '--', file])
    if (add.exitCode !== 0) {
      return false
    }
  }

  // If discarding the lockfile delta leaves the index identical to HEAD, the pick
  // only touched lockfiles and is now empty — skip it instead of committing an empty
  // change (mirrors git's own "cherry-pick is now empty" handling).
  const hasStagedChanges =
    (await gitExecution(['diff', '--cached', '--quiet', 'HEAD'])).exitCode !== 0
  if (!hasStagedChanges) {
    const skip = await gitExecution(['cherry-pick', '--skip'])
    return skip.exitCode === 0
  }

  // Finalize the cherry-pick, reusing the original commit message. `core.editor=true`
  // makes `--continue` accept the prepared message non-interactively.
  const cont = await gitExecution([
    '-c',
    'core.editor=true',
    'cherry-pick',
    '--continue'
  ])
  return cont.exitCode === 0
}

async function gitExecution(params: string[]): Promise<GitOutput> {
  const gitPath = await io.which('git', true)
  const {stdout, stderr, status} = spawnSync(gitPath, params)

  return {
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    exitCode: status ?? 0
  }
}

class GitOutput {
  stdout = ''
  stderr = ''
  exitCode = 0
}

// do not run if imported as module
if (require.main === module) {
  run()
}
