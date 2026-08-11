# Contributing to GPTTool

感谢参与。GPTTool 接受修复、兼容性适配、测试、文档和可访问性改进。

## 开发流程

1. 先搜索现有 Issue，并为较大改动创建行为层面的提案；
2. 从独立分支开发，保持提交范围单一；
3. 不复制类似项目的实现，遵守 [洁净室规则](docs/CLEAN_ROOM_POLICY.zh-CN.md)；
4. 新依赖必须说明版本、用途和许可证；
5. 提交前运行：

```bash
npm ci
npm run check
npm test
npm run build
```

## PR 必须说明

- 问题与用户可见结果；
- 实现和兼容性影响；
- 测试证据；
- 是否涉及数据库、协议、安全、第三方代码或素材；
- UI 改动的脱敏截图。

## 许可证

提交即表示你有权提供该贡献，并同意贡献在项目当前的 PolyForm Noncommercial 1.0.0 下发布。你仍保留自己贡献的版权；项目保留许可证要求的版权与 Required Notice。
