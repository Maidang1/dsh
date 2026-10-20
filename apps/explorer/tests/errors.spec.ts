/** docs/01 §10: an error names the failed action, the reason, and what to do next. */
import { describe, expect, it } from 'vitest'
import { ApiError, NetworkError } from '../src/lib/api'
import { describeFailure } from '../src/lib/errors'

describe('error messages', () => {
  it.each([
    ['a busy runner', 'run', new ApiError(409, 'a run is already in progress'), '运行教学代码失败。原因：a run is already in progress。已有运行在进行'],
    ['a composition rejected by validation', 'run', new ApiError(400, 'tools requires systemPrompt'), '草稿没有通过组合校验'],
    ['a run imported twice', 'importRun', new ApiError(409, 'run r already exists'), '本仓库已有这次运行'],
    ['an import file that is not JSON', 'importRun', new SyntaxError('Unexpected token'), '不是有效的运行导出'],
    ['an expired session', 'saveDraft', new ApiError(401, 'open the launch URL'), '用终端打印的启动链接重新打开'],
    ['a lesson build older than the source', 'run', new ApiError(412, 'the source of stage x changed after the lesson build'), '在终端运行 pnpm lessons:build'],
    ['an unreachable service', 'openRun', new NetworkError('Failed to fetch'), 'pnpm explorer 仍在运行'],
    ['a bug in the page, not the service', 'openRun', new TypeError("Cannot read properties of undefined (reading 'seq')"), '页面内部出错'],
  ] as const)('%s', (_name, action, error, text) => {
    expect(describeFailure(action, error)).toContain(text)
  })
})
