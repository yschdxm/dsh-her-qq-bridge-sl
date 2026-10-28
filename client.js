// dsh-her-qq-bridge-sl —— 设置面板（已并入「小鲸 · 角色」面板的「消息」区）
// 渠道通知规则、使用注意 notes、出站分类器规则都在 her-kernel 的角色面板里编辑
// （数据路由不变：/qq-bridge/rules 与 /her-kernel/config）。本文件保留仅为模块占位。
window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory: () => ({
    inject: [],
    apply() { /* 面板已迁移至 her-kernel 角色面板 */ },
  }),
})
