# 给 Agent 的工作看板配置说明

使用同目录 `kanban.schema.json` 的 v1 结构生成 JSON。示例见 `weekly-routine.json`。

- id 是稳定标识：修改原事项时保留，新建时使用不同 id。
- 不设置项目时省略 project_id 或填 null。实际项目 id 可在应用项目详情查看。
- time 是北京时间的 HH:mm。popup 为 true 必须提供 time。
- 周期频率支持 daily、weekdays 和 weekly；weekly 的 weekdays 使用 1 至 7 表示周一至周日。
- 单次最多 500 条。请生成完整配置，省略可选字段表示清空或恢复默认值。
- 不要生成代码、外部命令、公开分享设置、完成状态或历史记录。
- 导入不会执行脚本，也不会调用模型或网络服务。

Schema 无法表达全部跨字段业务规则，以应用校验和变更预览为准。
