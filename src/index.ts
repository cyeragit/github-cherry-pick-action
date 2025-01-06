import * as core from '@actions/core'
import * as io from '@actions/io'
import {spawnSync} from 'child_process'
import * as utils from './utils'
import * as github from '@actions/github'
import {Inputs, createPullRequest} from './github-helper'
import {PullRequest} from '@octokit/webhooks-definitions/schema'

const CHERRYPICK_EMPTY =
  'The previous cherry-pick is now empty, possibly due to conflict resolution.'

const CHERRYPICK_CONFLICT = 'CONFLICT (content): Merge conflict'

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
      (result.stderr.includes(CHERRYPICK_CONFLICT) ||
        result.stdout.includes(CHERRYPICK_CONFLICT))
    ) {
      await gitExecution(['add', '*'])
      await gitExecution(['commit', '-m', 'Cherry picking with conflicts'])
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
