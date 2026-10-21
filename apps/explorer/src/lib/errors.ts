/**
 * Error messages name the action that failed, the reason the server gave,
 * and something the learner can do next (docs/01 §10).
 */
import { ApiError, NetworkError } from './api'

const ACTIONS = {
  load: '加载实验台',
  openRun: '打开运行',
  compareRun: '载入对照运行',
  saveDraft: '保存草稿',
  run: '运行教学代码',
  runStage: '运行课程阶段',
  progress: '保存学习进度',
  deleteRun: '删除运行',
  pinRun: '更改保留设置',
  importRun: '导入运行',
  cancel: '取消运行',
  searchPackages: '搜索 npm 包',
  installPackage: '安装 npm 包',
  uninstallPackage: '卸载 npm 包',
} as const

export type FailedAction = keyof typeof ACTIONS

function recovery(action: FailedAction, status: number | 'page' | null): string {
  if (status === 'page') return '页面内部出错：刷新页面后重试，本地服务与运行记录不受影响。'
  if (status === null) return '本地服务没有响应：确认终端里的 pnpm explorer 仍在运行，然后刷新页面。'
  if (status === 401 || status === 403) return '会话无效：用终端打印的启动链接重新打开页面。'
  if (status === 409) {
    if (action === 'importRun') return '本仓库已有这次运行，不需要再导入。'
    if (action === 'cancel') return '运行已经结束或尚未开始，无需取消。'
    return '已有运行在进行：等它结束或取消后再试。'
  }
  if (status === 400) {
    if (action === 'run' || action === 'runStage') return '草稿没有通过组合校验：按原因修改组合（依赖、阶段、作用域）后重试。'
    if (action === 'importRun') return '文件不是有效的运行导出，或内容被修改过：从原仓库重新导出后再导入。'
    return '请求内容无效：刷新页面后重试。'
  }
  if (status === 404) return '对象已不存在：刷新页面更新列表。'
  if (status === 412) return '课程构建已过期：在终端运行 pnpm lessons:build，再重启 pnpm explorer。'
  if (status === 413) return '文件过大：导入文件上限为 32 MB。'
  return '本地服务内部错误：查看终端输出的详细信息后重试。'
}

export function describeFailure(action: FailedAction, error: unknown): string {
  // Responses that are not JSON arrive as ApiError, so a SyntaxError here comes from reading an import file.
  const status = error instanceof ApiError ? error.status
    : error instanceof NetworkError ? null
      : action === 'importRun' && error instanceof SyntaxError ? 400 : 'page'
  const reason = error instanceof Error ? error.message : String(error)
  return `${ACTIONS[action]}失败。原因：${reason}。${recovery(action, status)}`
}
