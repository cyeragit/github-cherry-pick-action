import * as core from '@actions/core'
import {run} from '../src/index'
import {createPullRequest} from '../src/github-helper'
import {PullRequest} from '@octokit/webhooks-definitions/schema'

const defaultMockedGetInputData: any = {
  token: 'whatever',
  author: 'Me <me@mail.com>',
  committer: 'Someone <someone@mail.com>',
  branch: 'target-branch',
  'cherry-pick-branch': ''
}

const mockedCreatePullRequestOutputData: any = {
  data: {number: 54, html_url: 'https://github.com/o/r/pull/54'}
}

let mockedGetInputData: any = defaultMockedGetInputData

// default mock
jest.mock('@actions/core', () => {
  return {
    info: jest.fn(),
    warning: jest.fn(),
    setFailed: jest.fn().mockImplementation(msg => {
      throw new Error(msg)
    }),
    startGroup: jest.fn(),
    endGroup: jest.fn(),
    getInput: jest.fn().mockImplementation((name: string) => {
      return name in mockedGetInputData ? mockedGetInputData[name] : ''
    }),
    setOutput: jest.fn()
  }
})

jest.mock('@actions/io', () => {
  return {which: jest.fn().mockResolvedValue('/usr/bin/git')}
})

// The action shells out through spawnSync. Each test scripts git's answers by subcommand; anything
// not scripted succeeds silently, which is what config/fetch/checkout/push do in the real thing.
type GitReply = {status?: number; stdout?: string; stderr?: string}
let gitReplies: {[subcommand: string]: GitReply} = {}
const gitCalls: string[][] = []

jest.mock('child_process', () => {
  return {
    spawnSync: jest.fn().mockImplementation((_bin: string, args: string[]) => {
      gitCalls.push(args)
      const reply: GitReply = gitReplies[args[0]] ?? {}
      return {
        status: reply.status ?? 0,
        stdout: Buffer.from(reply.stdout ?? ''),
        stderr: Buffer.from(reply.stderr ?? '')
      }
    })
  }
})

jest.mock('@actions/github', () => {
  return {
    context: {
      payload: {
        pull_request: {
          merge_commit_sha: 'XXXXXX'
        } as PullRequest
      }
    }
  }
})

jest.mock('../src/github-helper', () => {
  return {
    createPullRequest: jest.fn().mockImplementation(() => {
      return mockedCreatePullRequestOutputData
    })
  }
})

const gitCallsFor = (subcommand: string): string[][] =>
  gitCalls.filter(args => args[0] === subcommand)

const outputs = (): {[name: string]: string} =>
  Object.fromEntries(
    (core.setOutput as jest.Mock).mock.calls.map(([name, value]) => [
      name,
      String(value)
    ])
  )

describe('run main', () => {
  beforeEach(() => {
    mockedGetInputData = {...defaultMockedGetInputData}
    gitReplies = {}
    gitCalls.length = 0
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  const expectPullRequestOpened = (
    targetBranch: string,
    cherryPickBranch: string
  ) => {
    expect(gitCallsFor('checkout')).toEqual([
      ['checkout', '-b', cherryPickBranch, `origin/${targetBranch}`]
    ])
    expect(gitCallsFor('cherry-pick')).toEqual([
      [
        'cherry-pick',
        '-X',
        'no-renames',
        '-m',
        '1',
        '--strategy=recursive',
        'XXXXXX'
      ]
    ])
    expect(gitCallsFor('push')).toEqual([
      ['push', '-u', 'origin', cherryPickBranch]
    ])
    expect(createPullRequest).toBeCalledTimes(1)
    expect(outputs().number).toEqual('54')
  }

  test('valid execution with default new branch', async () => {
    await run()

    expectPullRequestOpened('target-branch', 'cherry-pick-target-branch-XXXXXX')

    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        author: 'Me <me@mail.com>',
        committer: 'Someone <someone@mail.com>',
        branch: 'target-branch',
        title: '',
        body: '',
        labels: [],
        reviewers: [],
        cherryPickBranch: ''
      }),
      'cherry-pick-target-branch-XXXXXX'
    )
  })

  test('valid execution with customized branch', async () => {
    mockedGetInputData['cherry-pick-branch'] = 'my-custom-branch'

    await run()

    expectPullRequestOpened('target-branch', 'my-custom-branch')

    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({cherryPickBranch: 'my-custom-branch'}),
      'my-custom-branch'
    )
  })

  test('valid execution with pr overrides', async () => {
    mockedGetInputData['cherry-pick-branch'] = 'my-custom-branch'
    mockedGetInputData['title'] = 'new title'
    mockedGetInputData['body'] = 'new body'
    mockedGetInputData['labels'] = 'label1,label2'
    mockedGetInputData['reviewers'] = 'user1,user2,user3'

    await run()

    expectPullRequestOpened('target-branch', 'my-custom-branch')

    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'new title',
        body: 'new body',
        labels: ['label1', 'label2'],
        reviewers: ['user1', 'user2', 'user3'],
        cherryPickBranch: 'my-custom-branch'
      }),
      'my-custom-branch'
    )
  })

  test('force pushes when asked', async () => {
    mockedGetInputData['force'] = 'true'

    await run()

    expect(gitCallsFor('push')).toEqual([
      ['push', '-u', 'origin', 'cherry-pick-target-branch-XXXXXX', '--force']
    ])
  })

  test('a conflicting pick is committed as-is and opens a conflict PR', async () => {
    gitReplies['cherry-pick'] = {
      status: 1,
      stdout: 'CONFLICT (content): Merge conflict in a.ts\n'
    }

    await run()

    expect(gitCallsFor('add')).toEqual([['add', '-A']])
    expect(gitCallsFor('commit')).toEqual([
      ['commit', '-m', 'Cherry picking with conflicts']
    ])
    expect(createPullRequest).toBeCalledTimes(1)
    expect(outputs().does_pr_have_conflicts).toEqual('true')
  })

  test('a modify/delete conflict on stderr is treated the same way', async () => {
    gitReplies['cherry-pick'] = {
      status: 1,
      stderr: 'CONFLICT (modify/delete): b.ts deleted in HEAD\n'
    }

    await run()

    expect(createPullRequest).toBeCalledTimes(1)
    expect(outputs().does_pr_have_conflicts).toEqual('true')
  })

  test('an empty pick means the change is already on the target: skip, no push, no PR', async () => {
    gitReplies['cherry-pick'] = {
      status: 1,
      stderr:
        'The previous cherry-pick is now empty, possibly due to conflict resolution.\n'
    }

    await run()

    expect(gitCallsFor('cherry-pick').map(args => args[1])).toEqual([
      '-X',
      '--skip'
    ])
    expect(gitCallsFor('push')).toEqual([])
    expect(createPullRequest).not.toBeCalled()
    expect(outputs().number).toBeUndefined()
    expect(core.setFailed).not.toBeCalled()
  })

  test('any other cherry-pick error fails the action', async () => {
    gitReplies['cherry-pick'] = {
      status: 128,
      stderr: 'fatal: bad object XXXXXX\n'
    }

    await expect(run()).rejects.toThrow(
      'Unexpected error: fatal: bad object XXXXXX'
    )
    expect(createPullRequest).not.toBeCalled()
  })
})
