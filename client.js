// dsh-her-qq-bridge-sl —— 客户端占位（设置面板在 her-kernel「角色 → 消息」）
// 数据路由：/qq-bridge/rules 等；本文件只保证 ModuleLoader 注册 id 与包名一致。
window.__ModuleLoader__.load({
  id: 'dsh-her-qq-bridge-sl',
  factory: () => ({
    inject: [],
    apply() { /* 面板已迁移至 her-kernel 角色面板 */ },
  }),
})
